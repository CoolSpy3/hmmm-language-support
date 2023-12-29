// Modified from: https://github.com/microsoft/vscode-mock-debug/blob/668fa6f5db95dbb76825d4eb670ab0d305050c3b/src/mockRuntime.ts

import { StackFrame } from '@vscode/debugadapter';
import { DebugProtocol } from '@vscode/debugprotocol';
import { EventEmitter } from 'events';
import { readFileSync } from 'fs';
import { InputBoxOptions, window, workspace } from 'vscode';
import { HMMMOperandType, ParsedHMMMInstruction, binaryRegex, compile, decompileInstruction, parseBinaryInstruction, preprocessLine } from '../../hmmm-spec/out/hmmm';
import { sliceWithCount } from './debugadapter';

export interface ExecutedInstruction {
	id: number;
	address: number;
	oldData?: number;
	didCreateStackFrame: boolean;
}

export interface HMMMState {
	instructionPointer: number;
	instruction: number;
	registers: number[];
	memory: number[];
	modifiedMemory: Set<number>;
	lastExecutedInstructionId?: number;
}

interface StateAccess {
	address: number;
	dataType: "register" | "memory";
	accessType: "read" | "write";
}

/**
 * A HMMM runtime
 */
export class HMMMRuntime extends EventEmitter {

	private _language: "hb" | "hmmm" | undefined = undefined;

	// the contents (= lines) of the one and only file
	private _sourceLines: string[] = [];

	// Keep track of the mappings between instruction numbers and source lines
	private _instructionToSourceMap = new Map<number, number>();
	private _sourceToInstructionMap = new Map<number, number>();
	public getInstructionForSourceLine(line: number): number | undefined {
		return this._sourceToInstructionMap.get(line);
	}
	public getSourceLineForInstruction(instruction: number): number | undefined {
		return this._instructionToSourceMap.get(instruction);
	}

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

	// maps from instruction number to breakpoint ids
	private _instructionBreakpoints = new Map<number, number>();

	// since we want to send breakpoint events, we will assign an id to every event
	// so that the frontend can match events with breakpoints.
	private _breakpointId = 1;

	private _registerReadBreakpoints = new Map<number, number>();
	private _registerWriteBreakpoints = new Map<number, number>();
	private _memoryReadBreakpoints = new Map<number, number>();
	private _memoryWriteBreakpoints = new Map<number, number>();

	private _ignoreBreakpoints = false;
	private _ignoredExceptions: string[] = [];

	private _enabledExceptions = new Map<string, number>();
	private _exception: string = "";
	private _exceptionDescription: string = "";
	public getLastException(): [string, string] {
		return [this._exception, this._exceptionDescription];
	}

	private _stack = new Array<HMMMState>();
	private _stackEnabled = false;
	private _maxStackDepth: number = 0;
	private _hasSentStackDepthWarning = false;

	private _instructionId = 1;
	private _instructionLog = new Array<ExecutedInstruction>();
	private _instructionLogEnabled = false;
	private _maxInstructionLogLength: number = 0;
	private _hasSentInstructionLogLengthWarning = false;

	private _pause = false;
	public get paused() {
		return this._pause;
	}
	public pause() {
		this._pause = true;
	}

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
	 * Configures the runtime to execute the given program
	 */
	public configure(program: string, language: "hb" | "hmmm"): boolean {
		this._language = language

		const debuggingSettings = workspace.getConfiguration("hmmm.debugging");
		this._stackEnabled = debuggingSettings.get<boolean>("enableReverseExecution", false);
		this._maxStackDepth = debuggingSettings.get<number>("reverseExecutionDepth", 0);
		this._instructionLogEnabled = debuggingSettings.get<boolean>("enableStackFrames", false);
		this._maxInstructionLogLength = debuggingSettings.get<number>("stackFrameDepth", 0);

		this._instructionPointer = 0;
		return this.loadSource(program);
	}

	/**
	 * Continue execution to the end/beginning.
	 */
	public continue(reverse = false) {
		this.run(reverse);
	}

	/**
	 * Step to the next/previous non empty line.
	 */
	public step(reverse = false, stepInstruction: string = '') {
		this.run(reverse, stepInstruction);
	}

	/**
	 * Returns the stacktrace. The returned stack frames do not contain a source file. This is expected to be supplied by the debug adapter.
	 */
	public getStack(startFrame: number | undefined, levels: number | undefined): DebugProtocol.StackTraceResponse["body"] {
		startFrame = startFrame ?? 0;
		levels = levels ?? this._stack.length + 1;

		const sliceStart = Math.max(startFrame - 1, 0);

		const stack = sliceWithCount(this._stack, sliceStart, startFrame === 0 ? levels - 1 : levels).map((frame, idx) => {
			const decompiledInstruction = decompileInstruction(frame.instruction);
			return <StackFrame> {
				id: sliceStart + idx,
				name: decompiledInstruction ? `${frame.instructionPointer} ${decompiledInstruction}` : "Invalid Instruction",
				line: this._instructionToSourceMap.get(frame.instructionPointer) ?? -1,
				column: 0,
				presentationHint: decompiledInstruction ? "normal" : "label",
				canRestart: true
			};
		});

		if(startFrame === 0) {
			const currentInstruction = <StackFrame> {
				id: -1,
				name: this.getInstruction(this._instructionPointer),
				line: this._instructionToSourceMap.get(this._instructionPointer) ?? -1,
				column: 0,
				presentationHint: "subtle",
				canRestart: false
			};

			stack.splice(0, 0, currentInstruction);
		}

		return { stackFrames: stack, totalFrames: this._stack.length + 1 };
	}

	public restartFrame(frameId: number) {
		if(frameId === -1) {
			this.sendEvent('stop', 'restart');
			return;
		}
		const frame = this._stack[frameId];
		if(!frame) {
			this.sendEvent('stop', 'restart');
			return;
		}

		this._instructionPointer = frame.instructionPointer;
		this._registers = [...frame.registers];
		this._memory = [...frame.memory];
		this._modifiedMemory = new Set(frame.modifiedMemory);
		this._stack = this._stack.slice(0, frameId);
		if(frame.lastExecutedInstructionId) {
			while(this._instructionLog.length > 0 && this._instructionLog[0].id !== frame.lastExecutedInstructionId) {
				this._instructionLog.shift();
			}
		} else {
			this._instructionLog = [];
		}

		this.sendEvent('stop', 'restart');
	}

	public goto(instruction: number) {
		this.createStackFrame();
		this.updateInstructionLog(true);
		this._instructionPointer = instruction;
		this._ignoreBreakpoints = false;
		this._ignoredExceptions = [];
		this.sendEvent('stop', 'goto');
	}

	public getCurrentState(): HMMMState {
		return {
			instructionPointer: this._instructionPointer,
			instruction: this._memory[this._instructionPointer],
			registers: [...this._registers],
			memory: [...this._memory],
			modifiedMemory: new Set(this._modifiedMemory),
			lastExecutedInstructionId: this._instructionLog.length > 0 ? this._instructionLog[0].id : undefined,
		};
	}

	public getStateAtFrame(idx: number): HMMMState | undefined {
		if(idx === -1) return this.getCurrentState();
		if(idx < 0 || idx >= this._stack.length) return undefined;
		return this._stack[idx];
	}

	public getInstruction(address: number): string {
		if(address < 0 || address > 255) return "Invalid Instruction Pointer";
		const instruction = decompileInstruction(this._memory[address]);
		return instruction ? `${address} ${instruction}` : "Invalid Instruction";
	}

	public getValidInstructionLocations(startLine?: number, endLine?: number): number[] {
		startLine = Math.max(startLine ?? 0, 0);
		endLine = endLine ? Math.min(endLine, this._sourceLines.length - 1) : startLine;

		const validLines: number[] = [];

		for (let line = startLine; line <= endLine; line++) {
			const lineText = this._sourceLines[line];

			if(this._language === "hb") {
				if(binaryRegex.test(lineText)) validLines.push(line);
			} else {
				if(preprocessLine(lineText).trim()) validLines.push(line);
			}
		}

		return validLines;
	}

	/*
	 * Set breakpoint in file with given line.
	 */
	public setBreakpoint(line: number) : DebugProtocol.Breakpoint {
		const bp: DebugProtocol.Breakpoint = { id: this._breakpointId++, verified: false };

		if(this._sourceToInstructionMap.has(line)) {
			bp.verified = true;
			this._instructionBreakpoints.set(this._sourceToInstructionMap.get(line)!, bp.id!);
		}

		return bp;
	}

	/**
	 * Remove the breakpoint on the given line
	 */
	public clearBreakpoint(line: number): void {
		if(this._sourceToInstructionMap.has(line)) this._instructionBreakpoints.delete(this._sourceToInstructionMap.get(line)!);
	}

	/*
	 * Clear all breakpoints
	 */
	public clearBreakpoints(): void {
		this._instructionBreakpoints.clear();
	}

	/*
	 * Set data breakpoint.
	 */
	public setDataBreakpoint(address: number, type: "register" | "memory", onRead: boolean, onWrite: boolean): number {
		const id = this._breakpointId++;
		if(type === "register") {
			if(onRead) {
				this._registerReadBreakpoints.set(address, id);
			}
			if(onWrite) {
				this._registerWriteBreakpoints.set(address, id);
			}
		} else {
			if(onRead) {
				this._memoryReadBreakpoints.set(address, id);
			}
			if(onWrite) {
				this._memoryWriteBreakpoints.set(address, id);
			}
		}
		return id;
	}

	/*
	 * Clear all data breakpoints.
	 */
	public clearAllDataBreakpoints(): void {
		this._registerReadBreakpoints.clear();
		this._registerWriteBreakpoints.clear();
		this._memoryReadBreakpoints.clear();
		this._memoryWriteBreakpoints.clear();
	}

	public setExceptionBreakpoints(enabledExceptions: Array<string>): DebugProtocol.Breakpoint[] {
		const breakpoints = enabledExceptions.map((exception) => <DebugProtocol.Breakpoint> {
			id: this._breakpointId++,
			verified: true
		});

		this._enabledExceptions = new Map();
		breakpoints.forEach((bp, idx) => {
			this._enabledExceptions.set(enabledExceptions[idx], bp.id!);
		});

		return breakpoints;
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

	private determineAccesses(): StateAccess[] {
		const parsedInstruction = this.getCurrentInstruction();
		if(!parsedInstruction) return [];
		const [binaryInstruction, instruction, rX, rY, rZ, N] = parsedInstruction;

		const accesses: StateAccess[] = [];
		switch(instruction.instruction.name) {
			case "halt":
			case "nop":
			case "jumpn":
				break;
			case "write":
			case "jumpr":
			case "jeqzn":
			case "jnezn":
			case "jgtzn":
			case "jltzn":
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				break;
			case "read":
			case "setn":
			case "calln":
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "loadn":
				accesses.push({ address: N!, dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
			case "loadr":
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "addn":
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "add":
			case "sub":
			case "mul":
			case "div":
			case "mod":
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: rZ!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "copy":
			case "neg":
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				break;
			case "storen":
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: N!, dataType: "memory", accessType: "write" });
				break;
			case "storer":
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "write" });
				break;
			case "popr":
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!]-1, dataType: "memory", accessType: "read" });
				accesses.push({ address: rX!, dataType: "register", accessType: "write" });
				accesses.push({ address: rY!, dataType: "register", accessType: "write" });
				break;
			case "pushr":
				accesses.push({ address: rX!, dataType: "register", accessType: "read" });
				accesses.push({ address: rY!, dataType: "register", accessType: "read" });
				accesses.push({ address: this._registers[rY!], dataType: "memory", accessType: "write" });
				accesses.push({ address: rY!, dataType: "register", accessType: "write" });
				break;
		}

		return accesses;
	}

	private checkAccesses(accesses?: StateAccess[], ignoreNonCritical = false): boolean {
		if (!accesses) accesses = this.determineAccesses();

		if(!ignoreNonCritical && this._ignoreBreakpoints) {
			ignoreNonCritical = true;
			this._ignoreBreakpoints = false;
			this._ignoredExceptions = [];
		}

		let hitBreakpoints: number[] = [];
		for(const access of accesses) {
			if(access.dataType === "register") {
				if(ignoreNonCritical) continue;

				if(access.accessType === "read" && this._registerReadBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._registerReadBreakpoints.get(access.address)!);
				}
				if(access.accessType === "write" && this._registerWriteBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._registerWriteBreakpoints.get(access.address)!);
				}
			} else {
				if(access.address < 0 || access.address > 255) {
					const message = `Instruction at ${this._instructionPointer} attempted to access invalid memory address ${access.address}`;
					this.onException("invalid-memory-access", message, true);
					return true;
				}

				if(ignoreNonCritical) continue;

				if(access.address < this._numInstructions) {
					if(access.accessType === "read") {
						const message = `Instruction at ${this._instructionPointer} attempted to read from the code segment at address ${access.address}`;
						if(this.onException("cs-read", message, false)) return true;
					} else if(access.accessType === "write") {
						const message = `Instruction at ${this._instructionPointer} attempted to write to the code segment at address ${access.address}`;
						if(this.onException("cs-write", message, false)) return true;
					}
				}

				if(access.accessType === "read" && this._memoryReadBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._memoryReadBreakpoints.get(access.address)!);
				}
				if(access.accessType === "write" && this._memoryWriteBreakpoints.has(access.address)) {
					hitBreakpoints.push(this._memoryWriteBreakpoints.get(access.address)!);
				}
			}
		}

		if(hitBreakpoints.length > 0) {
			this.sendEvent('stopOnBreakpoint', 'data breakpoint', hitBreakpoints);
			return true;
		}

		return false;
	}

	private checkInstructionExecutionAccess(): boolean {
		if(this._instructionPointer < 0 || this._instructionPointer >= this._numInstructions) {
			if(this.onException("invalid-instruction-pointer", `Attempted to execute code at address ${this._instructionPointer} is outside of the code segment`, false)) {
				return true;
			}
		}

		if(this.checkAccesses([{ accessType: "read", address: this._instructionPointer, dataType: "memory" }], true)) {
			return true;
		}

		return false;
	}

	private loadSource(file: string): boolean {
		this._sourceLines = readFileSync(file).toString().split('\n');

		let code = this._sourceLines;
		if(this._language === "hmmm") {
			const compiledCode = compile(code);

			if(!compiledCode) return false;

			[code, this._instructionToSourceMap] = compiledCode;

			for(const [instructionLine, sourceLine] of this._instructionToSourceMap) {
				this._sourceToInstructionMap.set(sourceLine, instructionLine);
			}
		}

		for(let i = 0; i < code.length; i++) {
			const line = code[i];

			if(!line.trim()) continue; // Skip empty lines

			if(this._language === "hb") {
				this._instructionToSourceMap.set(this._numInstructions, i);
				this._sourceToInstructionMap.set(i, this._numInstructions);
			}

			this._numInstructions++;

			const encodedInstruction = parseInt(line.replaceAll(/\s/g, ''), 2);

			if(isNaN(encodedInstruction)) return false;

			this._memory[i] = encodedInstruction;
		}

		return true;
	}

	/**
	 * Run through the file.
	 * If stepEvent is specified only run a single step and emit the stepEvent.
	 */
	private run(reverse = false, stepInstruction?: string) {
		this._pause = false;

		if (reverse) {
			if(!this._instructionLogEnabled) {
				window.showErrorMessage(`Reverse Execution is not enabled`);
				this.sendEvent('end');
				return;
			}

			setImmediate(this.executeInstructionReverse.bind(this, stepInstruction));
		} else {
			setImmediate(this.executeInstruction.bind(this, stepInstruction));
		}
	}

	private async executeInstruction(stepInstruction?: string) {
		if(this._pause) {
			this.sendEvent('stop', 'pause');
			return;
		}

		if(this._instructionPointer >= this._numInstructions) {
			const message = `Attempted to execute an instruction outside of the code segment at address ${this._instructionPointer}`;
			this.onException("execute-outside-cs", message, false);
			return;
		}

		if(this._instructionBreakpoints.has(this._instructionPointer) && !this._ignoreBreakpoints) {
			this.sendEvent('stopOnBreakpoint', 'breakpoint', this._instructionBreakpoints.get(this._instructionPointer)!);
			return;
		}

		if(this.checkInstructionExecutionAccess()) return;

		const parsedInstruction = this.getCurrentInstruction();

		if(!parsedInstruction) {
			this.onInvalidInstruction();
			return;
		}

		if(this.checkAccesses()) return;

		const [binaryInstruction, instruction, rX, rY, rZ, N] = parsedInstruction;

		let createStackFrame = false;
		let oldData: number | undefined = undefined;
		let nextInstructionPointer: number | undefined = undefined;

		switch(instruction.instruction.name) {
			case "halt":
				this.sendEvent('end');
				return;
			case "read":
				oldData = this._registers[rX!];
				const input = parseInt(await window.showInputBox(<InputBoxOptions> {
					placeHolder: `Enter a number to store into r${rX}`,
					prompt: `You can also type any non-numerical text to terminate the program.`,
					title: `HMMM: ${this._instructionPointer} ${decompileInstruction(instruction)}`
				}) ?? '');
				if(isNaN(input)) {
					this.sendEvent('end');
					return;
				}
				this.setRegister(rX!, input);
				break;
			case "write":
				this.instructionOutput('stdout', HMMMRuntime.s16IntToNumber(this._registers[rX!]).toString());
				break;
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
				this.onInvalidInstruction();
				return;
		}

		if(createStackFrame) {
			this.createStackFrame();
		}
		this.updateInstructionLog(createStackFrame, oldData);
		if(nextInstructionPointer !== undefined) {
			this._instructionPointer = nextInstructionPointer;
		} else {
			this._instructionPointer++;
		}

		if(stepInstruction === '' || instruction.instruction.name === stepInstruction) {
			this.sendEvent('stop', 'step');
			return;
		}

		setImmediate(this.executeInstruction.bind(this, stepInstruction));
	}

	private executeInstructionReverse(stepInstruction?: string) {
		const instructionInfo = this._instructionLog.shift()!;
		this._instructionPointer = instructionInfo.address;

		const parsedInstruction = this.getCurrentInstruction();

		if(!parsedInstruction) {
			this.onInvalidInstruction();
			return;
		}

		const [_binaryInstruction, instruction, rX, rY, _rZ, N] = this.getCurrentInstruction()!;

		if(instructionInfo.didCreateStackFrame) {
			if(this._stack.length === 0) {
				this.debuggerOutput('WARNING: Stack Underflow');
			} else {
				this._stack.shift();
			}
		}

		const oldData = instructionInfo.oldData;
		if(oldData !== undefined) {
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

		if(this._instructionBreakpoints.has(this._instructionPointer) && !this._ignoreBreakpoints) {
			this.sendEvent('stopOnBreakpoint', 'breakpoint', this._instructionBreakpoints.get(this._instructionPointer)!);
			return;
		}

		if(this.checkAccesses()) return;

		if(stepInstruction === '' || instruction.instruction.name === stepInstruction) {
			this.sendEvent('stop', 'step');
			return;
		}

		if(this._pause) {
			this.sendEvent('stop', 'pause');
			return;
		}

		setImmediate(this.executeInstructionReverse.bind(this, stepInstruction));
	}

	private createStackFrame() {
		if(!this._stackEnabled) return;
		if(this._stack.length >= this._maxStackDepth) {
			this._stack.pop();
			if(!this._hasSentStackDepthWarning) {
				this._hasSentStackDepthWarning = true;
				this.debuggerOutput('WARNING: Stack Overflow');
			}
		}
		this._stack.splice(0, 0, this.getCurrentState());
	}

	private updateInstructionLog(didCreateStackFrame: boolean, oldData?: number) {
		if(!this._instructionLogEnabled) return;
		if(this._instructionLog.length >= this._maxInstructionLogLength) {
			this._instructionLog.pop();
			if(!this._hasSentInstructionLogLengthWarning) {
				this._hasSentInstructionLogLengthWarning = true;
				this.debuggerOutput('WARNING: Instruction Log Overflow');
			}
		}
		this._instructionLog.splice(0, 0, {
			id: this._instructionId++,
			address: this._instructionPointer,
			didCreateStackFrame: didCreateStackFrame && this._stackEnabled,
			oldData: oldData
		});
	}

	private onInvalidInstruction() {
		const message = `Invalid Instruction at Address ${this._instructionPointer}: 0x${this._memory[this._instructionPointer].toString(16).padStart(4, '0')}`;
		this.onException("invalid-instruction", message, true);
	}

	private onException(exception: string, description: string, isCritical: boolean): boolean {
		if(this._enabledExceptions.has(exception)) {
			if(!this._ignoredExceptions.includes(exception) || isCritical) { // Critical exceptions should never be added to the hit breakpoints list, but just in case...
				if(!isCritical) this._ignoredExceptions.push(exception);
				this._exception = exception;
				this._exceptionDescription = description;
				this.sendEvent('stopOnBreakpoint', 'exception', this._enabledExceptions.get(exception)!);
				return true;
			}
			return false;
		}
		if(!isCritical) return false;
		this.instructionOutput('stderr', description);
		this.sendEvent('end');
		return true;
	}

	private instructionOutput(category: "stdout" | "stderr", message: string) {
		const line = this._instructionToSourceMap.get(this._instructionPointer);
		this.sendEvent('output', message, category, line);
	}

	private debuggerOutput(message: string) {
		this.sendEvent('output', message, 'console', undefined);
	}

	private sendEvent(event: string, ... args: any[]) {
		if(event === 'stopOnBreakpoint' || (args.length > 0 && args[0] === 'step'))  {
			this._ignoreBreakpoints = true;
		}
		setImmediate(_ => {
			this.emit(event, ...args);
		});
	}
}
