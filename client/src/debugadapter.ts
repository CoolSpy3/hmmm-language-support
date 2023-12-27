// Modified from: https://github.com/microsoft/vscode-mock-debug/blob/668fa6f5db95dbb76825d4eb670ab0d305050c3b/src/mockDebug.ts

import {
	BreakpointEvent,
	DebugSession,
	ErrorDestination,
	Handles,
	InitializedEvent,
	InvalidatedEvent,
	OutputEvent,
	Source,
	StoppedEvent,
	TerminatedEvent,
	Thread
} from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { basename } from 'path';
import { workspace } from 'vscode';
import { binaryRegex, decompileInstruction } from '../../hmmm-spec/out/hmmm';
import { HMMMRuntime } from './runtime';

import { relative } from 'path';

/**
 * This interface describes the hmmm-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the program to debug. */
	program: string;
	isBinary: boolean;
}

export function sliceWithCount<T>(array: T[], start?: number, count?: number): T[] {
	return array.slice(start, (start ?? 0) + (count ?? array.length));
}

/// https://stackoverflow.com/a/14438954
export function removeDuplicates<T>(value: T, index: number, array: T[]): boolean {
	return array.indexOf(value) === index;
}

export class HMMMDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

	private _configurationDone: ((value: void | PromiseLike<void>) => void) | undefined = undefined;
	private _source: Source | undefined = undefined;

	private _runtime: HMMMRuntime;
	private _variableHandles = new Handles<string>();

	/**
	 * Creates a new debug adapter that is used for one debug session.
	 * We configure the default implementation of a debug adapter here.
	 */
	public constructor() {
		super();

		// this debugger uses zero-based lines and columns
		this.setDebuggerLinesStartAt1(false);
		this.setDebuggerColumnsStartAt1(false);

		this._runtime = new HMMMRuntime();

		// setup event handlers
		this._runtime.on('stop', (event: string) => {
			this.sendEvent(new StoppedEvent(event, HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', (event: string, breakpointIds: number | number[]) => {
			const e: DebugProtocol.StoppedEvent = new StoppedEvent(event, HMMMDebugSession.THREAD_ID);
			e.body.hitBreakpointIds = Array.isArray(breakpointIds) ? breakpointIds : [ breakpointIds ];
			this.sendEvent(e);
		});
		this._runtime.on('breakpointValidated', (bp: DebugProtocol.Breakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', bp));
		});
		this._runtime.on('debuggerOutput', (text) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			this.sendEvent(e);
		});
		this._runtime.on('output', (text, type, line) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.category = type;
			e.body.source = line ? this._source : undefined;
			e.body.line = line ? this.convertDebuggerLineToClient(line) : undefined;
			this.sendEvent(e);
		});
		this._runtime.on('end', () => {
			this.sendEvent(new TerminatedEvent());
		});
	}

	/**
	 * The 'initialize' request is the first request called by the frontend
	 * to interrogate the features the debug adapter provides.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, args: DebugProtocol.InitializeRequestArguments): void {
		const debuggingSettings = workspace.getConfiguration("hmmm.debugging");

		// build and return the capabilities of this debug adapter:
		response.body = response.body || {};

		// Adapter Capabilities
		response.body.supportsConfigurationDoneRequest = true;

		// Execution Capabilities
		response.body.supportsGotoTargetsRequest = true;
		response.body.supportsStepBack = debuggingSettings.get("enableReverseExecution", false);

		// Breakpoint Capabilities
		response.body.supportsDataBreakpoints = true;

		// Stack/Variable Capabilities
		response.body.supportsDelayedStackTraceLoading = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsRestartFrame = true;
		response.body.supportsSetVariable = true;
		response.body.supportsValueFormattingOptions = true;

		// Exception Capabilities
		response.body.exceptionBreakpointFilters = [
			{
				filter: "invalid-instruction",
				label: "Invalid Instruction",
				default: true,
				description: "Breaks if the program attempts to execute a memory address that does not contain a valid instruction."
			},
			{
				filter: "invalid-memory-access",
				label: "Invalid Memory Access",
				default: true,
				description: "Breaks if the program attempts to access a memory address that does not exist."
			},
			{
				filter: "instruction-read",
				label: "Instruction Read",
				default: false,
				description: "Breaks if the program attempts to read from an address inside the code segment."
			},
			{
				filter: "instruction-write",
				label: "Instruction Write",
				default: true,
				description: "Breaks if the program attempts to overwrite an instruction in memory."
			},
			{
				filter: "execute-outside-cs",
				label: "Execute Outside Code Segment",
				default: true,
				description: "Breaks if the program attempts to execute an instruction outside of the code segment."
			}
		];
		response.body.supportsExceptionInfoRequest = true;

		this.sendResponse(response);
	}

	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, args: DebugProtocol.ConfigurationDoneArguments): void {
		this._configurationDone?.();

		this.sendResponse(response);
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		const program = this.convertClientPathToDebugger(args.program);

		this._source = this.createSource(program);

		if(!this._runtime.configure(program, args.isBinary ? "hb" : "hmmm")) {
			this.sendErrorResponse(response, 1, "Program contains errors! Please fix them before debugging.", undefined, ErrorDestination.User);
			return;
		}

		this.sendResponse(response);

		const resolveOnConfigurationDone = new Promise<void>(resolve => this._configurationDone = resolve);

		this.sendEvent(new InitializedEvent());

		await Promise.race([
			resolveOnConfigurationDone,
			new Promise<void>(resolve => setTimeout(resolve, 1000)) // https://stackoverflow.com/a/51939030
		]);

		// start the program in the runtime
		this._runtime.continue();
	}

	protected continueRequest(response: DebugProtocol.ContinueResponse, args: DebugProtocol.ContinueArguments): void {
		this._variableHandles.reset();
		this._runtime.continue();
		this.sendResponse(response);
	}

	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, args: DebugProtocol.ReverseContinueArguments) : void {
		this._variableHandles.reset();
		this._runtime.continue(true);
		this.sendResponse(response);
 	}

	protected nextRequest(response: DebugProtocol.NextResponse, args: DebugProtocol.NextArguments): void {
		this._variableHandles.reset();
		this._runtime.step();
		this.sendResponse(response);
	}

	protected stepBackRequest(response: DebugProtocol.StepBackResponse, args: DebugProtocol.StepBackArguments): void {
		this._variableHandles.reset();
		this._runtime.step(true);
		this.sendResponse(response);
	}

	protected stepInRequest(response: DebugProtocol.StepInResponse, args: DebugProtocol.StepInArguments): void {
		this._variableHandles.reset();
		this._runtime.step(false, 'calln');
		this.sendResponse(response);
	}

	protected stepOutRequest(response: DebugProtocol.StepOutResponse, args: DebugProtocol.StepOutArguments): void {
		this._variableHandles.reset();
		this._runtime.step(false, 'jumpr');
		this.sendResponse(response);
	}

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		const clientLines = args.lines ?? [];

		if(!this.matchesSource(args.source.path)) {
			response.body = {
				breakpoints: clientLines.map(l => <DebugProtocol.Breakpoint>{
					verified: false,
					source: this._source,
					line: l
				})
			};
			this.sendResponse(response);
			return;
		}

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints();

		// set and send back the breakpoint positions
		response.body = {
			breakpoints: clientLines.map(l => {
				const bp = this._runtime.setBreakpoint(this.convertClientLineToDebugger(l));
				bp.source = this._source;
				bp.line = l;
				return bp;
			})
		};
		this.sendResponse(response);
	}

	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// runtime supports no threads so just return a default thread.
		response.body = {
			threads: [
				new Thread(HMMMDebugSession.THREAD_ID, "main")
			]
		};
		this.sendResponse(response);
	}

	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		response.body = this._runtime.getStack(args.startFrame, args.levels);
		response.body.stackFrames.forEach(frame => {
			if(frame.line === -1) {
				frame.line = 0;
			} else {
				frame.source = this._source;
				frame.line = this.convertDebuggerLineToClient(frame.line);
			}
		});
		this.sendResponse(response);
	}

	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		response.body = {
			scopes: [
				{
					name: "Registers",
					presentationHint: "registers",
					variablesReference: this._variableHandles.create(`frame_${args.frameId}.registers`),
					expensive: false,
					namedVariables: 18 // 16 registers + pc + ir
				},
				{
					name: "Memory",
					variablesReference: this._variableHandles.create(`frame_${args.frameId}.memory`),
					expensive: false,
					indexedVariables: 256
				}
			],
		};
		this.sendResponse(response);
	}

	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		response.body = { variables: [] };

		const parsedName = this.parseVariableName(this._variableHandles.get(args.variablesReference));
		if(!parsedName) {
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		if(name === "registers" && args.filter !== 'indexed') {
			response.body.variables.push(this.getVariable("pc", frame, args.format?.hex, undefined)!);
			response.body.variables.push(this.getVariable("ir", frame, args.format?.hex, undefined)!);
			for(let i = 0; i < 16; i++) {
				response.body.variables.push(this.getVariable(`r${i}`, frame, args.format?.hex, undefined)!);
			}
		} else if(name === "memory" && args.filter !== 'named') {
			for(let i = 0; i < 256; i++) {
				response.body.variables.push(this.getVariable(`addr_${i}`, frame, args.format?.hex, undefined)!);
			}
		} else if(name.startsWith("addr_") || name.startsWith("r")) {
			if(format) {
				this.sendResponse(response);
				return;
			}

			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "hex")!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "binary")!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "signed")!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "unsigned")!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "decompiled")!);
			if(name.startsWith("addr_")) response.body.variables.push(this.getVariable(name, frame, args.format?.hex, "modified")!);
		}

		response.body.variables = sliceWithCount(response.body.variables, args.start, args.count);
		this.sendResponse(response);
	}

	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		const parsedName = this.parseVariableName(args.expression);
		if(!parsedName) {
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		const result = this.getVariable(name, frame ?? args.frameId, args.format?.hex, format);
		if(result) {
			response.body = {
				result: result.value,
				type: result.type,
				presentationHint: result.presentationHint,
				variablesReference: result.variablesReference,
				namedVariables: result.namedVariables,
				indexedVariables: result.indexedVariables,
				memoryReference: result.memoryReference
			};
		}
		this.sendResponse(response);
	}

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		const parsedName = this.parseVariableName(args.expression);
		if(!parsedName) {
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		this.setVariable(name, args.value, frame ?? args.frameId, format);

		const result = this.getVariable(name, frame, args.format?.hex, format);
		if(result) {
			response.body = {
				value: result.value,
				type: result.type,
				presentationHint: result.presentationHint,
				variablesReference: result.variablesReference,
				namedVariables: result.namedVariables,
				indexedVariables: result.indexedVariables,
				memoryReference: result.memoryReference
			};
		}
		this.sendResponse(response);
	}

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		const parsedName = this.parseVariableName(args.name, args.variablesReference);
		if(!parsedName) {
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		this.setVariable(name, args.value, frame, format);

		const result = this.getVariable(name, frame, args.format?.hex, format);
		if(result) {
			response.body = {
				value: result.value,
				type: result.type,
				variablesReference: result.variablesReference,
				namedVariables: result.namedVariables,
				indexedVariables: result.indexedVariables,
				memoryReference: result.memoryReference
			};
		}
		this.sendResponse(response);
	}

	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		response.body = {
			dataId: null,
			description: "Data breakpoints can only be set on memory addresses and general purpose registers."
		};

		if(args.variablesReference) {
			const container = this._variableHandles.get(args.variablesReference);
			const [ frame, name, format ] = this.parseVariableName(container) ?? [ undefined, undefined, undefined ];

			if(name && name !== "memory" && name !== "registers") {
				this.sendResponse(response);
				return;
			}
		}

		const parsedName = this.parseVariableName(args.name);
		if(!parsedName) {
			this.sendResponse(response);
			return;
		}
		const [ frame, name, format ] = parsedName;

		if(format) {
			this.sendResponse(response);
			return;
		}

		if (/$(r\d+|addr_\d+)/.test(name) && name !== "r0") {
			response.body = {
				dataId: name,
				description: name.startsWith("addr_") ? `Memory Address ${name.substring("addr_".length)}` : `Register ${name.substring(1)}`,
				accessTypes: [ "read", "write", "readWrite" ],
				canPersist: true
			};
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: args.breakpoints.map(bp => {
				if(/$(r\d+|addr_\d+)/.test(bp.dataId) && bp.dataId !== "r0") {
					const onRead = bp.accessType === "read" || bp.accessType === "readWrite";
					const onWrite = bp.accessType === "write" || bp.accessType === "readWrite";

					if(bp.dataId.startsWith("addr_")) {
						const address = parseInt(bp.dataId.substring("addr_".length));
						if(isNaN(address) || address < 0 || address > 255) {
							return <DebugProtocol.Breakpoint> {
								verified: false,
								message: `${address} is not a valid memory address.`
							};
						}
						return <DebugProtocol.Breakpoint> {
							id: this._runtime.setDataBreakpoint(address, "memory", onRead, onWrite),
							verified: true,
							description: `Memory Address ${address}`
						}
					} else {
						const register = parseInt(bp.dataId.substring(1));
						if(isNaN(register) || register < 0 || register > 15) {
							return <DebugProtocol.Breakpoint> {
								verified: false,
								message: `${register} is not a valid register.`
							};
						}
						return <DebugProtocol.Breakpoint> {
							id: this._runtime.setDataBreakpoint(register, "register", onRead, onWrite),
							verified: true,
							description: `Register ${register}`
						}
					}
				}
				return <DebugProtocol.Breakpoint> {
					verified: false,
					message: `Data breakpoints can only be set on memory addresses and general purpose registers.`
				};
			})
		};

		this.sendResponse(response);
	}

	protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request | undefined): void {
		if(!this.matchesSource(args.source.path)) {
			this.sendResponse(response);
			return;
		}

		response.body = {
			targets: this._runtime.getValidInstructionLocations(
				this.convertClientLineToDebugger(args.line)
			).map(l => {
				const instructionAddress = this._runtime.getInstructionForSourceLine(l);
				return <DebugProtocol.GotoTarget> {
					id: instructionAddress,
					line: this.convertDebuggerLineToClient(l),
					column: this.convertDebuggerColumnToClient(0),
					label: `Instruction ${instructionAddress}`
				}
			})
		}

		this.sendResponse(response);
	}

	protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request | undefined): void {
		this._runtime.goto(args.targetId);

		this.sendResponse(response);
	}

	protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request | undefined): void {
		this._runtime.restartFrame(args.frameId);
	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request | undefined): void {
		const [ exceptionId, description ] = this._runtime.getLastException();

		response.body = {
			exceptionId,
			description,
			breakMode: "always"
		};
		this.sendResponse(response);
	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request | undefined): void {
		this._runtime.setExceptionBreakpoints(args.filters);
	}

	//---- helpers

	private parseVariableName(name: string, variablesReference?: number): [number | undefined, string, string | undefined] | undefined {
		if(variablesReference && name.endsWith(" Value")) {
			const container = this.parseVariableName(this._variableHandles.get(variablesReference, ''));
			if(container) {
				container[2] = name.substring(0, name.length - " Value".length).toLowerCase();
				return container;
			}
		}

		let frame: number | undefined = undefined;
		if(name.startsWith("frame_")) {
			const indexOfDot = name.indexOf('.');
			if(indexOfDot >= 0) {
				frame = parseInt(name.substring('frame_'.length, indexOfDot));
				name = name.substring(indexOfDot + 1);
			} else {
				return undefined;
			}
		}
		const indexOfDot = name.indexOf('.');
		name = indexOfDot >= 0 ? name.substring(0, indexOfDot) : name;
		const format = indexOfDot >= 0 ? name.substring(indexOfDot + 1) : undefined;

		return [ frame, name, format ];
	}

	private getVariable(name: string, stackFrame?: number, hex?: boolean, format?: string): DebugProtocol.Variable | undefined {
		stackFrame = stackFrame ?? -1;
		name = name.toLowerCase();

		if(!isNaN(parseInt(name))) name = `addr_${name}`;

		const frame = this._runtime.getStateAtFrame(stackFrame);
		if(!frame) return undefined;

		let displayName = name;
		let value: string | number | undefined = undefined;
		let numChildren = 0;
		let attributes: DebugProtocol.VariablePresentationHint["attributes"] = undefined;

		if(name === "pc") {
			value = frame.instructionPointer;
			attributes = [ "readOnly" ];
		} else if(name === "ir") {
			const instruction = decompileInstruction(frame.instruction) ?? "invalid instruction";
			value = instruction;
			attributes = [ "readOnly" ];
		} else if(name.startsWith('r')) {
			const register = parseInt(name.substring(1));
			if(isNaN(register) || register < 0 || register > 15) return undefined;
			value = frame.registers[register];
			attributes = register === 0 ? [ "constant", "readOnly" ] : undefined;
			numChildren = 5;
		} else if(name.startsWith('addr_')) {
			const address = parseInt(name.substring('addr_'.length));
			if(isNaN(address) || address < 0 || address > 255) return undefined;
			value = frame.memory[address];
			numChildren = 6;
		} else {
			return undefined;
		}

		let stringValue: string | undefined = undefined;
		if(typeof value === "number") {
			if(format === "hex") {
				displayName = "Hex Value";
				stringValue = HMMMDebugSession.formatValue(value, false, true);
				numChildren = 0;
			} else if(format === "binary") {
				displayName = "Binary Value";
				stringValue = value.toString(2).padStart(16, "0").replace(binaryRegex, "$1 $2 $3 $4");
				numChildren = 0;
			} else if(format === "signed") {
				displayName = "Signed Value";
				stringValue = HMMMDebugSession.formatValue(value, true, false);
				numChildren = 0;
			} else if(format === "unsigned") {
				displayName = "Unsigned Value";
				stringValue = HMMMDebugSession.formatValue(value, false, false);
				numChildren = 0;
			} else if(format === "decompiled") {
				displayName = "Decompiled Instruction";
				stringValue = decompileInstruction(value) ?? "invalid instruction";
				attributes = HMMMDebugSession.withReadOnly(attributes);
				numChildren = 0;
			} else if(format === "modified") {
				displayName = "Modified";
				const address = name.startsWith("addr_") ? parseInt(name.substring("addr_".length)) : NaN;
				stringValue = isNaN(address) ? "unknown" : frame.modifiedMemory.has(parseInt(name.substring("addr_".length))).toString();
				attributes = HMMMDebugSession.withReadOnly(attributes);
				numChildren = 0;
			} else {
				stringValue = name === "pc" ? value.toString() : HMMMDebugSession.formatValue(value, true, hex);
			}
		} else {
			stringValue = value;
		}

		if(stackFrame !== -1) attributes = HMMMDebugSession.withReadOnly(attributes);

		const evaluateName = `frame_${stackFrame}.${name}${format ? `.${format}` : ""}`;
		return <DebugProtocol.Variable> {
			name: displayName,
			value: stringValue,
			evaluateName,
			variablesReference: numChildren ? this._variableHandles.create(evaluateName) : 0,
			namedVariables: numChildren,
			presentationHint: attributes ? { attributes } : undefined
		};
	}

	private setVariable(name: string, value: string, stackFrame?: number, format?: string): void {
		stackFrame = stackFrame ?? -1;
		if(stackFrame !== -1) return;

		name = name.toLowerCase();
		value = value.toLowerCase().replace(/[_\s]/g, "");

		if(!isNaN(parseInt(name))) name = `addr_${name}`;

		let newValue: number | undefined = undefined;
		let detectedFormat: string | undefined = undefined;
		if(value.startsWith("0x")) {
			newValue = parseInt(value.substring(2), 16);
			detectedFormat = "hex";
		} else if(/[a-f]/.test(value)) {
			newValue = parseInt(value, 16);
			detectedFormat = "hex";
		} else if(value.startsWith("0b")) {
			newValue = parseInt(value.substring(2), 2);
			detectedFormat = "binary";
		} else if(value.length > 6 && /^[01]+$/.test(value)) {
			newValue = parseInt(value, 2);
			detectedFormat = "binary";
		} else if(value.startsWith("-")) {
			newValue = parseInt(value, 10);
			detectedFormat = "signed";
		}

		if(format && detectedFormat && format !== detectedFormat) return;

		if(format && !newValue) {
			switch(format) {
				case "hex": newValue = parseInt(value, 16); break;
				case "binary": newValue = parseInt(value, 2); break;
				case "signed":
				case "unsigned": newValue = parseInt(value, 10); break;
			}
		}

		if(!newValue) newValue = parseInt(value, 10);
		if(isNaN(newValue)) return;

		if(name.startsWith('r')) {
			const register = parseInt(name.substring(1));
			if(isNaN(register) || register < 0 || register > 15) return;
			this._runtime.setRegister(register, newValue);
		} else if(name.startsWith('addr_')) {
			const address = parseInt(name.substring('addr_'.length));
			if(isNaN(address) || address < 0 || address > 255) return;
			this._runtime.setMemory(address, newValue);
		}

		this.sendEvent(new InvalidatedEvent([ "variables" ], HMMMDebugSession.THREAD_ID, stackFrame));
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath));
	}

	private matchesSource(otherPath: string | undefined) {
		return otherPath && this._source?.path && relative(this._source.path, otherPath) === "";
	}

	private static withReadOnly(attributes?: DebugProtocol.VariablePresentationHint["attributes"]): DebugProtocol.VariablePresentationHint["attributes"] {
		return attributes ? attributes.concat("readOnly").filter(removeDuplicates) : [ "readOnly" ];
	}

	private static formatValue(value: number, signed?: boolean, hex?: boolean): string {
		return hex ? `0x${value.toString(16).padStart(4, "0")}` : signed ? HMMMRuntime.s16IntToNumber(value).toString() : value.toString();
	}
}
