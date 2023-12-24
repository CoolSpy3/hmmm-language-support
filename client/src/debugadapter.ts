// Modified from: https://github.com/microsoft/vscode-mock-debug/blob/668fa6f5db95dbb76825d4eb670ab0d305050c3b/src/mockDebug.ts

import {
	BreakpointEvent,
	DebugSession,
	Handles,
	InitializedEvent,
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

/**
 * This interface describes the hmmm-debug specific launch attributes
 * (which are not part of the Debug Adapter Protocol).
 * The schema for these attributes lives in the package.json of the extension.
 * The interface should always match this schema.
 */
interface LaunchRequestArguments extends DebugProtocol.LaunchRequestArguments {
	/** An absolute path to the "program" to debug. */
	program: string;
	/** Automatically stop target after launch. If not specified, target does not stop. */
	stopOnEntry?: boolean;
}

export function sliceWithCount<T>(array: T[], start?: number, count?: number): T[] {
	return array.slice(start, (start ?? 0) + (count ?? array.length));
}

export class HMMMDebugSession extends DebugSession {

	// we don't support multiple threads, so we can use a hardcoded ID for the default thread
	private static THREAD_ID = 1;

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
		this._runtime.on('stopOnEntry', () => {
			this.sendEvent(new StoppedEvent('entry', HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnStep', () => {
			this.sendEvent(new StoppedEvent('step', HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnBreakpoint', () => {
			this.sendEvent(new StoppedEvent('breakpoint', HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnDataBreakpoint', () => {
			this.sendEvent(new StoppedEvent('data breakpoint', HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('stopOnException', () => {
			this.sendEvent(new StoppedEvent('exception', HMMMDebugSession.THREAD_ID));
		});
		this._runtime.on('breakpointValidated', (bp: DebugProtocol.Breakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', bp));
		});
		this._runtime.on('output', (text, filePath, line, column) => {
			const e: DebugProtocol.OutputEvent = new OutputEvent(`${text}\n`);
			e.body.source = this.createSource(filePath);
			e.body.line = this.convertDebuggerLineToClient(line);
			e.body.column = this.convertDebuggerColumnToClient(column);
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

		// Execution Capabilities
		response.body.supportsGotoTargetsRequest = true;
		response.body.supportsStepBack = debuggingSettings.get("enableReverseExecution", false);

		// Breakpoint Capabilities
		response.body.supportsBreakpointLocationsRequest = true;
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
				description: "The program reached attempted to execute a memory address that does not contain a valid instruction."
			},
			{
				filter: "invalid-memory-access",
				label: "Invalid Memory Access",
				default: true,
				description: "The program attempted to access a memory address that does not exist."
			},
			{
				filter: "instruction-read",
				label: "Instruction Read",
				default: false,
				description: "The program attempted to read an instruction from memory."
			},
			{
				filter: "instruction-write",
				label: "Instruction Write",
				default: true,
				description: "The program attempted to overwrite an instruction in memory."
			},
			{
				filter: "execute-outside-cs",
				label: "Execute Outside Code Segment",
				default: true,
				description: "The program attempted to execute an instruction outside of the code segment."
			}
		];
		response.body.supportsExceptionInfoRequest = true;

		this.sendResponse(response);

		// since this debug adapter can accept configuration requests like 'setBreakpoint' at any time,
		// we request them early by sending an 'initializeRequest' to the frontend.
		// The frontend will end the configuration sequence by calling 'configurationDone' request.
		this.sendEvent(new InitializedEvent());
	}

	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		// start the program in the runtime
		this._runtime.start(args.program, this.createSource(args.program), !!args.stopOnEntry);

		this.sendResponse(response);
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

	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		if(!args.source.path) {
			this.sendResponse(response);
			return;
		}

		const path = this.convertClientPathToDebugger(args.source.path);
		const clientLines = args.lines || [];

		// clear all breakpoints for this file
		this._runtime.clearBreakpoints(path);

		// set and send back the breakpoint positions
		response.body = {
			breakpoints: clientLines.map(this.convertClientLineToDebugger, this).map(l => this._runtime.setBreakPoint(path, l))
		};
		this.sendResponse(response);
	}

	protected breakpointLocationsRequest(response: DebugProtocol.BreakpointLocationsResponse, args: DebugProtocol.BreakpointLocationsArguments, request?: DebugProtocol.Request): void {
		if(!args.source.path) {
			this.sendResponse(response);
			return;
		}

		response.body.breakpoints =
			this._runtime.getValidInstructionLocations(
				this.convertClientPathToDebugger(args.source.path),
				this.convertClientLineToDebugger(args.line),
				this.convertClientLineToDebugger(args.endLine ?? args.line)
			).map(l => <DebugProtocol.BreakpointLocation>{line: this.convertDebuggerLineToClient(l)});

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
		response.body = this._runtime.getStack(args.startFrame, args.levels)
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

	protected async variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments, request?: DebugProtocol.Request) {
		response.body.variables = [];

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

	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments, request?: DebugProtocol.Request | undefined): void {
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

	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments, request?: DebugProtocol.Request | undefined): void {
		const parsedName = this.parseVariableName(args.name);
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
            description: "cannot break on data access",
            accessTypes: undefined,
            canPersist: false
        };

		if (args.variablesReference && args.name) {
			const id = this._variableHandles.get(args.variablesReference);
			if (id.startsWith("global_")) {
				response.body.dataId = args.name;
				response.body.description = args.name;
				response.body.accessTypes = [ "read" ];
				response.body.canPersist = true;
			}
		}

		this.sendResponse(response);
	}

	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {

		// clear all data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			breakpoints: []
		};

		for (let dbp of args.breakpoints) {
			// assume that id is the "address" to break on
			const ok = this._runtime.setDataBreakpoint(dbp.dataId);
			response.body.breakpoints.push({
				verified: ok
			});
		}

		this.sendResponse(response);
	}

	protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments, request?: DebugProtocol.Request | undefined): void {

	}

	protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments, request?: DebugProtocol.Request | undefined): void {

	}

	protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments, request?: DebugProtocol.Request | undefined): void {

	}

	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, args: DebugProtocol.ExceptionInfoArguments, request?: DebugProtocol.Request | undefined): void {

	}

	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments, request?: DebugProtocol.Request | undefined): void {

	}

	//---- helpers

	private parseVariableName(name: string): [number | undefined, string, string | undefined] | undefined {
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
		stackFrame = stackFrame ?? 0;
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
		} else if(name.startsWith('addr_')) {
			const address = parseInt(name.substring('addr_'.length));
			if(isNaN(address) || address < 0 || address > 255) return undefined;
			value = HMMMDebugSession.formatValue(frame.memory[address], true, hex);
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
				stringValue = value.toString(2).padStart(16, "0").replace(binaryRegex, "$1 $2 $3 $4");
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
				attributes = [ "readOnly" ];
				numChildren = 0;
			} else {
				stringValue = name === "pc" ? value.toString() : HMMMDebugSession.formatValue(value, true, hex);
			}
		} else {
			stringValue = value;
		}

		if(stackFrame !== 0) attributes = HMMMDebugSession.withReadOnly(attributes);

		const evaluateName = `frame_${frame}.${name}${format ? `.${format}` : ""}`;
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
		stackFrame = stackFrame ?? 0;
		if(stackFrame !== 0) return;

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
		} else if(value.length > 6 && /^[01]$/.test(value)) {
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
	}

	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath), undefined, undefined, undefined);
	}

	private static withReadOnly(attributes?: DebugProtocol.VariablePresentationHint["attributes"]): DebugProtocol.VariablePresentationHint["attributes"] {
		return attributes ? attributes.concat("readOnly").filter((value, index, array) => array.indexOf(value) === index) : [ "readOnly" ]; // https://stackoverflow.com/a/14438954
	}

	private static formatValue(value: number, signed?: boolean, hex?: boolean): string {
		return hex ? `0x${value.toString(16).padStart(4, "0")}` : signed ? HMMMRuntime.s16IntToNumber(value).toString() : value.toString();
	}
}
