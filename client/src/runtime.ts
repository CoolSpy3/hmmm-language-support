// Modified from: https://github.com/microsoft/vscode-mock-debug/blob/668fa6f5db95dbb76825d4eb670ab0d305050c3b/src/mockRuntime.ts

import { Source, StackFrame } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { window, workspace } from 'vscode';
import { HMMMOperandType, ParsedHMMMInstruction, binaryRegex, compile, decompileInstruction, parseBinaryInstruction, preprocessLine } from '../../hmmm-spec/out/hmmm';
import { sliceWithCount } from './debugadapter';

interface ExecutedInstruction {
	address: number;
	oldData?: number;
	didCreateStackFrame: boolean;
}

interface HMMMState {
	instructionPointer: number;
	instruction: number;
	registers: number[];
	memory: number[];
	modifiedMemory: Set<number>;
}

/**
 * A HMMM runtime
 */
export class HMMMRuntime extends EventEmitter {

	// the initial (and one and only) file we are 'debugging'
	private _sourceFile: string | undefined = undefined;
	public get sourceFile() {
		return this._sourceFile;
	}

	private _source: Source | undefined;
	public get source() {
		return this._source;
	}

	// Keep track of the mappings between instruction numbers and source lines
	private _instructionToSourceMap = new Map<number, number>();
	private _sourceToInstructionMap = new Map<number, number>();

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	// The address of the current instruction being executed
	private _instructionPointer = 0;
	public get instructionPointer() {
		return this._instructionPointer;
	}

	// Current state of the Harvey Mudd Miniature Machine
	private _registers: number[] = Array(16).fill(0);
	public get registers() {
		return this._registers;
	}
	private _memory: number[] = Array(256).fill(0);
	public get memory() {
		return this._memory;
	}
	private _modifiedMemory = new Set<number>();
	public get modifiedMemory() {
		return this._modifiedMemory;
	}

	private _numInstructions = 0;
	public get numInstructions() {
		return this._numInstructions;
	}

	// maps from sourceFile to array of breakpoints
	private _sourceBreakpoints = new Map<string, DebugProtocol.Breakpoint[]>();

	// maps from instruction number to breakpoint ids
	private _breakpoints = new Map<number, number>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _breakAddresses = new Set<string>();

	private _stack = new Array<HMMMState>();
	private _stackEnabled = false;
	private _maxStackDepth: number = 0;

	private _instructionLog = new Array<ExecutedInstruction>();
	private _instructionLogEnabled = false;
	private _maxInstructionLogLength: number = 0;

	public setRegister(register: number, value: number) {
		if(register < 1 /* register 0 is always 0 */ || register > 15) return;
		this._registers[register] = value & 0xFFFF;
	}

	public setMemory(address: number, value: number) {
		if(address < 0 || address > 255) return;
		this._memory[address] = value & 0xFFFF;
		this._modifiedMemory.add(address);
	}

	/**
	 * Start executing the given program.
	 */
	public start(program: string, source: Source, stopOnEntry: boolean) {
		const debuggingSettings = workspace.getConfiguration("hmmm.debugging");
		this._stackEnabled = debuggingSettings.get<boolean>("enableReverseExecution", false);
		this._maxStackDepth = debuggingSettings.get<number>("reverseExecutionDepth", 0);
		this._instructionLogEnabled = debuggingSettings.get<boolean>("enableStackFrames", false);
		this._maxInstructionLogLength = debuggingSettings.get<number>("stackFrameDepth", 0);

		this._source = source;
		this.loadSource(program);
		this._instructionPointer = 0;

		this.verifyBreakpoints(this._sourceFile!);

		for(const path of this._sourceBreakpoints.keys()) {
			if(path !== this._sourceFile) this._sourceBreakpoints.delete(path);
		}

		for(const bp of this._sourceBreakpoints.get(this._sourceFile!) ?? []) {
			if(bp.verified) {
				if(this._sourceToInstructionMap.has(bp.line!)) {
					this._breakpoints.set(this._sourceToInstructionMap.get(bp.line!)!, bp.id!);
				} else {
					bp.verified = false;
					this.sendEvent('breakpointValidated', bp);
				}
			}
		}

		if (stopOnEntry) {
			// we jump to the first non empty line and stop there
			if(this._numInstructions > 0) {
				this.sendEvent('stopOnEntry');
			} else {
				// nothing to run
				this.sendEvent('end');
			}
		} else {
			// we just start to run until we hit a breakpoint
			this.continue();
		}
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		this.run(reverse, undefined);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, event = 'stopOnStep') {
		this.run(reverse, event);
	}

	/**
	 * Returns the stacktrace.
	 */
	public getStack(startFrame: number | undefined, levels: number | undefined): DebugProtocol.StackTraceResponse["body"] {
		const stack = sliceWithCount(this._stack, startFrame, levels).map((frame, idx) => {
			const decompiledInstruction = decompileInstruction(frame.instruction);
			const sf = new StackFrame(
				idx,
				decompiledInstruction ?? "Invalid Instruction!",
				this._instructionToSourceMap.has(frame.instructionPointer) ? this._source : undefined,
				this._instructionToSourceMap.get(frame.instructionPointer) ?? undefined
			);
			if(!decompiledInstruction) sf.presentationHint = "label";
			return sf;
		});

		const currentInstruction = new StackFrame(
			-1,
			this.getInstruction(this._instructionPointer),
			this._instructionToSourceMap.has(this._instructionPointer) ? this._source : undefined,
			this._instructionToSourceMap.get(this._instructionPointer) ?? undefined
		);
		currentInstruction.presentationHint = "subtle";

		stack.push(currentInstruction);

		return { stackFrames: stack, totalFrames: this._stack.length };
	}

	public goto(instruction: number) {
		this._instructionPointer = instruction - 1;
	}

	public getCurrentState(): HMMMState {
		return {
			instructionPointer: this._instructionPointer,
			instruction: this._memory[this._instructionPointer],
			registers: [...this._registers],
			memory: [...this._memory],
			modifiedMemory: new Set(this._modifiedMemory)
		};
	}

	public getStateAtFrame(idx: number): HMMMState | undefined {
		if(idx === 0) return this.getCurrentState();
		idx--; // The current instruction is always the 0th frame, so we need to offset the index by 1
		if(idx < 0 || idx >= this._stack.length) return undefined;
		return this._stack[idx];
	}

	public getInstruction(address: number): string {
		if(address < 0 || address > 255) return "Invalid Instruction Pointer!";
		return decompileInstruction(this._memory[address]) ?? "Invalid Instruction!";
	}

	public getValidInstructionLocations(path: string, startLine: number, endLine?: number): number[] {
		if(this._sourceFile && this._sourceFile !== path) return []; // We've finalized the source file, so don't bother with breakpoints in other files

		const isBinary = path.endsWith('.hb');

		if(!isBinary && !path.endsWith('.hmmm')) return [];

		const lines = readFileSync(path).toString().split('\n');

		startLine = Math.max(startLine, 0);
		endLine = endLine ? Math.min(endLine + 1, lines.length) : lines.length;

		const bps: number[] = [];

		for (let line = startLine; line < endLine; line++) {
			const lineText = lines[line];

			if(isBinary) {
				if(binaryRegex.test(lineText)) bps.push(line);
			} else {
				if(preprocessLine(lineText).trim()) bps.push(line);
			}
		}

		return bps;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakPoint(path: string, line: number) : DebugProtocol.Breakpoint {
		const bp: DebugProtocol.Breakpoint = { verified: false, line, id: this._breakpointId++ };

		if(this._sourceFile && this._sourceFile !== path) { // Only set breakpoints in the finalized source file (if it's been set)
			let bps = this._sourceBreakpoints.get(path);
			if (!bps) {
				bps = new Array<DebugProtocol.Breakpoint>();
				this._sourceBreakpoints.set(path, bps);
			}
			bps.push(bp);

			this.verifyBreakpoints(path);

			if(bp.verified) {
				this._breakpoints.set(this._sourceToInstructionMap.get(line)!, bp.id!);
			}
		}

		return bp;
	}

	/*
	 * Clear breakpoint in file with given line.
	 */
	public clearBreakPoint(path: string, line: number) : DebugProtocol.Breakpoint | undefined {
		if(this._sourceFile && this._sourceFile !== path) return; // We've finalized the source file, so don't bother with breakpoints in other files

		let bps = this._sourceBreakpoints.get(path);
		if (bps) {
			const index = bps.findIndex(bp => bp.line === line);
			if (index >= 0) {
				if(this._sourceFile) {
					this._breakpoints.delete(this._sourceToInstructionMap.get(line)!);
				}
				return bps.splice(index, 1)[0];
			}
		}
		return undefined;
	}

	/*
	 * Clear all breakpoints for file.
	 */
	public clearBreakpoints(path: string): void {
		if(this._sourceFile && this._sourceFile !== path) return; // We've finalized the source file, so don't bother with breakpoints in other files

		this._sourceBreakpoints.delete(path);
	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: string): boolean {
		if (address) {
			this._breakAddresses.add(address);
			return true;
		}
		return false;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._breakAddresses.clear();
	}

	/**
	 * Converts a signed 16-bit integer to a number.
	 * @param n The signed 16-bit integer to convert.
	 * @returns The converted number.
	 */
	public static s16IntToNumber(n: number): number {
		if(n > 32767) return n - 65536;
		return n;
	}

	public getCurrentInstruction() {
		return this.getInstructionAt(this._instructionPointer);
	}

	public getInstructionAt(address: number): [number, ParsedHMMMInstruction, number | undefined, number | undefined, number | undefined, number | undefined] | undefined {
		const binaryInstruction = this._memory[address];
		const instruction = parseBinaryInstruction(binaryInstruction);

		if(!instruction) return undefined;

		let rX: number | undefined = undefined;
		let rY: number | undefined = undefined;
		let rZ: number | undefined = undefined;
		let N: number | undefined = undefined;

		if(instruction.instruction.operand1 === HMMMOperandType.REGISTER) rX = instruction.operands[0].value;
		if(instruction.instruction.operand2 === HMMMOperandType.REGISTER) rY = instruction.operands[1].value;
		if(instruction.instruction.operand3 === HMMMOperandType.REGISTER) rZ = instruction.operands[2].value;

		if(instruction.instruction.operand1 === HMMMOperandType.SIGNED_NUMBER || instruction.instruction.operand1 === HMMMOperandType.UNSIGNED_NUMBER) N = instruction.operands[0].value;
		if(instruction.instruction.operand2 === HMMMOperandType.SIGNED_NUMBER || instruction.instruction.operand2 === HMMMOperandType.UNSIGNED_NUMBER) N = instruction.operands[1].value;

		return [binaryInstruction, instruction, rX, rY, rZ, N];
	}

	// private methods

	private loadSource(file: string) {
		this._sourceFile = file;
		this._sourceLines = readFileSync(this._sourceFile).toString().split('\n');

		const isBinary = file.endsWith('.hb');

		let code = this._sourceLines;
		if(!isBinary) {
			if(!file.endsWith('.hmmm')) return;

			const compiledCode = compile(code);

			if(!compiledCode) {
				window.showErrorMessage("HMMM File Contains Invalid Code! Please fix any errors/warnings and try again.");
				return;
			}

			[code, this._instructionToSourceMap] = compiledCode;

			for(const [instructionLine, sourceLine] of this._instructionToSourceMap) {
				this._sourceToInstructionMap.set(sourceLine, instructionLine);
			}
		}

		for(let i = 0; i < code.length; i++) {
			const line = code[i];

			if(!line.trim()) continue; // Skip empty lines

			if(isBinary) {
				this._instructionToSourceMap.set(this._numInstructions, i);
				this._sourceToInstructionMap.set(i, this._numInstructions);
			}

			this._numInstructions++;

			const encodedInstruction = parseInt(line.replaceAll(/\s/g, ''), 2);

			if(isNaN(encodedInstruction)) {
				window.showErrorMessage(`HMMM File Contains Invalid Code! HMMM Binary files can only contain 0s 1s and whitespace.`);
				return;
			}

			this._memory[i] = encodedInstruction;
		}
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepEvent?: string) {
		if (reverse) {
			if(!this._instructionLogEnabled) {
				window.showErrorMessage(`Reverse Execution is not enabled!`);
				this.sendEvent('end');
				return;
			}

			while (this._instructionLog.length > 0) {
				const instructionInfo = this._instructionLog.shift()!;
				this._instructionPointer = instructionInfo.address;

				const parsedInstruction = this.getCurrentInstruction();

				if(!parsedInstruction) {
					window.showErrorMessage(`Invalid Instruction at Address ${this._instructionPointer}: 0x${this._memory[this._instructionPointer].toString(16).padStart(4, '0')}!`);
					this.sendEvent('end');
					return;
				}

				const [_binaryInstruction, instruction, rX, rY, _rZ, N] = this.getCurrentInstruction()!;

				if(instructionInfo.didCreateStackFrame) {
					if(this._stack.length === 0) {
						window.showErrorMessage(`Stack Underflow!`);
						this.sendEvent('end');
						return;
					}
					this._stack.shift();
				}

				const oldData = instructionInfo.oldData;
				switch(instruction.instruction.name) {
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
						window.showErrorMessage(`Invalid Instruction at Address ${this._instructionPointer}: 0x${this._memory[this._instructionPointer].toString(16).padStart(4, '0')}!`);
						this.sendEvent('end');
						return;
				}
			}

			if(this._breakpoints.has(this._instructionPointer)) {
				this.sendEvent('stopOnBreakpoint');
				return;
			}

			if(stepEvent) {
				this.sendEvent(stepEvent);
				return;
			}

			// no more instructions
			this.sendEvent('stopOnEntry');
		} else {
			for (; this._instructionPointer <= 255; this._instructionPointer++) {
				if(this._breakpoints.has(this._instructionPointer)) {
					this.sendEvent('stopOnBreakpoint');
					return;
				}

				const parsedInstruction = this.getCurrentInstruction();

				if(!parsedInstruction) {
					window.showErrorMessage(`Invalid Instruction at Address ${this._instructionPointer}: 0x${this._memory[this._instructionPointer].toString(16).padStart(4, '0')}!`);
					this.sendEvent('end');
					return;
				}

				const [binaryInstruction, instruction, rX, rY, rZ, N] = this.getCurrentInstruction()!;

				let createStackFrame = false;
				let oldData: number | undefined = undefined;
				let nextInstructionPointer: number | undefined = undefined;

				switch(instruction.instruction.name) {
					case "halt":
						this.sendEvent('end');
						return;
					case "read":
					case "write":
					case "jumpr":
						nextInstructionPointer = this._registers[rX!];
						createStackFrame = true;
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
						createStackFrame = true;
						break;
					case "calln":
						oldData = this._registers[rX!];
						this.setRegister(rX!, this._instructionPointer + 1);
						nextInstructionPointer = N!;
						createStackFrame = true;
						break;
					case "jeqzn":
						if(this._registers[rX!] === 0) {
							nextInstructionPointer = N!;
							createStackFrame = true;
						}
						break;
					case "jnezn":
						if(this._registers[rX!] !== 0) {
							nextInstructionPointer = N!;
							createStackFrame = true;
						}
						break;
					case "jgtzn":
						if(this._registers[rX!] > 0) {
							nextInstructionPointer = N!;
							createStackFrame = true;
						}
						break;
					case "jltzn":
						if(this._registers[rX!] < 0) {
							nextInstructionPointer = N!;
							createStackFrame = true;
						}
						break;
					default:
						window.showErrorMessage(`Invalid Instruction at Address ${this._instructionPointer}: 0x${this._memory[this._instructionPointer].toString(16).padStart(4, '0')}!`);
						this.sendEvent('end');
						return;
				}

				if(createStackFrame && this._stackEnabled) {
					if(this._stack.length >= this._maxStackDepth) {
						window.showErrorMessage(`Stack Overflow!`);
						this._stack.pop();
					}
					this._stack.splice(0, 0, this.getCurrentState());
				}
				if(this._instructionLogEnabled) {
					if(this._instructionLog.length >= this._maxInstructionLogLength) {
						window.showErrorMessage(`Instruction Log Overflow!`);
						this._instructionLog.pop();
					}
					this._instructionLog.splice(0, 0, {
						address: this._instructionPointer,
						oldData: oldData,
						didCreateStackFrame: createStackFrame,
					});
				}
				if(nextInstructionPointer !== undefined) {
					this._instructionPointer = nextInstructionPointer - 1;
				}

				if(stepEvent) {
					this.sendEvent(stepEvent);
					return;
				}
			}
			// no more lines: run to end
			window.showErrorMessage(`Reached End of Memory!`);
			this.sendEvent('end');
		}
	}

	private verifyBreakpoints(path: string) : void {
		if(this._sourceFile && this._sourceFile !== path) return; // We've finalized the source file, so don't bother with breakpoints in other files

		let bps = this._sourceBreakpoints.get(path);
		if (bps) {
			const validLocations = this.getValidInstructionLocations(path, 0);

			bps.filter(bp => !bp.verified && validLocations.indexOf(bp.line!) !== -1).forEach(bp => bp.verified = true);
		}
	}

	private sendEvent(event: string, ... args: any[]) {
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}
