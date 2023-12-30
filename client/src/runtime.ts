// Modified from: https://github.com/microsoft/vscode-mock-debug/blob/668fa6f5db95dbb76825d4eb670ab0d305050c3b/src/mockRuntime.ts

import { StackFrame } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { InputBoxOptions, window, workspace } from 'vscode';
import {
	ParsedHMMMInstructionComponents,
	binaryRegex,
	compile,
	componentsOf,
	decompileInstruction,
	preprocessLine,
	strictParseInt
} from '../../hmmm-spec/out/hmmm';
import { sliceWithCount } from './debugadapter';

/**
 * An instruction log entry. Contains the information necessary to undo the effects of an instruction
 */
export interface ExecutedInstruction {
	/**
	 * The id of the instruction. This is used to determine which instructions to remove from the instruction log when a stack frame is restarted
	 */
	id: number;
	/**
	 * The address of the instruction that was executed (the instruction pointer)
	 */
	address: number;
	/**
	 * The old value of the register/memory address that was modified by the instruction (Used to revert the change during reverse execution).
	 * If the instruction did not modify a register or memory address, this is undefined
	 */
	oldData?: number;
	/**
	 * Whether or not the instruction created a stack frame that needs to be removed during reverse execution
	 */
	didCreateStackFrame: boolean;
}

/**
 * A stack frame. Contains the information necessary to restore the state of the machine to the state it was in when the frame was created
 */
export interface HMMMState {
	/**
	 * The address of the current instruction being executed (the instruction pointer)
	 */
	instructionPointer: number;
	/**
	 * The registers of the HMMM
	 */
	registers: number[];
	/**
	 * The memory of the HMMM
	 */
	memory: number[];
	/**
	 * The memory addresses that have been modified since the machine was started
	 */
	modifiedMemory: Set<number>;
	/**
	 * The id of the last instruction (in the instruction log) that was executed
	 */
	lastExecutedInstructionId?: number;
}

/**
 * Represents an access to a register or memory address
 */
interface StateAccess {
	/**
	 * The address of the register/memory address being accessed
	 */
	address: number;
	/**
	 * Whether the address refers to a register or memory address
	 */
	dataType: "register" | "memory";
	/**
	 * The type of access (read or write)
	 */
	accessType: "read" | "write";
}

/**
 * Converts an unsigned 16-bit integer to a signed number.
 * @param n The unsigned 16-bit integer to convert.
 * @returns The signed number.
 */
export function s16IntToNumber(n: number): number {
	if (n > 32767) return n - 65536;
	return n;
}

/**
 * A HMMM runtime
 */
export class HMMMRuntime extends EventEmitter {

	//#region Variable Definitions and Basic Getters/Setters

	//#region Source Information

	/**
	 * The language of the source file (binary or assembly)
	 */
	private _language: "hb" | "hmmm" | undefined = undefined;

	/**
	 * The source code of the program
	 */
	private _sourceLines: string[] = [];

	/**
	 * Maps from instruction number to source line number
	 */
	private _instructionToSourceMap = new Map<number, number>();

	/**
	 * Maps from source line number to instruction number
	 */
	private _sourceToInstructionMap = new Map<number, number>();

	/**
	 * Gets the address of an instruction given a source line number
	 * @param line The source line number
	 * @returns The address of the instruction at the given source line number
	 */
	public getInstructionForSourceLine(line: number): number | undefined {
		return this._sourceToInstructionMap.get(line);
	}

	/**
	 * Gets the source line number for an instruction address
	 * @param instruction The instruction address
	 * @returns The source line number for the instruction at the given address
	 */
	public getSourceLineForInstruction(instruction: number): number | undefined {
		return this._instructionToSourceMap.get(instruction);
	}

	/**
	 * The number of instructions loaded into memory from the source file
	 */
	private _numInstructions = 0;

	/**
	 * The number of instructions loaded into memory from the source file
	 */
	public get numInstructions() {
		return this._numInstructions;
	}

	//#endregion

	//#region Machine State

	/**
	 * The address of the current instruction being executed
	 */
	private _instructionPointer = 0;

	/**
	 * The address of the current instruction being executed
	 */
	public get instructionPointer(): number {
		return this._instructionPointer;
	}

	/**
	 * The address of the current instruction being executed
	 */
	private set instructionPointer(address: number) {
		this._instructionPointer = address;

		// _ignoreBreakpoints & _ignoredExceptions always refer to the instruction at the current value of instructionPointer
		// If we're changing the instruction pointer (even if its to the same values [such as for the code `0 jumpn 0`]),
		// we need to reset these values
		this._ignoreBreakpoints = false;
		this._ignoredExceptions = [];
	}

	/**
	 * A NodeJS Immediate that is queued to execute the next instruction
	 */
	private _queuedInstructionExecution: NodeJS.Immediate | undefined = undefined;

	/**
	 * The registers of the HMMM
	 */
	private _registers: number[] = Array(16).fill(0);

	/**
	 * The registers of the HMMM
	 */
	public get registers() {
		return this._registers;
	}

	/**
	 * Sets the value of a register
	 * @param register The register to set. If out of range (or 0), this function does nothing
	 * @param value The value to set the register to. This value is truncated to 16 bits
	 */
	public setRegister(register: number, value: number) {
		if (register < 1 /* register 0 is always 0 */ || register > 15) return;
		this._registers[register] = value & 0xFFFF;
	}

	/**
	 * The memory of the HMMM
	 */
	private _memory: number[] = Array(256).fill(0);

	/**
	 * The memory of the HMMM
	 */
	public get memory() {
		return this._memory;
	}

	/**
	 * Sets the value of a memory address
	 * @param address The address to set. If out of range, this function does nothing
	 * @param value The value to set the address to. This value is truncated to 16 bits
	 */
	public setMemory(address: number, value: number) {
		if (address < 0 || address > 255) return;
		this._memory[address] = value & 0xFFFF;
		// Keep track of which memory addresses have been modified
		this._modifiedMemory.add(address);
	}

	/**
	 * The memory addresses that have been modified since the machine was started
	 */
	private _modifiedMemory = new Set<number>();

	/**
	 * The memory addresses that have been modified since the machine was started
	 */
	public get modifiedMemory() {
		return this._modifiedMemory;
	}

	/**
	 * @returns The current state of the HMMM
	 */
	public getCurrentState(): HMMMState {
		return {
			instructionPointer: this.instructionPointer,
			// Copy the registers and memory so that they can be modified without affecting the original values
			registers: [...this._registers],
			memory: [...this._memory],
			modifiedMemory: new Set(this._modifiedMemory),
			lastExecutedInstructionId: this._instructionLog.length > 0 ? this._instructionLog[0].id : undefined,
		};
	}

	//#endregion

	//#region Breakpoints/Exceptions

	/**
	 * The next breakpoint id to use. This is incremented every time a breakpoint is set to ensure that each breakpoint has a unique id
	 */
	private _breakpointId = 1;

	/**
	 * Maps from instruction address to breakpoint id of a breakpoint set on that instruction
	 */
	private _instructionBreakpoints = new Map<number, number>();

	/**
	 * Maps from register number to breakpoint id of a data read breakpoint set on that register
	 */
	private _registerReadBreakpoints = new Map<number, number>();

	/**
	 * Maps from register number to breakpoint id of a data write breakpoint set on that register
	 */
	private _registerWriteBreakpoints = new Map<number, number>();

	/**
	 * Maps from memory address to breakpoint id of a data read breakpoint set on that memory address
	 */
	private _memoryReadBreakpoints = new Map<number, number>();

	/**
	 * Maps from memory address to breakpoint id of a data write breakpoint set on that memory address
	 */
	private _memoryWriteBreakpoints = new Map<number, number>();

	/**
	 * Sets whether or not to ignore breakpoints. This is used to ignore breakpoints that are hit while stepping
	 */
	private _ignoreBreakpoints = false;

	/**
	 * A list of exceptions that have been hit but ignored on the current instruction
	 */
	private _ignoredExceptions: string[] = [];

	/**
	 * A map of enabled exceptions to their breakpoint ids
	 */
	private _enabledExceptions = new Map<string, number>();

	/**
	 * The id of the last exception that was hit
	 */
	private _exception: string = "";

	/**
	 * The description of the last exception that was hit
	 */
	private _exceptionDescription: string = "";

	/**
	 * Retrieves information about the last exception that was hit
	 * @returns A tuple containing the exception id and description
	 */
	public getLastException(): [string, string] {
		return [this._exception, this._exceptionDescription];
	}

	//#endregion

	//#region Stack and Instruction Log

	/**
	 * The stack of the HMMM. A stack frame is pushed onto the stack every time the program jumps to a new instruction rather than executing sequentially.
	 * The top of the stack is the recent frame.
	 */
	private _stack = new Array<HMMMState>();

	/**
	 * Whether or not the stack is enabled (Set by the user in the settings)
	 */
	private _stackEnabled = false;

	/**
	 * The maximum depth of the stack (Set by the user in the settings)
	 */
	private _maxStackDepth: number = 0;

	/**
	 * Whether or not the user has been warned about the stack depth being exceeded. This is used to prevent spamming the user with warnings
	 */
	private _hasSentStackDepthWarning = false;

	/**
	 * The id that will be used for the next executed instruction in the instruction log.
	 * This is used to determine which instructions to remove from the instruction log when a stack frame is restarted
	 */
	private _instructionId = 1;

	/**
	 * The instruction log of the HMMM. An entry is added to the instruction log every time an instruction is executed to allow for reverse execution.
	 * The top of the log is the most recently executed instruction.
	 */
	private _instructionLog = new Array<ExecutedInstruction>();

	/**
	 * Whether or not the instruction log is enabled (Set by the user in the settings)
	 */
	private _instructionLogEnabled = false;

	/**
	 * The maximum length of the instruction log (Set by the user in the settings)
	 */
	private _maxInstructionLogLength: number = 0;

	/**
	 * Whether or not the user has been warned about the instruction log length being exceeded. This is used to prevent spamming the user with warnings
	 */
	private _hasSentInstructionLogLengthWarning = false;

	//#endregion

	//#endregion

	//#region Lifecycle/Execution

	/**
	 * Configures the runtime to execute the given program
	 * @param program The path to the program to execute
	 * @param language The language of the program to execute
	 */
	public configure(program: string, language: "hb" | "hmmm"): boolean {
		this._language = language;

		// Load the settings set by the user
		const debuggingSettings = workspace.getConfiguration("hmmm.debugging");
		this._stackEnabled = debuggingSettings.get<boolean>("enableReverseExecution", false);
		this._maxStackDepth = debuggingSettings.get<number>("reverseExecutionDepth", 0);
		this._instructionLogEnabled = debuggingSettings.get<boolean>("enableStackFrames", false);
		this._maxInstructionLogLength = debuggingSettings.get<number>("stackFrameDepth", 0);

		// Load the program from the given file and return whether or not it was loaded successfully
		return this.loadSource(program);
	}

	/**
	 * Loads the source code from the given file and stores the instructions in memory
	 * @param file The path to the file to load
	 * @returns Whether or not the file was loaded successfully
	 */
	private loadSource(file: string): boolean {
		// Read the file and split it into lines
		this._sourceLines = readFileSync(file).toString().split('\n');

		// By default the source code is binary, so no preprocessing is needed
		let code = this._sourceLines;

		// If the code is assembly, attempt to compile it
		if (this._language === "hmmm") {
			const compiledCode = compile(code);

			// If compilation failed, return false (compilation failed)
			if (!compiledCode) return false;

			// Otherwise, set the binary code to the compiled code
			// compile also returns a map from instruction number to source line number, so store that as well
			[code, this._instructionToSourceMap] = compiledCode;

			// Use the instruction to source map to populate the source to instruction map
			for (const [instructionLine, sourceLine] of this._instructionToSourceMap) {
				this._sourceToInstructionMap.set(sourceLine, instructionLine);
			}
		}

		// Store the binary code in memory
		for (let i = 0; i < code.length; i++) {
			const line = code[i];

			if (!line.trim()) continue; // Skip empty lines

			// this._numInstructions contains the number of instructions loaded *before* this instruction, so
			// it's current value can be used as the address of this instruction

			// If the language is assembly, we already populated the instruction to/from source maps
			if (this._language === "hb") {
				this._instructionToSourceMap.set(this._numInstructions, i);
				this._sourceToInstructionMap.set(i, this._numInstructions);
			}

			const encodedInstruction = strictParseInt(line.replaceAll(/\s/g, ''), 2);

			// If the line is not a valid binary instruction, return false (compilation failed)
			if (isNaN(encodedInstruction)) return false;

			// Store the instruction in memory and increment the number of instructions loaded
			this._memory[this._numInstructions++] = encodedInstruction;
		}

		// Return true (compilation succeeded)
		return true;
	}

	/**
	 * Continue execution to the end/beginning.
	 *
	 * @param reverse Whether or not to execute the program in reverse
	 */
	public continue(reverse = false) {
		this.run(reverse);
	}

	/**
	 * Step to the next/previous instruction
	 *
	 * @param reverse Whether or not to step in reverse
	 * @param stepInstruction The name of the instruction to step through (and execute). If not specified, execute exactly one instruction
	 */
	public step(reverse = false, stepInstruction: string = '') {
		this.run(reverse, stepInstruction);
	}

	/**
	 * Jump directly to the given address and pause execution. This does not execute the current instruction.
	 * @param instruction The address to jump to
	 */
	public goto(instruction: number) {
		// Create a stack frame so that the user can step back to the current instruction
		this.createStackFrame();

		// Add an entry to the instruction log so that reverse execution works property and the stack frame gets removed
		// Regardless of the current instruction, say that it created a stack frame (because we just created one)
		// Additionally, set oldData = undefined because we did not actually execute the current instruction, so nothing was modified
		// (it should be ignored during reverse execution)
		this.updateInstructionLog(true);

		// Set the instruction pointer to the given address
		this.instructionPointer = instruction;

		// Notify the frontend that we've stopped
		this.sendEvent('stop', 'goto');
	}

	/**
	 * Pauses the execution of the program by unqueueing the next instruction execution and sending a pause event
	 */
	public pause() {
		clearImmediate(this._queuedInstructionExecution);
		// Notify the frontend that we've stopped. This also clears this._queuedInstructionExecution, so run can be called
		this.sendEvent('stop', 'pause');
	}

	/**
	 * Run through the file.
	 *
	 * @param reverse Whether or not to execute the program in reverse
	 * @param stepInstruction The name of the instruction to step through (and execute).
	 * 						If this is a string of length 0, execute exactly one instruction.
	 * 						Otherwise, if not specified, execute until a breakpoint is hit, an exception is thrown,
	 * 						or the end of the program is reached
	 */
	private run(reverse = false, stepInstruction?: string) {
		// If the program is already running (an instruction execution is queued), do nothing
		if (this._queuedInstructionExecution) return;

		if (reverse) {
			// If we're running in reverse, ensure that the instruction log is enabled (otherwise we have no idea what we previously executed)
			if (!this._instructionLogEnabled) {
				window.showErrorMessage(`Reverse Execution is not enabled`);
				this.sendEvent('end');
				return;
			}

			// Queue the next instruction execution
			this._queuedInstructionExecution = setImmediate(this.executeInstructionReverse.bind(this, stepInstruction));
		} else {
			// Queue the next instruction execution
			this._queuedInstructionExecution = setImmediate(this.executeInstructionForward.bind(this, stepInstruction));
		}
	}

	/**
	 * Executes the current instruction (in forward order) and queues the next instruction execution (if no breakpoints/exceptions are hit)
	 * @param stepInstruction The name of the instruction to step through (and execute). See run for more information
	 */
	private async executeInstructionForward(stepInstruction?: string) {
		// If there is a breakpoint on the current instruction (and it's not been ignored), pause execution
		if (this._instructionBreakpoints.has(this.instructionPointer) && !this._ignoreBreakpoints) {
			this.sendEvent('stopOnBreakpoint', 'breakpoint', this._instructionBreakpoints.get(this.instructionPointer)!);
			return;
		}

		// Check for exceptions resulting from reading the instruction from memory
		if (this.checkInstructionExecutionAccess()) return;

		// Read and parse the instruction from memory
		const parsedInstruction = this.getInstructionComponents();

		// If the instruction is invalid, throw an exception
		if (!parsedInstruction) {
			this.onInvalidInstruction();
			return;
		}

		// Check for breakpoints/exceptions resulting from reads/writes caused by executing the instruction
		if (this.checkAccesses()) return;

		const [binaryInstruction, instruction, rX, rY, rZ, N] = parsedInstruction;

		// Specific instructions can update these values if necessary. Otherwise, assume that the instruction has no side-effects

		// The old value of the register/memory address that was modified by the instruction (Used to revert the change during reverse execution)
		let oldData: number | undefined = undefined;

		// The address of the next instruction to execute (if modified by the instruction)
		let nextInstructionPointer: number | undefined = undefined;

		// Execute the instruction
		switch (instruction.instruction.name) {
			case "halt":
				this.sendEvent('end');
				return;
			case "read":
				oldData = this._registers[rX!];
				const input = strictParseInt(await window.showInputBox(<InputBoxOptions>{
					placeHolder: `Enter a number to store into r${rX}`,
					prompt: `You can also type any non-numerical text to terminate the program.`,
					title: `HMMM: ${this.instructionPointer} ${decompileInstruction(instruction)}`
				}) ?? '');
				if (isNaN(input)) {
					this.sendEvent('end');
					return;
				}
				this.setRegister(rX!, input);
				break;
			case "write":
				this.instructionOutput('stdout', s16IntToNumber(this._registers[rX!]).toString());
				break;
			case "jumpr":
				nextInstructionPointer = this._registers[rX!];
				break;
			case "setn":
				oldData = this._registers[rX!];
				this.setRegister(rX!, N!);
				break;
			case "loadn":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._memory[N!]);
				break;
			case "storen":
				oldData = this._memory[N!];
				this.setMemory(N!, this._registers[rX!]);
				break;
			case "loadr":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._memory[this._registers[rY!]]);
				break;
			case "storer":
				oldData = this._memory[this._registers[rY!]];
				this.setMemory(this._registers[rY!], this._registers[rX!]);
				break;
			// pushr and popr actually modify two values, however, because the effect on rY is ALWAYS the same (and easily reversible),
			// we only need to store the old value of rX or memory[rY]
			case "popr":
				oldData = this._registers[rX!];
				this.setRegister(rY!, this._registers[rY!] - 1);
				this.setRegister(rX!, this._memory[this._registers[rY!]]);
				break;
			case "pushr":
				oldData = this._memory[this._registers[rY!]];
				this.setMemory(this._registers[rY!], this._registers[rX!]);
				this.setRegister(rY!, this._registers[rY!] + 1);
				break;
			case "addn":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rX!] + N!);
				break;
			case "nop":
				break;
			case "copy":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rY!]);
				break;
			case "add":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rY!] + this._registers[rZ!]);
				break;
			case "neg":
				oldData = this._registers[rX!];
				this.setRegister(rX!, -this._registers[rY!]);
				break;
			case "sub":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rY!] - this._registers[rZ!]);
				break;
			case "mul":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rY!] * this._registers[rZ!]);
				break;
			case "div":
				oldData = this._registers[rX!];
				this.setRegister(rX!, Math.floor(this._registers[rY!] / this._registers[rZ!]));
				break;
			case "mod":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this._registers[rY!] % this._registers[rZ!]);
				break;
			case "jumpn":
				nextInstructionPointer = N!;
				break;
			case "calln":
				oldData = this._registers[rX!];
				this.setRegister(rX!, this.instructionPointer + 1);
				nextInstructionPointer = N!;
				break;
			case "jeqzn":
				if (this._registers[rX!] === 0) {
					nextInstructionPointer = N!;
				}
				break;
			case "jnezn":
				if (this._registers[rX!] !== 0) {
					nextInstructionPointer = N!;
				}
				break;
			case "jgtzn":
				if (this._registers[rX!] > 0) {
					nextInstructionPointer = N!;
				}
				break;
			case "jltzn":
				if (this._registers[rX!] < 0) {
					nextInstructionPointer = N!;
				}
				break;
			default:
				// The instruction does not have an implementation, so throw an exception (this should never happen)
				this.onInvalidInstruction();
				return;
		}

		// We have to update the stack and instruction log before we increment the instruction pointer because
		// the current instruction pointer must be included in both entries

		// Push an entry to the instruction log corresponding to the current instruction
		// We push a stack frame if and only if the instruction modified the instruction pointer
		this.updateInstructionLog(nextInstructionPointer !== undefined, oldData);

		// If the instruction modified the instruction pointer,
		if (nextInstructionPointer !== undefined) {
			// Create a stack frame and set the instruction pointer to the new address
			this.createStackFrame();
			this.instructionPointer = nextInstructionPointer;
		} else {
			// Otherwise, just increment the instruction pointer
			this.instructionPointer++;
		}

		// If a step instruction was specified (and applies to the just executed instruction), pause execution
		if (stepInstruction === '' || instruction.instruction.name === stepInstruction) {
			this.sendEvent('stop', 'step');
			return;
		}

		// Nothing paused execution, so queue the next instruction execution.
		// Queueing this here (rather than using a loop/recursion) allows the rest of the event loop to execute,
		// ensuring that events (like a pause request) from the frontend are processed
		this._queuedInstructionExecution = setImmediate(this.executeInstructionForward.bind(this, stepInstruction));
	}

	/**
	 * Executes the current instruction (in reverse order) and queues the next instruction execution (if no breakpoints/exceptions are hit)
	 * @param stepInstruction The name of the instruction to step through (and execute). See run for more information
	 */
	private executeInstructionReverse(stepInstruction?: string) {
		// Poll the instruction log for the next instruction to execute
		const instructionInfo = this._instructionLog.shift();

		// If there are no instructions in the instruction log, we've reached the end (or rather beginning) of the program, so stop execution
		if (!instructionInfo) {
			this.sendEvent('stop', 'entry');
			return;
		}

		// Update the instruction pointer to the address of the instruction we're about to execute
		// Because all instructions that were executed after this instruction was originally executed have been unwound,
		// the value of the memory address at the instruction pointer is the same as it was when the instruction was originally executed (e.g. the instruction)
		this.instructionPointer = instructionInfo.address;

		// Attempt to read and parse the instruction from memory
		const parsedInstruction = this.getInstructionComponents();

		// If the instruction is invalid, throw an exception (this should never happen because we should've successfully executed the instruction before)
		// For this same reason, we omit the instruction execution access check
		if (!parsedInstruction) {
			this.onInvalidInstruction();
			return;
		}

		const [_binaryInstruction, instruction, rX, rY, _rZ, N] = parsedInstruction;

		// If the instruction created a stack frame, remove it
		if (instructionInfo.didCreateStackFrame) {
			// If the stack is already empty, do nothing (the stack probably overflowed)
			this._stack.shift();
		}

		// If the instruction modified registers/memory, restore the old values
		const oldData = instructionInfo.oldData;
		if (oldData !== undefined) {
			switch (instruction.instruction.name) {
				case "halt":
					this.sendEvent('end');
					return;
				case "write":
				case "jumpr":
				case "nop":
				case "jumpn":
				case "jeqzn":
				case "jnezn":
				case "jgtzn":
				case "jltzn":
					// These instructions don't change registers or memory, so we don't need to restore anything
					break;
				case "read":
				case "setn":
				case "loadn":
				case "loadr":
				case "copy":
				case "addn":
				case "add":
				case "neg":
				case "sub":
				case "mul":
				case "div":
				case "mod":
				case "calln":
					// Restore rX
					this.setRegister(rX!, oldData!);
					break;
				case "storen":
					// Restore memory[N]
					this.setMemory(N!, oldData!);
					break;
				case "storer":
					// Restore memory[rY]
					this.setMemory(this._registers[rY!], oldData!);
					break;
				case "popr":
					// Restore rX and increment rY
					this.setRegister(rX!, oldData!);
					this.setRegister(rY!, this._registers[rY!] + 1);
					break;
				case "pushr":
					// Decrement rY and restore memory[rY]
					this.setRegister(rY!, this._registers[rY!] - 1);
					this.setMemory(this._registers[rY!], oldData!);
					break;
				default:
					this.onInvalidInstruction();
					return;
			}
		}

		// Check for breakpoints/exceptions resulting from reads/writes caused by executing the instruction
		// Unlike in forward execution, we do this after restoring the old values so that if the machine stops,
		// it is in the same state as if it had paused during forward execution
		// (See executeInstructionForward for more detailed comments on each of these blocks)

		if (this._instructionBreakpoints.has(this.instructionPointer) && !this._ignoreBreakpoints) {
			this.sendEvent('stopOnBreakpoint', 'breakpoint', this._instructionBreakpoints.get(this.instructionPointer)!);
			return;
		}

		if (this.checkAccesses()) return;

		if (stepInstruction === '' || instruction.instruction.name === stepInstruction) {
			this.sendEvent('stop', 'step');
			return;
		}

		// Nothing paused execution, so queue the next instruction execution. (See executeInstructionForward for more detailed comments on this)
		this._queuedInstructionExecution = setImmediate(this.executeInstructionReverse.bind(this, stepInstruction));
	}

	//#endregion

	//#region Stack and Instruction Log

	/**
	 * Returns the stacktrace. The returned stack frames do not contain a source file. This is expected to be supplied by the debug adapter.
	 * Additionally, a line number of -1 indicates that the source line is unknown and no source information should be displayed.
	 *
	 * @param startFrame The index of the first frame to return. If not specified, 0 is used
	 * @param levels The maximum number of frames to return. If not specified, all frames are returned
	 */
	public getStack(startFrame: number = 0, levels: number = this._stack.length + 1): DebugProtocol.StackTraceResponse["body"] {
		// Because the 0th frame is the top of the stack (the current instruction), it is not part of this._stack, so
		// when we slice this._stack, we need to start at startFrame - 1
		const sliceStart = Math.max(startFrame - 1, 0);

		// Slice the requested frames from the stack and convert them to stack frames
		// If the 0th frame is requested, it's not part of this._stack (see comment above), so we need 1 fewer frame than requested
		const stack = sliceWithCount(this._stack, sliceStart, startFrame === 0 ? levels - 1 : levels).map((frame, idx) => {
			// Decompile the instruction at the time of execution
			// We can't use this.getInstructionAt because the memory pointed to by the old instruction pointer may have been modified, and
			// getInstructionAt retrieves the instruction from the current memory
			const decompiledInstruction = decompileInstruction(frame.memory[frame.instructionPointer]);
			return <StackFrame>{
				// The id of the frame is the index of the frame in the stack. This makes it easy to lookup the frame later
				// This only has to be valid while execution is paused, so it's fine if the stack changes later
				id: sliceStart + idx,
				name: decompiledInstruction ? `${frame.instructionPointer} ${decompiledInstruction}` : "Invalid Instruction",
				// Try to get the source line number of the instruction
				// If the instruction does not correspond to a source line, set the line number to -1
				line: this._instructionToSourceMap.get(frame.instructionPointer) ?? -1,
				column: 0,
				presentationHint: decompiledInstruction ? "normal" : "label",
				// We can restart execution at any frame in the stack
				canRestart: true
			};
		});

		// If the 0th frame (the current frame) is requested, add it as the top of the stack
		if (startFrame === 0) {
			const currentInstruction = <StackFrame>{
				// The current frame is always -1
				id: -1,
				name: this.getInstructionAt(this.instructionPointer),
				line: this._instructionToSourceMap.get(this.instructionPointer) ?? -1,
				column: 0,
				presentationHint: "subtle",
				// It doesn't make sense to restart execution at the current frame because that would be a no-op
				canRestart: false
			};

			stack.splice(0, 0, currentInstruction);
		}

		// The total number of frames in the stack is the number of frames in the stack + 1 (for the current frame)
		return { stackFrames: stack, totalFrames: this._stack.length + 1 };
	}

	/**
	 * Restarts execution at the given stack frame
	 * @param frameId The id of the frame to restart execution at.
	 */
	public restartFrame(frameId: number) {
		// If the frame id is -1 (the current frame), nothing needs to be done, so just send a stop event
		if (frameId === -1) {
			this.sendEvent('stop', 'restart');
			return;
		}
		// If the frame id is out of range, send a stop event and return (this should never happen because the frontend should prevent it)
		const frame = this._stack[frameId];
		if (!frame) {
			this.sendEvent('stop', 'restart');
			return;
		}

		// Otherwise, restore the state of the machine to the state it was in when the frame was created
		this.instructionPointer = frame.instructionPointer;
		// Copy the registers and memory from the frame so that they can be modified without affecting the original frame
		this._registers = [...frame.registers];
		this._memory = [...frame.memory];
		this._modifiedMemory = new Set(frame.modifiedMemory);
		this._stack = this._stack.slice(0, frameId);

		// Remove all instructions from the instruction log that added after the frame was created
		if (frame.lastExecutedInstructionId) {
			// Remove instructions from the instruction log until we reach the instruction that was at the top of the log when the frame was created
			while (this._instructionLog.length > 0 && this._instructionLog[0].id !== frame.lastExecutedInstructionId) {
				this._instructionLog.shift();
			}
		} else {
			// If the frame was created when the instruction log was empty, clear the instruction log
			this._instructionLog = [];
		}

		// Notify the frontend that we've restored the state of the machine
		this.sendEvent('stop', 'restart');
	}

	/**
	 * Retrieves the state of the HMMM during the given stack frame (if the frame exists)
	 * @param idx The id of the stack frame to retrieve the state of
	 * @returns The state of the HMMM during the given stack frame, or undefined if the frame does not exist
	 */
	public getStateAtFrame(idx: number): HMMMState | undefined {
		if (idx === -1) return this.getCurrentState(); // If the frame id is -1, return the current state
		if (idx < 0 || idx >= this._stack.length) return undefined; // If the frame id is out of range, return undefined
		return this._stack[idx]; // Otherwise, return the state of the machine during the given frame
	}

	/**
	 * Creates a stack frame for the current state of the machine and pushes it onto the top of the stack
	 */
	private createStackFrame() {
		// If the stack is not enabled, do nothing
		if (!this._stackEnabled) return;

		// If the stack is already at the maximum depth, pop the bottom frame off the stack
		if (this._stack.length >= this._maxStackDepth) {
			this._stack.pop();
			// If we haven't already warned the user about the stack depth being exceeded, do so now
			if (!this._hasSentStackDepthWarning) {
				this._hasSentStackDepthWarning = true;
				this.debuggerOutput('WARNING: Stack Overflow');
			}
		}

		// Push the current state of the machine onto the stack
		this._stack.splice(0, 0, this.getCurrentState());
	}

	/**
	 * Updates the instruction log with an entry corresponding to the current instruction and the given information
	 * @param didCreateStackFrame Whether or not the current instruction created a stack frame (Which will need to be removed if the instruction is reversed)
	 * @param oldData The old value of the register/memory address that was modified by the instruction (Used to revert the change during reverse execution)
	 */
	private updateInstructionLog(didCreateStackFrame: boolean, oldData?: number) {
		// If the instruction log is not enabled, do nothing
		if (!this._instructionLogEnabled) return;

		// If the instruction log is at the maximum length, remove the oldest entry
		if (this._instructionLog.length >= this._maxInstructionLogLength) {
			this._instructionLog.pop();

			// If we haven't already warned the user about the instruction log length being exceeded, do so now
			if (!this._hasSentInstructionLogLengthWarning) {
				this._hasSentInstructionLogLengthWarning = true;
				this.debuggerOutput('WARNING: Instruction Log Overflow');
			}
		}

		// Add an entry to the instruction log corresponding to the current instruction
		this._instructionLog.splice(0, 0, {
			// Generate a unique id for the instruction
			id: this._instructionId++,
			address: this.instructionPointer,
			// If the stack is disabled, the instruction did not create a stack frame
			didCreateStackFrame: didCreateStackFrame && this._stackEnabled,
			oldData: oldData
		});
	}

	//#endregion

	//#region Breakpoints/Exceptions

	/**
	 * Sets a source breakpoint on the given line. The returned breakpoint contains no source/line information.
	 * This is expected to be supplied by the debug adapter.
	 * @param line The line to set the breakpoint on
	 */
	public setSourceBreakpoint(line: number): DebugProtocol.Breakpoint {
		// Create a breakpoint object with a unique id and set verified to false (for now)
		const bp: DebugProtocol.Breakpoint = { id: this._breakpointId++, verified: false };

		// If the line maps to an instruction, verify the breakpoint and store it in the instruction breakpoints map
		if (this._sourceToInstructionMap.has(line)) {
			bp.verified = true;
			this._instructionBreakpoints.set(this._sourceToInstructionMap.get(line)!, bp.id!);
		}

		// Return the breakpoint object
		return bp;
	}

	/**
	 * Removes all source breakpoints
	 */
	public clearAllSourceBreakpoints() {
		this._instructionBreakpoints.clear();
	}

	/**
	 * Set data breakpoint.
	 * @param address The address to set the breakpoint on
	 * @param type Whether the address refers to a register or memory location
	 * @param onRead Whether the breakpoint should be triggered when data is read from the specified location
	 * @param onWrite Whether the breakpoint should be triggered when data is written to the specified location
	 * @returns The id of the new breakpoint
	 */
	public setDataBreakpoint(address: number, type: "register" | "memory", onRead: boolean, onWrite: boolean): number {
		// Create a unique id for the breakpoint
		const id = this._breakpointId++;

		// Add the breakpoint to the appropriate map(s)
		if (type === "register") {
			if (onRead) {
				this._registerReadBreakpoints.set(address, id);
			}
			if (onWrite) {
				this._registerWriteBreakpoints.set(address, id);
			}
		} else {
			if (onRead) {
				this._memoryReadBreakpoints.set(address, id);
			}
			if (onWrite) {
				this._memoryWriteBreakpoints.set(address, id);
			}
		}

		// Return the id of the breakpoint
		return id;
	}

	/**
	 * Removes all data breakpoints.
	 */
	public clearAllDataBreakpoints() {
		this._registerReadBreakpoints.clear();
		this._registerWriteBreakpoints.clear();
		this._memoryReadBreakpoints.clear();
		this._memoryWriteBreakpoints.clear();
	}

	/**
	 * Sets an exception breakpoint for the given exception
	 * @param exception The id of the exception to set the breakpoint on
	 * @returns A breakpoint object representing the exception breakpoint
	 */
	public setExceptionBreakpoint(exception: string): DebugProtocol.Breakpoint {
		const bp: DebugProtocol.Breakpoint = {
			// Create a unique id for the breakpoint and set verified to true
			// At the moment, I haven't implemented a system for verifying whether
			// or not an exception id is valid (and I don't think one's necessary), so
			// all exception breakpoints are considered verified
			id: this._breakpointId++,
			verified: true
		};

		// Add the breakpoint to the enabled exceptions map
		this._enabledExceptions.set(exception, bp.id!);

		return bp;
	}

	/**
	 * Removes all exception breakpoints
	 */
	public clearAllExceptionBreakpoints() {
		this._enabledExceptions.clear();
	}

	//#endregion

	//#region Instruction Getters

	/**
	 * Retrieves the line numbers of all source lines in a given range that correspond to valid instructions
	 * @param startLine The first line to check
	 * @param endLine The last line to check (inclusive)
	 * @returns The line numbers of all source lines in the given range that correspond to valid instructions
	 */
	public getValidInstructionLocations(startLine: number = 0, endLine: number = startLine): number[] {
		// Cap the range to the bounds of the source file
		startLine = Math.max(startLine, 0);
		endLine = Math.min(endLine, this._sourceLines.length - 1);

		const validLines: number[] = [];

		// For each line in the given range,
		for (let line = startLine; line <= endLine; line++) {
			const lineText = this._sourceLines[line];

			// Because the runtime should not start unless the program has been successfully compiled,
			// We don't have to fully validate each line. We just have to check that the line contains
			// something resembling a valid instruction

			// Consider the line to map to a valid instruction if and only if
			if (this._language === "hb") {
				// The file contains binary instructions and the line is a valid binary instruction
				if (binaryRegex.test(lineText)) validLines.push(line);
			} else {
				// The file contains assembly instructions and the line contains some uncommented code
				if (preprocessLine(lineText).trim()) validLines.push(line);
			}
		}

		// Return the line numbers of all valid instructions
		return validLines;
	}

	/**
	 * Attempt to decompile the instruction at the given memory address
	 * @param address The address of the instruction to decompile. If this value is out of range, "Invalid Instruction Pointer" is returned
	 * @returns The decompiled instruction, or "Invalid Instruction" if the instruction is invalid
	 */
	public getInstructionAt(address: number): string {
		if (address < 0 || address > 255) return "Invalid Instruction Pointer";
		const instruction = decompileInstruction(this._memory[address]);
		return instruction ? `${address} ${instruction}` : "Invalid Instruction";
	}

	/**
	 * Attempt to break the instruction at the given memory address into its components
	 * @param address The address of the instruction to parse. If this value is out of range, undefined is returned.
	 * 		If this value is undefined, the instruction at the current instruction pointer is parsed
	 * @returns The components of the instruction, or undefined if the instruction is invalid
	 */
	public getInstructionComponents(address: number = this.instructionPointer): ParsedHMMMInstructionComponents | undefined {
		// If the address is out of range, return undefined
		if(address < 0 || address > 255) return undefined;

		// Attempt to read and parse the instruction from memory
		const binaryInstruction = this._memory[address];

		return componentsOf(binaryInstruction);
	}

	//#endregion

	//#region Access Checks

	/**
	 * Determines the register/memory locations that will be read/written by the current instruction
	 * @returns An array of StateAccess objects representing the register/memory locations that will be read/written by the current instruction
	 */
	private determineAccesses(): StateAccess[] {
		// Attempt to read and parse the instruction from memory
		const parsedInstruction = this.getInstructionComponents();

		// If we failed to parse the instruction, we can't determine the accesses, so return an empty array
		if (!parsedInstruction) return [];

		const [binaryInstruction, instruction, rX, rY, rZ, N] = parsedInstruction;

		const accesses: StateAccess[] = [];

		// Determine the register/memory locations that will be read/written by executing the instruction
		// Although due to the way I've implemented breakpoints, it doesn't matter, we'll push the accesses in
		// the order that they would occur in the instruction execution so that exceptions/breakpoints are triggered in a consistent order
		switch (instruction.instruction.name) {
			case "halt":
			case "nop":
			case "jumpn":
				// These instructions don't read or write anything
				break;
			case "write":
			case "jumpr":
			case "jeqzn":
			case "jnezn":
			case "jgtzn":
			case "jltzn":
				// These instructions read from rX
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				break;
			case "read":
			case "setn":
			case "calln":
				// These instructions write to rX
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "loadn":
				// loadn reads from memory[N] and then writes to rX
				accesses.push({ address: N!, dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "loadr":
				// loadr reads from memory[rY] (and thus must read from rY) and then writes to rX
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "addn":
				// addn reads from rX and then writes to rX
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "add":
			case "sub":
			case "mul":
			case "div":
			case "mod":
				// These instructions read from rY and rZ and then write to rX
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: rZ!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "copy":
			case "neg":
				// These instructions read from rY and then write to rX
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "storen":
				// storen reads from rX and then writes to memory[N]
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: N!, dataType: "memory", accessType: "write" });
				break;
			case "storer":
				// storer reads from rX and then writes to memory[rY] (and thus must read from rY)
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "write" });
				break;
			case "popr":
				// popr reads from memory[rY] (and thus must read from rY) and then writes to rX and updates rY
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!] - 1, dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				accesses.push({ address: rY!, dataType: "register", accessType: "write" });
				break;
			case "pushr":
				// pushr reads from rX and then writes to memory[rY] (and thus must read from rY) and updates rY
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "write" });
				accesses.push({ address: rY!, dataType: "register", accessType: "write" });
				break;
		}

		// Return the list of accesses
		return accesses;
	}

	/**
	 * Checks an array of StateAccess objects against the set of enabled breakpoints/exceptions, sending a stop event if any are hit
	 * @param accesses The array of StateAccess objects to check. If not specified, the accesses will be determined from the current instruction (See determineAccesses)
	 * @returns true if a breakpoint/exception was hit (and execution should stop), false otherwise
	 */
	private checkAccesses(accesses?: StateAccess[]): boolean {
		// If no accesses were specified, determine them from the current instruction
		if (!accesses) accesses = this.determineAccesses();

		let hitBreakpoints: number[] = [];

		// For each access,
		for (const access of accesses) {
			// Determine if the access hits a breakpoint/exception
			if (access.dataType === "register") {
				// All breakpoints which can occur on registers can be masked by _ignoreBreakpoints
				if (this._ignoreBreakpoints) continue;

				if (access.accessType === "read" && this._registerReadBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._registerReadBreakpoints.get(access.address)!);
				}
				if (access.accessType === "write" && this._registerWriteBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._registerWriteBreakpoints.get(access.address)!);
				}
			} else {
				// Check for exceptions on memory accesses (these cannot be masked by _ignoreBreakpoints)

				// Throw an exception if the instruction attempts to access an invalid memory address
				if (access.address < 0 || access.address > 255) {
					const message = `Instruction at ${this.instructionPointer} attempted to access invalid memory address ${access.address}`;
					this.onException("invalid-memory-access", message, true);
					// This is a critical exception, so if it occurs, we always need to stop execution
					return true;
				}

				// Throw an exception if the instruction attempts to access the code segment
				if (access.address < this._numInstructions) {
					if (access.accessType === "read") {
						const message = `Instruction at ${this.instructionPointer} attempted to read from the code segment at address ${access.address}`;
						// Because this exception is non-critical, the exception handler may choose to ignore it
						// Only stop execution if the it does not
						if (this.onException("cs-read", message, false)) return true;
					} else if (access.accessType === "write") {
						const message = `Instruction at ${this.instructionPointer} attempted to write to the code segment at address ${access.address}`;
						// Because this exception is non-critical, the exception handler may choose to ignore it
						// Only stop execution if the it does not
						if (this.onException("cs-write", message, false)) return true;
					}
				}

				// The remaining breakpoints can be masked by _ignoreBreakpoints
				if (this._ignoreBreakpoints) continue;

				if (access.accessType === "read" && this._memoryReadBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._memoryReadBreakpoints.get(access.address)!);
				}
				if (access.accessType === "write" && this._memoryWriteBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._memoryWriteBreakpoints.get(access.address)!);
				}
			}
		}

		if (hitBreakpoints.length > 0) {
			// If we hit any breakpoints/exceptions, pause execution
			this.sendEvent('stopOnBreakpoint', 'data breakpoint', hitBreakpoints);
			return true;
		}

		// We didn't hit anything, so return false (continue execution)
		return false;
	}

	/**
	 * Checks for breakpoints/exceptions resulting from reading the current instruction from memory
	 * @returns true if a breakpoint/exception was hit (and execution should stop), false otherwise
	 */
	private checkInstructionExecutionAccess(): boolean {
		// Throw an exception if the instruction pointer is outside of the code segment
		if (this.instructionPointer >= this._numInstructions) {
			const message = `Attempted to execute an instruction outside of the code segment at address ${this.instructionPointer}`;
			// Because this exception is non-critical, the exception handler may choose to ignore it
			// Only stop execution if the it does not
			if (this.onException("execute-outside-cs", message, false)) {
				return true;
			}
		}

		// Throw an exception if the instruction pointer is out of range
		if (this.instructionPointer < 0 || this.instructionPointer > 255) {
			const message = `Instruction at ${this.instructionPointer} attempted to access invalid memory address ${this.instructionPointer}`;
			this.onException("invalid-memory-access", message, true);
			// This is a critical exception, so if it occurs, we always need to stop execution
			return true;
		}

		// Nothing paused execution, so return false (continue execution)
		return false;
	}

	//#endregion

	//#region Handler/Helper Methods

	/**
	 * Throws an exception indicating that an invalid instruction was encountered
	 */
	private onInvalidInstruction() {
		const message = `Invalid Instruction at Address ${this.instructionPointer}: 0x${this._memory[this.instructionPointer].toString(16).padStart(4, '0')}`;
		this.onException("invalid-instruction", message, true);
	}

	/**
	 * Throws an exception with the given id and description. If the exception is not enabled, it is ignored.
	 * Critical exceptions, however, are always thrown. If a critical exception is not enabled when it is thrown,
	 * a message is printed to stderr and execution is terminated.
	 * @param exception The id of the exception to throw
	 * @param description A description of the exception
	 * @param isCritical Whether or not the exception is critical (i.e. execution must stop if it occurs)
	 * @returns true if the exception was handled (and execution should stop), false otherwise
	 */
	private onException(exception: string, description: string, isCritical: boolean): boolean {
		// If the exception is not enabled, ignore it
		if (this._enabledExceptions.has(exception)) {
			// If the exception is not already in the list of ignored exceptions throw it, add it
			// (so that if the user opts to continue execution, it will not be thrown again)
			if (!this._ignoredExceptions.includes(exception) || isCritical) { // Critical exceptions should never be added to the hit breakpoints list, but just in case...
				// If the exception is non-critical, add it, ignore it in the future
				if (!isCritical) this._ignoredExceptions.push(exception);
				// Throw the exception and return true (stop execution)
				this._exception = exception;
				this._exceptionDescription = description;
				this.sendEvent('stopOnBreakpoint', 'exception', this._enabledExceptions.get(exception)!);
				return true;
			}
			// If the exception was ignored, do nothing and return false (continue execution)
			return false;
		}
		// If the exception is non-critical, return false (continue execution)
		if (!isCritical) return false;

		// Critical exceptions cannot be ignored. Print a message to stderr and terminate execution
		this.instructionOutput('stderr', description);
		this.sendEvent('end');

		// Return true (stop execution)
		return true;
	}

	/**
	 * Prints output from the machine to the debugger console
	 * @param category The category of the output (stdout or stderr)
	 * @param message The message to print
	 */
	private instructionOutput(category: "stdout" | "stderr", message: string) {
		const line = this._instructionToSourceMap.get(this.instructionPointer);
		this.sendEvent('output', message, category, line);
	}

	/**
	 * Prints output from the debugger to the debugger console
	 * @param message The message to print
	 */
	private debuggerOutput(message: string) {
		this.sendEvent('output', message, 'console', undefined);
	}

	/**
	 * Sends an event to the frontend
	 * @param event The name of the event to send
	 * @param args The arguments to pass to the event
	 */
	private sendEvent(event: string, ...args: any[]) {
		if (event === 'stop' || event === 'stopOnBreakpoint') {
			this._queuedInstructionExecution = undefined;
		}
		if (event === 'stopOnBreakpoint' || (args.length > 0 && args[0] === 'step')) {
			this._ignoreBreakpoints = true;
		}
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}

	//#endregion

}
