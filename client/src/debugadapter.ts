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
import { decompileInstruction, formatBinaryNumber, strictParseInt } from '../../hmmm-spec/out/hmmm';
import { HMMMRuntime, s16IntToNumber } from './runtime';

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

/**
 * Perform a slice on an array with a start and count.
 * @param array The array to slice
 * @param start The start index or undefined to start at 0
 * @param count The number of elements to slice or undefined to slice to the end of the array
 * @returns The sliced array
 */
export function sliceWithCount<T>(array: T[], start: number = 0, count: number = array.length): T[] {
	return array.slice(start, start + count);
}

/**
 * A filter function that removes duplicates from an array. (Copied from https://stackoverflow.com/a/14438954)
 * @param value The value to check
 * @param index The index of the value in the array
 * @param array The array to filter from
 * @returns True if the value at the given index is the first occurrence of the value in the array; false otherwise
 */
export function removeDuplicates<T>(value: T, index: number, array: T[]): boolean {
	return array.indexOf(value) === index;
}

/**
 * A debug adapter for the HMMM language.
 */
export class HMMMDebugSession extends DebugSession {

	/**
	 * We don't support multiple threads, so we can use a hardcoded ID for the default thread
	 */
	private static THREAD_ID = 1;

	/**
	 * The callback that is called when the configuration is done and the program can be started.
	 */
	private _onConfigurationDone: (() => void) | undefined = undefined;

	/**
	 * The source of the program that is being debugged. (Sent to the frontend as part of various event/response bodies.)
	 */
	private _source: Source | undefined = undefined;

	/**
	 * The runtime that is being used to execute the program.
	 */
	private _runtime: HMMMRuntime;

	/**
	 * A repository for mapping the variable names used by the adapter to handles sent to the frontend.
	 */
	private _variableHandles = new Handles<string>();

	//#region Lifecycle

	/**
	 * Configures the debug session by creating a new HMMM Runtime and setting up event handlers for it.
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
			e.body.hitBreakpointIds = Array.isArray(breakpointIds) ? breakpointIds : [breakpointIds];
			this.sendEvent(e);
		});
		this._runtime.on('breakpointValidated', (bp: DebugProtocol.Breakpoint) => {
			this.sendEvent(new BreakpointEvent('changed', bp));
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
	 * Relays the capabilities of this debug adapter to the frontend.
	 */
	protected initializeRequest(response: DebugProtocol.InitializeResponse, _args: DebugProtocol.InitializeRequestArguments): void {
		// A reference to the debugging settings configured for the extension
		const debuggingSettings = workspace.getConfiguration('hmmm.debugging');

		// Define the capabilities object if it doesn't exist
		response.body = response.body ?? {};

		// Lifecycle Capabilities
		response.body.supportsConfigurationDoneRequest = true;

		// Execution Capabilities
		response.body.supportsGotoTargetsRequest = true;
		response.body.supportsStepBack = debuggingSettings.get('enableReverseExecution', false);

		// Breakpoint Capabilities
		response.body.supportsDataBreakpoints = true;

		// Stack/Variable Capabilities
		response.body.supportsDelayedStackTraceLoading = true;
		response.body.supportsEvaluateForHovers = true;
		response.body.supportsRestartFrame = true;
		response.body.supportsSetVariable = true;
		response.body.supportsValueFormattingOptions = true;

		// Exception Capabilities
		response.body.supportsExceptionInfoRequest = true;
		response.body.exceptionBreakpointFilters = [
			{
				filter: 'invalid-instruction',
				label: 'Invalid Instruction',
				default: true,
				description: 'Breaks if the program attempts to execute a memory address that contains an invalid instruction.'
			},
			{
				filter: 'invalid-memory-access',
				label: 'Invalid Memory Access',
				default: true,
				description: 'Breaks if the program attempts to access a memory address that does not exist.'
			},
			{
				filter: 'cs-read',
				label: 'Code Segment Read',
				default: true,
				description: 'Breaks if the program attempts to read from an address inside the code segment.'
			},
			{
				filter: 'cs-write',
				label: 'Code Segment Write',
				default: true,
				description: 'Breaks if the program attempts to overwrite an instruction in memory.'
			},
			{
				filter: 'execute-outside-cs',
				label: 'Execute Outside Code Segment',
				default: true,
				description: 'Breaks if the program attempts to execute an instruction outside of the code segment.'
			}
		];

		this.sendResponse(response);
	}

	/*
	 * Sent by the frontend when all configuration requests have been sent by the frontend and the debug session can be started.
	 */
	protected configurationDoneRequest(response: DebugProtocol.ConfigurationDoneResponse, _args: DebugProtocol.ConfigurationDoneArguments): void {
		// Side note: It doesn't seem like VSCode actually sends this request, but it's part of the protocol so I've included it anyway.

		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Start the runtime if it hasn't been already
		this._onConfigurationDone?.();
	}

	/**
	 * Sent by the frontend to launch the program with the provided configuration information.
	 */
	protected async launchRequest(response: DebugProtocol.LaunchResponse, args: LaunchRequestArguments) {
		// Get the absolute path to the program to debug
		const program = this.convertClientPathToDebugger(args.program);

		// Create a source object for the program so that it can be sent to the frontend when needed
		this._source = this.createSource(program);

		// Attempt to configure the runtime for the program
		if (!this._runtime.configure(program, args.isBinary ? 'hb' : 'hmmm')) {
			// The runtime failed to configure due to a build error
			this.sendErrorResponse(response, 1, 'Program contains errors! Please fix them before debugging.', undefined, ErrorDestination.User);
			return;
		}

		// Acknowledge that the launch request has been received and processed successfully
		this.sendResponse(response);

		// Setup a callback to start the runtime once the configuration is done
		this._onConfigurationDone = function () {
			this._onConfigurationDone = undefined;

			this._runtime.continue();
		};

		// Notify the frontend that we are ready to begin receiving configuration requests
		// We waited until now to do this so that the runtime can be configured and we can know which files we're debugging
		this.sendEvent(new InitializedEvent());

		// If we haven't received a ConfigurationDone request in 1 second, assume that the frontend doesn't support it and start the runtime
		// I wanted to make this timeout longer ~5000 ms, but it seems like VSCode doesn't send the ConfigurationDone request
		// (see note in the configurationDoneRequest method) and longer timeouts make the debugger feel unresponsive.
		setTimeout(_ => this._onConfigurationDone?.(), 1000);
	}

	//#endregion

	//#region Execution

	/**
	 * Sent by the frontend to continue execution of the program after it's stopped
	 */
	protected continueRequest(response: DebugProtocol.ContinueResponse, _args: DebugProtocol.ContinueArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Continue execution of the program
		this._runtime.continue();
	}

	/**
	 * Sent by the frontend to continue execution of the program in reverse after it's stopped
	 */
	protected reverseContinueRequest(response: DebugProtocol.ReverseContinueResponse, _args: DebugProtocol.ReverseContinueArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Continue execution of the program in reverse
		this._runtime.continue(true);
	}

	/**
	 * Sent by the frontend to step forward one instruction in the program
	 */
	protected nextRequest(response: DebugProtocol.NextResponse, _args: DebugProtocol.NextArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Step forward one instruction
		this._runtime.step();
	}

	/**
	 * Sent by the frontend to step backward one instruction in the program
	 */
	protected stepBackRequest(response: DebugProtocol.StepBackResponse, _args: DebugProtocol.StepBackArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Step backward one instruction
		this._runtime.step(true);
	}

	/**
	 * Sent by the frontend to pause the execution of the program
	 */
	protected pauseRequest(response: DebugProtocol.PauseResponse, _args: DebugProtocol.PauseArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Pause the execution of the program
		this._runtime.pause();
	}

	/**
	 * Sent by the frontend to step into a function call in the program
	 */
	protected stepInRequest(response: DebugProtocol.StepInResponse, _args: DebugProtocol.StepInArguments): void {
		/*
		 * Function calls aren't as well defined in HMMM as they are in other languages, so we'll just run until we execute a call instruction.
		 */

		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Continue until we execute a call instruction
		this._runtime.step(false, 'calln');
	}

	/**
	 * Sent by the frontend to step out of a function call in the program
	 */
	protected stepOutRequest(response: DebugProtocol.StepOutResponse, _args: DebugProtocol.StepOutArguments): void {
		/*
		 * Function calls aren't as well defined in HMMM as they are in other languages, so we'll just run until we execute a jumpr instruction.
		 */

		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Invalidate all variable handles created in the stopped state
		this._variableHandles.reset();

		// Continue until we execute a jumpr instruction
		this._runtime.step(false, 'jumpr');
	}

	/**
	 * Sent by the frontend to determine if the debugger can jump to a specific location in the program
	 */
	protected gotoTargetsRequest(response: DebugProtocol.GotoTargetsResponse, args: DebugProtocol.GotoTargetsArguments): void {
		// If the source file doesn't match the one we're debugging, we can't jump to any locations
		if (!this.matchesSource(args.source.path)) {
			this.sendResponse(response);
			return;
		}

		// Otherwise, we can jump to any valid instruction location in the program
		response.body = {
			targets: this._runtime.getValidInstructionLocations(
				this.convertClientLineToDebugger(args.line)
			).map(l => {
				const instructionAddress = this._runtime.getInstructionForSourceLine(l);
				return <DebugProtocol.GotoTarget>{
					id: instructionAddress, // Set the target ID to the address of the instruction so that we can jump to the id rather than looking up the address again
					line: this.convertDebuggerLineToClient(l),
					column: this.convertDebuggerColumnToClient(0),
					label: `Instruction ${instructionAddress}`
				};
			})
		};

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to jump to a specific location in the program
	 */
	protected gotoRequest(response: DebugProtocol.GotoResponse, args: DebugProtocol.GotoArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Jump to the specified location in the program (This does not resume execution)
		this._runtime.goto(args.targetId); // The address of the instruction is just the target's ID
	}

	//#endregion

	//#region Breakpoints

	/**
	 * Sent by the frontend to set source line breakpoints in the program
	 */
	protected setBreakPointsRequest(response: DebugProtocol.SetBreakpointsResponse, args: DebugProtocol.SetBreakpointsArguments): void {
		const clientLines = args.lines ?? [];

		// if the source file doesn't match the one we're debugging, we can't set any breakpoints
		if (!this.matchesSource(args.source.path)) {
			response.body = {
				// So map each line to a breakpoint with verified = false
				breakpoints: clientLines.map(l => <DebugProtocol.Breakpoint>{
					verified: false,
					source: this._source,
					line: l
				})
			};
			this.sendResponse(response);
			return;
		}

		// Clear all breakpoints in the source file
		this._runtime.clearAllSourceBreakpoints();

		// Set the breakpoints in the source file
		response.body = {
			breakpoints: clientLines.map(l => {
				const bp = this._runtime.setSourceBreakpoint(this.convertClientLineToDebugger(l));
				// Update the breakpoints returned by the runtime with the actual source and line information
				bp.source = this._source;
				bp.line = l;
				return bp;
			})
		};

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to determine if a data breakpoint can be set on a variable
	 */
	protected dataBreakpointInfoRequest(response: DebugProtocol.DataBreakpointInfoResponse, args: DebugProtocol.DataBreakpointInfoArguments): void {
		// By default, we can't set a data breakpoint on the variable
		response.body = {
			dataId: null,
			description: 'Data breakpoints can only be set on memory addresses and general purpose registers.'
		};

		/**
		 * We will only allow data breakpoints to be set on memory addresses and general purpose registers.
		 * The reasoning for this is as follows:
		 * - pc and ir should change every instruction, so it doesn't make sense to set a data breakpoint on them (the user can just step the program instead)
		 * - r0 is always 0, so it doesn't make sense to set a data breakpoint on it
		 * - The "value interpretations" of each register/memory address will change if and only if the value of the register/memory address changes, so
		 *   rather than setting a data breakpoint on the value interpretation, the user can just set a data breakpoint on the register/memory address itself
		 *   This allows us to use the name of the actual register/memory address as the dataId and not run into conflicts with the value interpretations sharing the same name
		 */

		// Attempt to parse the variable name
		const parsedName = this.parseVariableName(args.name);
		if (!parsedName) {
			// Parsing failed; we can't set a data breakpoint on a variable we can't identify
			this.sendResponse(response);
			return;
		}
		const [_frame, name, format] = parsedName;

		if (format) {
			// If the variable is an interpreted value, we can't set a data breakpoint on it
			this.sendResponse(response);
			return;
		}

		// Check if the variable is a register or memory address (besides r0)
		if (/^(r\d+|addr_\d+)$/.test(name) && name !== 'r0') {
			// If so, we can set a data breakpoint on it
			response.body = {
				dataId: name, // Make the dataId the name of the register/memory address so that we can use it to easily identify the register/memory address later without having to use some kind of lookup table
				description: name.startsWith('addr_') ? `Memory Address ${name.substring('addr_'.length)}` : `Register ${name.substring(1)}`,
				accessTypes: ['read', 'write', 'readWrite'],
				canPersist: true
			};
		}

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to set data breakpoints on variables
	 */
	protected setDataBreakpointsRequest(response: DebugProtocol.SetDataBreakpointsResponse, args: DebugProtocol.SetDataBreakpointsArguments): void {
		// Clear all old data breakpoints
		this._runtime.clearAllDataBreakpoints();

		response.body = {
			// Attempt to map each requested breakpoint to a data breakpoint
			breakpoints: args.breakpoints.map(bp => {
				// Check that the breakpoint refers to a valid data location
				if (/^(r\d+|addr_\d+)$/.test(bp.dataId) && bp.dataId !== 'r0') {
					// Parse the requested access type to determine which types of breakpoints to set
					const onRead = bp.accessType === 'read' || bp.accessType === 'readWrite';
					const onWrite = bp.accessType === 'write' || bp.accessType === 'readWrite';

					if (bp.dataId.startsWith('addr_')) {
						// If the breakpoint refers to a memory address check that the address is valid
						const address = strictParseInt(bp.dataId.substring('addr_'.length));
						if (isNaN(address) || address < 0 || address > 255) {
							// If not, return a breakpoint with verified = false and a message explaining why
							return <DebugProtocol.Breakpoint>{
								verified: false,
								message: `${address} is not a valid memory address.`
							};
						}
						// Otherwise, return a breakpoint with verified = true
						return <DebugProtocol.Breakpoint>{
							id: this._runtime.setDataBreakpoint(address, 'memory', onRead, onWrite),
							verified: true,
							description: `Memory Address ${address}`
						};
					} else {
						// If the breakpoint refers to a register check that the register is valid
						const register = strictParseInt(bp.dataId.substring(1));
						if (isNaN(register) || register < 0 || register > 15) {
							// If not, return a breakpoint with verified = false and a message explaining why
							return <DebugProtocol.Breakpoint>{
								verified: false,
								message: `${register} is not a valid register.`
							};
						}
						// Otherwise, return a breakpoint with verified = true
						return <DebugProtocol.Breakpoint>{
							id: this._runtime.setDataBreakpoint(register, 'register', onRead, onWrite),
							verified: true,
							description: `Register ${register}`
						};
					}
				}
				// If the breakpoint does not refer to a valid data location, return a breakpoint with verified = false and a message explaining why
				return <DebugProtocol.Breakpoint>{
					verified: false,
					message: 'Data breakpoints can only be set on memory addresses and general purpose registers.'
				};
			})
		};

		this.sendResponse(response);
	}

	//#endregion

	//#region Stack/Variables

	/**
	 * Sent by the frontend to retrieve the threads that are currently running in the program
	 */
	protected threadsRequest(response: DebugProtocol.ThreadsResponse): void {
		// The runtime doesn't support multiple threads, so we can just return a single hardcoded thread
		response.body = {
			threads: [
				new Thread(HMMMDebugSession.THREAD_ID, 'main')
			]
		};
		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to retrieve the call stack of the program
	 */
	protected stackTraceRequest(response: DebugProtocol.StackTraceResponse, args: DebugProtocol.StackTraceArguments): void {
		// Retrieve the call stack from the runtime
		response.body = this._runtime.getStack(args.startFrame, args.levels);

		// Update the source/line information for each frame
		response.body.stackFrames.forEach(frame => {
			// If the frame has line === -1, it means that the frame does not have a corresponding source file
			if (frame.line === -1) {
				// According to the DAP, this means that we should set the source to undefined and the line to 0
				// We can't return line = 0 from the Runtime because it uses 0 to represent the first line of the source file
				frame.line = 0;
			} else {
				// Otherwise set the source to the source file we're debugging and convert the line to the client's line numbering
				frame.source = this._source;
				frame.line = this.convertDebuggerLineToClient(frame.line);
			}
		});

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to retrieve the scopes of a stack frame
	 */
	protected scopesRequest(response: DebugProtocol.ScopesResponse, args: DebugProtocol.ScopesArguments): void {
		// The Runtime always has 2 scopes: registers and memory
		response.body = {
			scopes: [
				{
					name: 'Registers',
					presentationHint: 'registers',
					// Create a variable handle which refers to the requested frame's registers
					variablesReference: this._variableHandles.create(`frame_${args.frameId}.registers`),
					expensive: false,
					namedVariables: 18 // 16 registers + pc + ir
				},
				{
					name: 'Memory',
					// Create a variable handle which refers to the requested frame's memory
					variablesReference: this._variableHandles.create(`frame_${args.frameId}.memory`),
					expensive: false,
					indexedVariables: 256 // 256 memory addresses
				}
			],
		};

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to retrieve the (sub-)variables of a scope or variable
	 */
	protected variablesRequest(response: DebugProtocol.VariablesResponse, args: DebugProtocol.VariablesArguments) {
		// Initialize the response body
		response.body = { variables: [] };

		// Attempt to parse the variable name
		const parsedName = this.parseVariableName(this._variableHandles.get(args.variablesReference));
		if (!parsedName) {
			// Parsing failed; we can't retrieve any variables
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		if (name === 'registers' && args.filter !== 'indexed') { // The registers scope does not contain indexed variables
			// If the variable is the registers scope, add all registers to the response
			response.body.variables.push(this.getVariable('pc', frame, args.format?.hex)!);
			response.body.variables.push(this.getVariable('ir', frame, args.format?.hex)!);
			for (let i = 0; i < 16; i++) {
				response.body.variables.push(this.getVariable(`r${i}`, frame, args.format?.hex)!);
			}
		} else if (name === 'memory' && args.filter !== 'named') { // The memory scope does not contain named variables
			// Add all memory addresses to the response

			// Use the arguments to determine the range of memory addresses to add
			const startIdx = args.start ?? 0;
			const count = args.count ?? 256;
			const endIdx = Math.min(startIdx + count, 256);

			// Add each memory address to the response
			for (let i = startIdx; i < endIdx; i++) {
				response.body.variables.push(this.getVariable(`addr_${i}`, frame, args.format?.hex)!);
			}
		} else if (name.startsWith('addr_') || name.startsWith('r') && args.filter !== 'indexed') { // Register/memory address variables do not contain indexed sub-variables
			if (format) {
				// If the variable is an interpreted value, it has no sub-variables
				this.sendResponse(response);
				return;
			}

			// If the variable is a register/memory address, add all value interpretations to the response
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'hex')!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'binary')!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'signed')!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'unsigned')!);
			response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'decompiled')!);
			// Memory addresses also have a "modified" value interpretation
			if (name.startsWith('addr_')) response.body.variables.push(this.getVariable(name, frame, args.format?.hex, 'modified')!);
		}

		// Slice the variables to the requested start and count
		// I know that this could be optimized to only create the variables that are requested, but
		// I think that that would make the code harder to read while only providing a negligible performance improvement

		// I did optimize the memory addresses though because there are enough of them that a frontend may decide to filter them, and
		// because they were already being added in a loop, not much additional code was needed to optimize them
		if (name !== 'memory') response.body.variables = sliceWithCount(response.body.variables, args.start, args.count);
		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to retrieve the value of a variable/expression
	 */
	protected evaluateRequest(response: DebugProtocol.EvaluateResponse, args: DebugProtocol.EvaluateArguments): void {
		// Attempt to parse the variable name
		const parsedName = this.parseVariableName(args.expression);
		if (!parsedName) {
			// Parsing failed; we can't evaluate the expression
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		// Evaluate the variable (If a frame was not specified, use the frame specified by the arguments)
		const result = this.getVariable(name, frame ?? args.frameId, args.format?.hex, format);
		if (result) {
			// If the variable was evaluated successfully, return the result
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

	/**
	 * Sent by the frontend to set the value of an expression
	 */
	protected setExpressionRequest(response: DebugProtocol.SetExpressionResponse, args: DebugProtocol.SetExpressionArguments): void {
		// Attempt to parse the variable name
		const parsedName = this.parseVariableName(args.expression);
		if (!parsedName) {
			// Parsing failed; we can't set the expression value
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		// Set the variable (If a frame was not specified, use the frame specified by the arguments)
		this.setVariable(name, args.value, frame ?? args.frameId, format);

		// Evaluate the variable for the response
		const result = this.getVariable(name, frame, args.format?.hex, format);
		if (result) {
			// If the variable was evaluated successfully, return the result
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

	/**
	 * Sent by the frontend to set the value of a variable
	 */
	protected setVariableRequest(response: DebugProtocol.SetVariableResponse, args: DebugProtocol.SetVariableArguments): void {
		// Attempt to parse the variable name
		const parsedName = this.parseVariableName(args.name, args.variablesReference);
		if (!parsedName) {
			// Parsing failed; we can't set the variable value
			this.sendResponse(response);
			return;
		}
		const [frame, name, format] = parsedName;

		// Set the variable
		this.setVariable(name, args.value, frame, format);

		// Evaluate the variable for the response
		const result = this.getVariable(name, frame, args.format?.hex, format);
		if (result) {
			// If the variable was evaluated successfully, return the result
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

	/**
	 * Sent by the frontend to restart a stack frame
	 */
	protected restartFrameRequest(response: DebugProtocol.RestartFrameResponse, args: DebugProtocol.RestartFrameArguments): void {
		// Acknowledge that the request has been received
		this.sendResponse(response);

		// Restart the specified frame
		this._runtime.restartFrame(args.frameId);
	}

	//#endregion

	//#region Exceptions

	/**
	 * Sent by the frontend to retrieve information about the last exception that occurred in the program
	 */
	protected exceptionInfoRequest(response: DebugProtocol.ExceptionInfoResponse, _args: DebugProtocol.ExceptionInfoArguments): void {
		// Get the last exception that occurred in the program
		const [exceptionId, description] = this._runtime.getLastException();

		// Populate the response with the exception information
		response.body = {
			exceptionId,
			description,
			breakMode: 'always'
		};

		this.sendResponse(response);
	}

	/**
	 * Sent by the frontend to set the exception breakpoints that are enabled in the program
	 */
	protected setExceptionBreakPointsRequest(response: DebugProtocol.SetExceptionBreakpointsResponse, args: DebugProtocol.SetExceptionBreakpointsArguments): void {
		// Clear all exception breakpoints
		this._runtime.clearAllExceptionBreakpoints();

		// Attempt to set the exception breakpoints
		response.body = {
			breakpoints: args.filters.map(filter => this._runtime.setExceptionBreakpoint(filter))
		};

		this.sendResponse(response);
	}

	//#endregion

	//#region Variable Helper Functions

	/**
	 * Parses a variable name into its component parts.
	 * @param name The name to parse
	 * @param variablesReference The variables reference of the container of the variable (if it has one)
	 * @returns A tuple containing the frame number, variable name, and format of the variable (if it has one)
	 */
	private parseVariableName(name: string, variablesReference?: number): [number | undefined, string, string | undefined] | undefined {
		if (variablesReference && name.endsWith(' Value')) {
			// If a variablesReference was provided and the name refers to a value interpretation, try to parse the container as a variable and append the format
			const container = this.parseVariableName(this._variableHandles.get(variablesReference, ''));
			if (container) {
				container[2] = name.substring(0, name.length - ' Value'.length).toLowerCase();
				return container;
			}
		}

		// Attempt to parse the frame number
		let frame: number | undefined = undefined;
		if (name.startsWith('frame_')) {
			const indexOfDot = name.indexOf('.');
			if (indexOfDot >= 0) {
				// The frame number is the number between "frame_" and the first dot
				frame = strictParseInt(name.substring('frame_'.length, indexOfDot));
				// Remove the frame number from the name
				name = name.substring(indexOfDot + 1);
			} else {
				// The variable started with "frame_" but did not have a dot after it, so it is invalid
				return undefined;
			}
		}
		// Attempt to parse the format
		const indexOfDot = name.indexOf('.');
		// If the variable has a dot, the name is everything before the dot and the format is everything after the dot
		name = indexOfDot >= 0 ? name.substring(0, indexOfDot) : name;
		const format = indexOfDot >= 0 ? name.substring(indexOfDot + 1) : undefined;

		return [frame, name, format];
	}

	/**
	 * Attempts to retrieve the value of a variable from the runtime.
	 * @param name The name of the variable to retrieve
	 * @param stackFrame The stack frame to retrieve the variable from (if omitted, the variable will be retrieved from the topmost stack frame)
	 * @param hex Whether or not to format the value as a hex number (This is provided for ease of use with some request arguments)
	 * @param format The format interpretation of the variable to retrieve (if omitted, the uninterpreted value will be retrieved, and
	 * 		the variable will have sub-variables for each format interpretation). (This supersedes the hex argument)
	 * @returns The variable if it was retrieved successfully, otherwise undefined
	 */
	private getVariable(name: string, stackFrame: number = -1, hex?: boolean, format?: string): DebugProtocol.Variable | undefined {
		// Convert the name to lowercase for easier comparison
		name = name.toLowerCase();

		// If the name is a number, assume it refers to a memory address
		if (!isNaN(strictParseInt(name))) name = `addr_${name}`;

		// Attempt to retrieve the stack frame that the variable refers to
		const frame = this._runtime.getStateAtFrame(stackFrame);
		if (!frame) return undefined; // If the stack frame does not exist, the variable does not exist

		// Setup a set of default values for the variable (These can be overridden if the variable is found)
		let displayName = name;
		let value: string | number | undefined = undefined;
		let numChildren = 0;
		let attributes: DebugProtocol.VariablePresentationHint['attributes'] = undefined;

		if (name === 'pc') {
			// The variable is the program counter
			value = frame.instructionPointer;
			attributes = ['readOnly'];
		} else if (name === 'ir') {
			// The variable is the instruction register
			value = decompileInstruction(frame.memory[frame.instructionPointer]) ?? 'invalid instruction';
			attributes = ['readOnly'];
		} else if (name.startsWith('r')) {
			// The variable is a register
			const register = strictParseInt(name.substring(1));
			if (isNaN(register) || register < 0 || register > 15) return undefined; // If the register does not exist, the variable does not exist
			value = frame.registers[register];
			attributes = register === 0 ? ['constant', 'readOnly'] : undefined;
			numChildren = 5; // hex, binary, signed, unsigned, decompiled
		} else if (name.startsWith('addr_')) {
			// The variable is a memory address
			const address = strictParseInt(name.substring('addr_'.length));
			if (isNaN(address) || address < 0 || address > 255) return undefined; // If the memory address does not exist, the variable does not exist
			value = frame.memory[address];
			numChildren = 6; // hex, binary, signed, unsigned, decompiled, modified
		} else {
			// If the variable does not refer to a register or memory address, it does not exist
			return undefined;
		}

		// Convert the (possibly numerical) value to a string
		let stringValue: string | undefined = undefined;
		if (typeof value === 'number') {
			// If the value is a number, format it according to the format interpretation
			// If a format interpretation was provided, the value is an interpreted value, so we can set the display name to the format interpretation and numChildren to 0
			if (format === 'hex') {
				displayName = 'Hex Value';
				stringValue = HMMMDebugSession.formatValue(value, false, true);
				numChildren = 0;
			} else if (format === 'binary') {
				displayName = 'Binary Value';
				stringValue = formatBinaryNumber(value.toString(2), true);
				numChildren = 0;
			} else if (format === 'signed') {
				displayName = 'Signed Value';
				stringValue = HMMMDebugSession.formatValue(value, true, false);
				numChildren = 0;
			} else if (format === 'unsigned') {
				displayName = 'Unsigned Value';
				stringValue = HMMMDebugSession.formatValue(value, false, false);
				numChildren = 0;
			} else if (format === 'decompiled') {
				displayName = 'Decompiled Instruction';
				stringValue = decompileInstruction(value) ?? 'invalid instruction';
				// We don't support setting the decompiled value directly, so we can make it read-only
				attributes = HMMMDebugSession.withReadOnly(attributes);
				numChildren = 0;
			} else if (format === 'modified') {
				displayName = 'Modified';
				const address = name.startsWith('addr_') ? strictParseInt(name.substring('addr_'.length)) : NaN;
				stringValue = isNaN(address) ? 'unknown' : frame.modifiedMemory.has(strictParseInt(name.substring('addr_'.length))).toString();
				// We don't support setting the modified value, so we can make it read-only
				attributes = HMMMDebugSession.withReadOnly(attributes);
				numChildren = 0;
			} else {
				// If no format interpretation was provided, interpret it using default format interpretation semantics
				// (Always print pc as an unsigned base-10 number because it *should* always be in the range 0-255)
				stringValue = name === 'pc' ? value.toString() : HMMMDebugSession.formatValue(value, true, hex);
			}
		} else {
			// If the value is already a string, use it as is
			stringValue = value;
		}

		// If the variable is not in the topmost stack frame, it is read-only
		if (stackFrame !== -1) attributes = HMMMDebugSession.withReadOnly(attributes);

		// Construct a name that can be used to evaluate the variable
		const evaluateName = `frame_${stackFrame}.${name}${format ? `.${format}` : ''}`;

		return <DebugProtocol.Variable>{
			name: displayName,
			value: stringValue,
			evaluateName,
			// If the variable has sub-variables, create a variable handle that can be used to retrieve them
			variablesReference: numChildren ? this._variableHandles.create(evaluateName) : 0,
			namedVariables: numChildren,
			presentationHint: attributes ? { attributes } : undefined
		};
	}

	/**
	 * Sets the value of a variable in the runtime.
	 * @param name The name of the variable to set
	 * @param value The value to set the variable to
	 * @param stackFrame The stack frame to set the variable in (if omitted, the variable will be set in the topmost stack frame)
	 *                   (Because the runtime does not support setting variables in non-top stack frames, values of stackFrame !== -1 will cause this function to do nothing)
	 * @param format The format interpretation of the variable to set (if omitted, the function will attempt to detect the format, falling back on base-10 if it cannot)
	 */
	private setVariable(name: string, value: string, stackFrame: number = -1, format?: string): void {
		// If the variable is not in the topmost stack frame, we can't set it
		if (stackFrame !== -1) return;

		// Convert the name to lowercase for easier comparison
		name = name.toLowerCase();

		// If the name is a number, assume it refers to a memory address
		if (!isNaN(strictParseInt(name))) name = `addr_${name}`;

		// Remove underscores and whitespace from the new value
		value = value.toLowerCase().replace(/[_\s]/g, '');

		// Attempt to detect the format of the new value
		// For the moment, only attempt to detect unambiguous formats
		// This way, we can compare it to the requested format to see if its valid
		let newValue: number | undefined = undefined;
		let detectedFormat: string | undefined = undefined;
		if (value.startsWith('0x')) {
			// If the value starts with '0x', assume it is a hex number
			newValue = strictParseInt(value.substring(2), 16);
			detectedFormat = 'hex';
		} else if (/[a-f]/.test(value)) {
			// If the value contains a letter, assume it is a hex number
			newValue = strictParseInt(value, 16);
			detectedFormat = 'hex';
		} else if (value.startsWith('0b')) {
			// If the value starts with '0b', assume it is a binary number
			newValue = strictParseInt(value.substring(2), 2);
			detectedFormat = 'binary';
		} else if (value.length > 6 && /^[01]+$/.test(value)) {
			// If the value is a binary number with more than 6 digits, assume it is a binary number
			// (base-10 and hex numbers larger than 6 digits cannot be stored in HMMM registers/memory)
			newValue = strictParseInt(value, 2);
			detectedFormat = 'binary';
		} else if (value.startsWith('-')) {
			// If the value starts with '-', assume it is a signed number
			newValue = strictParseInt(value, 10);
			detectedFormat = 'signed';
		}

		// If a format was provided and the detected format does not match it, the value is invalid (remember we only detected unambiguous formats)
		if (format && detectedFormat && format !== detectedFormat) return;

		// If the value is still unknown, attempt to parse it with the requested format
		if (format && !newValue) {
			switch (format) {
				case 'hex': newValue = strictParseInt(value, 16); break;
				case 'binary': newValue = strictParseInt(value, 2); break;
				case 'signed':
				case 'unsigned': newValue = strictParseInt(value, 10); break;
			}
		}

		// If the value is still unknown, attempt to parse it as a base-10 number
		if (!newValue) newValue = strictParseInt(value, 10);

		// If all of the above failed, we can't parse the value
		if (isNaN(newValue)) return;

		// Now that we know the new Value, attempt to parse the name
		if (name.startsWith('r')) {
			// If the name is a register, check that the register is valid
			const register = strictParseInt(name.substring(1));
			if (isNaN(register) || register < 0 || register > 15) return;
			// If so, set the register to the new value
			this._runtime.setRegister(register, newValue);
		} else if (name.startsWith('addr_')) {
			// If the name is a memory address, check that the address is valid
			const address = strictParseInt(name.substring('addr_'.length));
			if (isNaN(address) || address < 0 || address > 255) return;
			// If so, set the memory address to the new value
			this._runtime.setMemory(address, newValue);
		}

		// If the value was set successfully, invalidate all variables in the stack frame (as far as I can tell, there's no way to only invalidate some variables)
		this.sendEvent(new InvalidatedEvent(['variables'], HMMMDebugSession.THREAD_ID, stackFrame));
	}

	/**
	 * Formats a 16-bit number based on the provided parameters.
	 * @param value The value to format, provided as an unsigned 16-bit number
	 * @param signed Whether or not the value should be interpreted as a signed number
	 * @param hex Whether or not the value should be formatted as a hex number
	 * @returns The formatted value
	 */
	private static formatValue(value: number, signed?: boolean, hex?: boolean): string {
		return hex ? `0x${value.toString(16).padStart(4, '0')}` : signed ? s16IntToNumber(value).toString() : value.toString();
	}

	/**
	 * Adds the 'readOnly' attribute to the provided list of variable attributes.
	 * @param attributes The attributes to add the 'readOnly' attribute to
	 * @returns The new list of attributes
	 */
	private static withReadOnly(attributes?: DebugProtocol.VariablePresentationHint['attributes']): DebugProtocol.VariablePresentationHint['attributes'] {
		return attributes ? attributes.concat('readOnly').filter(removeDuplicates) : ['readOnly'];
	}

	//#endregion

	//#region Source Helper Functions

	/**
	 * Creates a Source object for the provided file path.
	 * @param filePath The path of the source file in the debugger's format
	 * @returns The created Source object
	 */
	private createSource(filePath: string): Source {
		return new Source(basename(filePath), this.convertDebuggerPathToClient(filePath));
	}

	/**
	 * Checks if the provided file path matches the source file we're debugging.
	 * @param otherPath The path to check (a value of undefined will always return false)
	 * @returns True if the path matches the source file we're debugging, otherwise false
	 */
	private matchesSource(otherPath: string | undefined) {
		return otherPath && this._source?.path && relative(this._source.path, otherPath) === '';
	}

	//#endregion

}
