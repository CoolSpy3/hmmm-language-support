//#region Instruction Definitions

/**
 * The type of an operand accepted by a HMMM instruction
 */
export type HMMMOperandType = 'register' | 'signed_number' | 'unsigned_number';

/**
 * A HMMM instruction definition
 */
export interface HMMMInstruction {
	/**
	 * The name of the instruction. This is the name the user will use to refer to the instruction
	 */
	name: string;
	/**
	 * The binary representation of the instruction with all arguments set to 0
	 */
	opcode: number;
	/**
	 * A bitmask for the opcode of the instruction (a number with all bits set to 1 except for the bits used for the operands)
	 */
	mask: number;
	/**
	 * The type of the first operand accepted by the instruction or undefined if the instruction does not accept a first operand
	 */
	operand1?: HMMMOperandType;
	/**
	 * The type of the second operand accepted by the instruction or undefined if the instruction does not accept a second operand
	 */
	operand2?: HMMMOperandType;
	/**
	 * The type of the third operand accepted by the instruction or undefined if the instruction does not accept a third operand.
	 * If this operand exists, it must be a register. Numbers are always 8 bits long, so they cannot be used as the third operand
	 */
	operand3?: HMMMOperandType;
	/**
	 * A human-readable description of the instruction
	 */
	description: string;
}

/**
 * A list of all HMMM instructions
 */
export let hmmmInstructions: HMMMInstruction[];

// Populate the list of instructions
{

	/**
	 * Gets the bitmask for the opcode of an instruction (the bits that are not used for the operands)
	 * @param instr The instruction to get the mask for
	 * @returns The mask for the instruction
	*/
	function getInstructionMask(instr: HMMMInstruction): number {
		// Start with a mask that has all 16 bits set to 1, and then remove bits based on the operands
		let mask = 0b1111_1111_1111_1111;

		// An operand is 4 bits long, so remove 4 bits for each operand
		if (instr.operand1 === 'register') {
			mask &= 0b1111_0000_1111_1111;
		}

		const hasNumericalArg = instr.operand1 === 'signed_number' || instr.operand1 === 'unsigned_number' || instr.operand2 === 'signed_number' || instr.operand2 === 'unsigned_number';

		// Except for numbers, which are 8 bits long
		if (instr.operand2 || hasNumericalArg) {
			mask &= 0b1111_1111_0000_1111;
		}

		if (instr.operand3 || hasNumericalArg) {
			mask &= 0b1111_1111_1111_0000;
		}

		return mask;
	}

	/**
	 * Creates a HMMM instruction from the given information, and calculates its mask
	 */
	function hmmmInstr(name: string, opcode: number, operand1: HMMMOperandType | undefined, operand2: HMMMOperandType | undefined, operand3: HMMMOperandType | undefined, description: string): HMMMInstruction {
		const instr = { name, opcode, mask: 0, operand1, operand2, operand3, description };
		instr.mask = getInstructionMask(instr);
		return instr;
	}

	// Define all instructions. This information is taken from the HMMM specification: https://www.cs.hmc.edu/~cs5grad/cs5/hmmm/documentation/documentation.html
	hmmmInstructions = [
		hmmmInstr("halt", 0b0000_0000_0000_0000, undefined, undefined, undefined, "Halt Program!"),
		hmmmInstr("read", 0b0000_0000_0000_0001, 'register', undefined, undefined, "Stop for user input, which will then be stored in register rX (input is an integer from -32768 to +32767)"),
		hmmmInstr("write", 0b0000_0000_0000_0010, 'register', undefined, undefined, "Print contents of register rX"),
		hmmmInstr("jumpr", 0b0000_0000_0000_0011, 'register', undefined, undefined, "Set program counter to address in rX"),
		hmmmInstr("setn", 0b0001_0000_0000_0000, 'register', 'signed_number', undefined, "Set register rX equal to the integer N (-128 to +127)"),
		hmmmInstr("loadn", 0b0010_0000_0000_0000, 'register', 'unsigned_number', undefined, "Load register rX with the contents of memory address N"),
		hmmmInstr("storen", 0b0011_0000_0000_0000, 'register', 'unsigned_number', undefined, "Store contents of register rX into memory address N"),
		hmmmInstr("loadr", 0b0100_0000_0000_0000, 'register', 'register', undefined, "Load register rX with the contents of memory address N"),
		hmmmInstr("storer", 0b0100_0000_0000_0001, 'register', 'register', undefined, "Store contents of register rX into memory address held in reg. rY"),
		hmmmInstr("popr", 0b0100_0000_0000_0010, 'register', 'register', undefined, "Load contents of register rX from stack pointed to by reg. rY"),
		hmmmInstr("pushr", 0b0100_0000_0000_0011, 'register', 'register', undefined, "Store contents of register rX onto stack pointed to by reg. rY"),
		hmmmInstr("addn", 0b0101_0000_0000_0000, 'register', 'signed_number', undefined, "Add integer N (-128 to 127) to register rX"),
		hmmmInstr("nop", 0b0110_0000_0000_0000, undefined, undefined, undefined, "Do nothing"),
		hmmmInstr("copy", 0b0110_0000_0000_0000, 'register', 'register', undefined, "Set rX = rY"),
		hmmmInstr("add", 0b0110_0000_0000_0000, 'register', 'register', 'register', "Set rX = rY + rZ"),
		hmmmInstr("neg", 0b0111_0000_0000_0000, 'register', 'register', undefined, "Set rX = -rY"),
		hmmmInstr("sub", 0b0111_0000_0000_0000, 'register', 'register', 'register', "Set rX = rY - rZ"),
		hmmmInstr("mul", 0b1000_0000_0000_0000, 'register', 'register', 'register', "Set rx = rY * rZ"),
		hmmmInstr("div", 0b1001_0000_0000_0000, 'register', 'register', 'register', "Set rX = rY // rZ (integer division; rounds down; no remainder)"),
		hmmmInstr("mod", 0b1010_0000_0000_0000, 'register', 'register', 'register', "Set rX = rY % rZ (returns the remainder of integer division)"),
		hmmmInstr("jumpn", 0b1011_0000_0000_0000, 'unsigned_number', undefined, undefined, "Set program counter to address N"),
		hmmmInstr("calln", 0b1011_0000_0000_0000, 'register', 'unsigned_number', undefined, "Copy addr. of next instr. into rX and then jump to mem. addr. N"),
		hmmmInstr("jeqzn", 0b1100_0000_0000_0000, 'register', 'unsigned_number', undefined, "If rX == 0, then jump to line N"),
		hmmmInstr("jnezn", 0b1101_0000_0000_0000, 'register', 'unsigned_number', undefined, "If rX != 0, then jump to line N"),
		hmmmInstr("jgtzn", 0b1110_0000_0000_0000, 'register', 'unsigned_number', undefined, "If rX > 0, then jump to line N"),
		hmmmInstr("jltzn", 0b1111_0000_0000_0000, 'register', 'unsigned_number', undefined, "If rX < 0, then jump to line N"),
	];
}

/**
 * A map of instruction aliases to their actual names.
 * This map contains the aliases that are defined in the HMMM specification: https://www.cs.hmc.edu/~cs5grad/cs5/hmmm/documentation/documentation.html
 */
export let hmmmAliases = new Map<string, string>([
	["mov", "copy"],
	["jump", "jumpr"],
	["jeqz", "jeqzn"],
	["jnez", "jnezn"],
	["jgtz", "jgtzn"],
	["jltz", "jltzn"],
	["call", "calln"],
	["loadi", "loadr"],
	["load", "loadr"],
	["storei", "storer"],
	["store", "storer"]
]);

/**
 * Retrieves the instruction definition for the instruction with the given name or alias
 * @param name The name of the instruction to get
 * @returns The instruction definition or undefined if the instruction does not exist
 */
export function getInstructionByName(name: string): HMMMInstruction | undefined {
	if (hmmmAliases.has(name)) name = hmmmAliases.get(name)!; // Get the instruction name from the alias map if it exists (otherwise use the original name)
	return hmmmInstructions.find(instr => instr.name === name);
}

/**
 * Gets the operand signature of an instruction (the types of operands it accepts as a user-friendly string).
 * Ex. "rX N" for the setn instruction
 * @param instr The instruction to get the signature of
 * @returns The signature of the instruction
 */
export function getInstructionSignature(instr: HMMMInstruction): string {
	let sig = '';

	if (instr.operand1) {
		sig += `${instr.operand1 === 'register' ? 'rX' : 'N'}`;
	}

	if (instr.operand2) {
		sig += ` ${instr.operand2 === 'register' ? 'rY' : 'N'}`;
	}

	if (instr.operand3) {
		sig += ` ${instr.operand3 === 'register' ? 'rZ' : 'N'}`;
	}

	return sig;
}

/**
 * Gets the binary representation of an instruction
 * @param instr The instruction to get the representation of
 * @returns The binary representation of the instruction
 */
export function getInstructionRepresentation(instr: HMMMInstruction): string {
	// Convert the instruction from a binary number to a binary string
	let rep = (instr.opcode >>> 0).toString(2).padStart(16, '0'); // https://stackoverflow.com/a/16155417

	// Add spaces every 4 characters to make it easier to read
	rep = rep.match(/.{4}/g)?.join(' ') ?? rep; // https://stackoverflow.com/a/53427113
	rep = rep.padEnd(19, ' '); // Shouldn't be necessary, but just in case

	if (instr.operand1) {
		if (instr.operand1 === 'register') {
			rep = `${rep.substring(0, 4)} XXXX ${rep.substring(10)}`;
		} else {
			rep = `${rep.substring(0, 9)} NNNN NNNN`;
		}
	}

	if (instr.operand2) {
		if (instr.operand2 === 'register') {
			rep = `${rep.substring(0, 9)} YYYY ${rep.substring(15)}`;
		} else {
			rep = `${rep.substring(0, 9)} NNNN NNNN`;
		}
	}

	if (instr.operand3) {
		if (instr.operand3 === 'register') {
			rep = `${rep.substring(0, 14)} ZZZZ`;
		} else {
			// All numbers are represented with 8 bits, so the third argument cannot be a number
			console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
		}
	}

	return rep;
}

//#endregion

//#region Text Processing

//#region Assembly

/**
 * A regular expression that matches a single HMMM "operand" (this is actually used for all parts of the instruction [line number/instruction name/operands])
 */
const operandRegex = /(?:(\S+)(?:\s+|$))?/gm;
/**
 * A modified version of the operand regex that matches the last "operand" in a line
 */
const lastOperandRegex = /(?:(\S+)\s*)?/gm;
/**
 * A regular expression that matches a single HMMM instruction. It contains the following capture groups:
 * 1. The line number
 * 2. The instruction name
 * 3. The first operand
 * 4. The second operand
 * 5. The third operand
 * 6. Any other text on the line
 *
 * These groups can be accessed using the InstructionPart enum
 */
export const instructionRegex = RegExp(`^\\s*${operandRegex.source}${operandRegex.source}${operandRegex.source}${operandRegex.source}${lastOperandRegex.source}(?:\\s+(.+))?$`, 'md');

/**
 * Defines parts of an instruction that are matched by the instruction regex
 */
export enum InstructionPart {
	FULL_LINE = 0,
	LINE_NUM = 1,
	INSTRUCTION = 2,
	OPERAND1 = 3,
	OPERAND2 = 4,
	OPERAND3 = 5,
	/**
	 * Any text on the line after the 3rd operand
	 */
	OTHER = 6,
}

/**
 * Preprocesses a line of HMMM code by removing comments and trimming trailing whitespace
 * @param line The line to preprocess
 * @returns The preprocessed line
 */
export function preprocessLine(line: string) {
	return line.split('#')[0].trimEnd();
}

//#endregion

//#region Binary

/**
 * A regular expression that matches a binary string containing 4 nibbles optionally separated/surrounded by spaces
 */
export const binaryRegex = /^\s*([01]{4})\s*([01]{4})\s*([01]{4})\s*([01]{4})/d;

/**
 * Formats a binary number by adding spaces every 4 characters, padding it to 16 bits, and trimming any extra whitespace
 * @param line The binary number to format
 * @returns The formatted binary number
 */
export function formatBinaryNumber(line: string): string {
	return line.padStart(16, '0').replace(binaryRegex, "$1 $2 $3 $4");
}

//#endregion

//#endregion

//#region Compilation / Parsing

/**
 * The type of an operand detected by the HMMM assembler (see {@link validateOperand}).
 * Most of these types are self explanatory, but here is a quick overview:
 * - r0: The operand is r0
 * - register: The operand is a register (r1-r15)
 * - invalid_register: The operand is a register, but it is not a valid register (r16+)
 * - number: The operand is a number that can be represented as either a signed or unsigned number
 * - signed_number: The operand is a number that can only be represented as a signed number
 * - unsigned_number: The operand is a number that can only be represented as an unsigned number
 * - invalid_number: The operand is a number, but it is not a valid number (out of range)
 */
export type HMMMDetectedOperandType = 'r0' | 'register' | 'invalid_register' | 'number' | 'signed_number' | 'unsigned_number' | 'invalid_number';

/**
 * Determines the type of an operand
 * @param operand The string to check
 * @returns The detected operand type or undefined if the operand is invalid
 */
export function validateOperand(operand: string | undefined): HMMMDetectedOperandType | undefined {
	// If the operand is undefined, it is invalid
	if (!operand) return undefined;

	if (operand === 'r0' || operand === 'R0') return 'r0'; // Test for r0 separately. It might be useful to be able to distinguish it later

	// Check if the argument is a register
	if (/^r\d+$/i.test(operand)) {
		if (/^r(\d|1[0-5])$/i.test(operand)) return 'register'; // r0-r15
		return 'invalid_register'; // r16+
	}

	// Test if the argument is a number
	const num = strictParseInt(operand);

	if (isNaN(num)) return undefined; // Not a number

	if (num < -128 || num > 255) return 'invalid_number'; // Out of range of what can be represented in HMMM binary
	if (num < 0) return 'signed_number'; // Can be represented as a signed number
	if (num > 127) return 'unsigned_number'; // Can be represented as an unsigned number
	return 'number'; // Can be represented as either a signed or unsigned number
}

/**
 * Represents an operand parsed as part of a {@link ParsedHMMMInstruction}
 */
export interface ParsedHMMMOperand {
	type: HMMMOperandType;
	value: number;
}

/**
 * Represents the result of parsing a HMMM instruction
 */
export interface ParsedHMMMInstruction {
	/**
	 * The instruction definition of the instruction that was parsed
	 */
	instruction: HMMMInstruction;
	/**
	 * The operands passed to the instruction
	 */
	operands: ParsedHMMMOperand[];
}

/**
 * Parses an instruction from its binary representation
 * @param instruction The line to parse
 * @returns The parsed instruction
 */
export function parseBinaryInstruction(instruction: string | number): ParsedHMMMInstruction | undefined {
	let binaryInstruction: number;
	// Convert the instruction to a number if it is a string
	if (typeof instruction === 'string') {
		// Remove all whitespace from the line and ensure it only contains binary
		instruction = instruction.replace(/[^01]/g, '');

		if (instruction.length !== 16) return undefined; // Invalid instruction! It should be exactly 16 bits long

		// Convert the binary string to a number
		binaryInstruction = strictParseInt(instruction, 2);
	} else {
		// If the instruction is already a number, just use it as-is
		binaryInstruction = instruction;
	}

	// Get all instruction definitions that match the instruction
	// A definition matches if all the bits that are 1 in the mask are the same in the opcode and the instruction
	const instructions = hmmmInstructions.filter(instr => ((instr.opcode ^ binaryInstruction) & instr.mask) === 0);

	if (!instructions.length) return undefined; // No results; invalid instruction!

	// Some instructions can have synonymous encodings (e.x. jumpn N and calln r0 N)
	// If multiple instructions match, use the one with the larger mask.
	// This ensures that the instruction with the most specific operands is used
	// (While this is not necessarily true by default, I believe it is true for all
	// instructions in the HMMM specification)
	const instr = instructions.sort((instr1, instr2) => -(instr1.mask - instr2.mask))[0]; // negate the result so it sorts in descending order

	// Get the operands
	const operands: ParsedHMMMOperand[] = [];

	/**
	 * Parses an operand from its binary representation
	 * @param operandType The type of the operand
	 * @param operandShift The number of bits to the right of the operand in the binary representation of the instruction
	 * @returns The parsed operand
	 */
	function parseOperand(operandType: HMMMOperandType, operandShift: number): ParsedHMMMOperand {
		switch (operandType) {
			case 'register':
				return { type: 'register', value: (binaryInstruction >> operandShift) & 0b1111 };
			case 'signed_number':
				return { type: 'signed_number', value: s8IntToNumber(binaryInstruction & 0b1111_1111) };
			case 'unsigned_number':
				return { type: 'unsigned_number', value: binaryInstruction & 0b1111_1111 };
		}
	}

	if (instr.operand1) {
		operands.push(parseOperand(instr.operand1, 8));
	}

	if (instr.operand2) {
		operands.push(parseOperand(instr.operand2, 4));
	}

	if (instr.operand3) {
		if (instr.operand3 === 'signed_number' || instr.operand3 === 'unsigned_number') {
			// All numbers are represented with 8 bits, so the third argument cannot be a number
			console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
			return undefined;
		}

		operands.push(parseOperand(instr.operand3, 0));
	}

	return { instruction: instr, operands: operands };
}

/**
 * Compiles HMMM code to binary
 * @param code The code to compile
 * @returns The compiled code and a map of instruction numbers to source line numbers or undefined if the code is invalid
 */
export function compile(code: string[]): [string[], Map<number, number>] | undefined {
	const compiledCode: string[] = [];
	const lineMap = new Map<number, number>();

	// Keep track of the number of lines of code we've encountered
	let numCodeLines = 0;

	for (let i = 0; i < code.length; i++) {
		// Preprocess each line
		const line = preprocessLine(code[i]).trim();

		if (!line) continue; // Skip empty lines

		// Try to parse the instruction
		let m: RegExpExecArray | null;
		if (!(m = instructionRegex.exec(line)) || m[InstructionPart.OTHER]) return undefined; // Invalid instruction!

		// Validate the line number
		if (strictParseInt(m[InstructionPart.LINE_NUM]) !== numCodeLines) return undefined; // Invalid line number!

		// Add the line number to the line map and increment the number of code lines
		lineMap.set(numCodeLines++, i);

		// Get the instruction definition
		const instr = getInstructionByName(m[InstructionPart.INSTRUCTION]);

		if (!instr) return undefined; // Invalid instruction!

		// By default the binary representation of the instruction is just the opcode
		let binary = instr.opcode;

		// Now we add the operands to the binary representation

		/**
		 * Converts an operand into its binary representation
		 * @param operandType The expected type of the operand
		 * @param stringValue The string representation of the operand
		 * @param operandShift The number of bits to the right of the operand in the binary representation of the instruction
		 * @returns The binary representation of the operand or undefined if the operand is invalid
		 */
		function compileOperand(operandType: HMMMOperandType | undefined, stringValue: string | undefined, operandShift: number): number | undefined {
			// Attempt to detect the type of the operand
			const operand = validateOperand(stringValue);

			if (operand === undefined) return undefined; // Invalid operand!

			switch(operandType) {
				case 'register':
					if (!(operand === 'r0' || operand === 'register')) return undefined; // Invalid operand!
					return strictParseInt(stringValue!.slice(1)) << operandShift;
				case 'signed_number':
					if (!(operand === 'signed_number' || operand === 'number')) return undefined; // Invalid operand!
					// Performing the bitwise AND automatically converts the number to 2's complement if it is negative
					return strictParseInt(stringValue!) & 0b1111_1111;
				case 'unsigned_number':
					if (!(operand === 'unsigned_number' || operand === 'number')) return undefined; // Invalid operand!
					return strictParseInt(stringValue!) & 0b1111_1111;
			}
		}

		if(instr.operand1) {
			const operand = compileOperand(instr.operand1, m[InstructionPart.OPERAND1], 8);

			if (operand === undefined) return undefined; // Invalid operand!

			binary |= operand;
		} else if (m[InstructionPart.OPERAND1]) return undefined; // An operand was provided, but the instruction does not accept an operand!

		if(instr.operand2) {
			const operand = compileOperand(instr.operand2, m[InstructionPart.OPERAND2], 4);

			if (operand === undefined) return undefined; // Invalid operand!

			binary |= operand;
		} else if (m[InstructionPart.OPERAND2]) return undefined; // An operand was provided, but the instruction does not accept an operand!

		if(instr.operand3) {
			if(instr.operand3 === 'signed_number' || instr.operand3 === 'unsigned_number') {
				// All numbers are represented with 8 bits, so the third argument cannot be a number
				console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
				return undefined;
			}

			const operand = compileOperand(instr.operand3, m[InstructionPart.OPERAND3], 0);

			if (operand === undefined) return undefined; // Invalid operand!

			binary |= operand;
		} else if (m[InstructionPart.OPERAND3]) return undefined; // An operand was provided, but the instruction does not accept an operand!

		// Add the binary representation of the instruction to the output
		compiledCode.push(formatBinaryNumber(binary.toString(2)));
	}

	return [compiledCode, lineMap];
}

//#endregion

/**
 * The result of breaking a {@link ParsedHMMMInstruction} into its components. This is a tuple containing,
 * 1. the numerical value of the compiled instruction,
 * 2. A ParsedHMMMInstruction object
 * 3. The register identified by the second nibble (first operand) of the instruction or undefined if the instruction does not have a register as its first argument
 * 4. The register identified by the third nibble (second operand) of the instruction or undefined if the instruction does not have a register as its second argument
 * 5. The register identified by the fourth nibble (third operand) of the instruction or undefined if the instruction does not have a register as its third argument
 * 6. The numerical value (correctly parsed as either signed or unsigned) of the first/second argument of the instruction or undefined if the instruction does not have a numerical value as an argument
 */
export type ParsedHMMMInstructionComponents = [number, ParsedHMMMInstruction, number | undefined, number | undefined, number | undefined, number | undefined];

/**
 * Attempt to break the binary representation of an instruction into its component parts
 * @param binaryInstruction The binary representation of the instruction to break apart
 * @returns The components of the instruction or undefined if the instruction is invalid
 */
export function componentsOf(binaryInstruction: number): ParsedHMMMInstructionComponents | undefined {
	const instruction = parseBinaryInstruction(binaryInstruction);

	// If the instruction is invalid, return undefined
	if (!instruction) return undefined;

	// By default, all arguments to the instruction are undefined
	let rX: number | undefined = undefined;
	let rY: number | undefined = undefined;
	let rZ: number | undefined = undefined;
	let N: number | undefined = undefined;

	// Retrieve the values from the ParsedHMMMInstruction and store them in the appropriate variables based on their type

	if (instruction.instruction.operand1 === 'register') rX = instruction.operands[0].value;
	if (instruction.instruction.operand2 === 'register') rY = instruction.operands[1].value;
	if (instruction.instruction.operand3 === 'register') rZ = instruction.operands[2].value;

	if (instruction.instruction.operand1 === 'signed_number' || instruction.instruction.operand1 === 'unsigned_number') N = instruction.operands[0].value;
	if (instruction.instruction.operand2 === 'signed_number' || instruction.instruction.operand2 === 'unsigned_number') N = instruction.operands[1].value;

	// Return the parsed instruction
	return [binaryInstruction, instruction, rX, rY, rZ, N];
}

/**
 * Decompiles an instruction to HMMM code
 * @param instruction The instruction to decompile
 * @returns The decompiled instruction
 */
export function decompileInstruction(instruction: string | number | ParsedHMMMInstruction): string | undefined {
	// If the instruction is not already parsed, parse it
	if (typeof instruction === 'string' || typeof instruction === 'number') {
		const parsedInstruction = parseBinaryInstruction(instruction);

		if (!parsedInstruction) return undefined;

		instruction = parsedInstruction;
	}
	// Convert the parsed instruction to a string
	// A quick overview of the different parts of the format:
	// 1. The instruction name
	// 2. A space to separate the instruction name from the operands (if necessary)
	// 3. Convert each operand to a string (r[number] for registers, otherwise just the number) and join them with spaces
	return `${instruction.instruction.name}${instruction.operands.length !== 0 ? ' ' : ''}${instruction.operands.map(operand => `${operand.type === 'register' ? 'r' : ''}${operand.value}`).join(' ')}`;
}

//#region Helper Functions

/**
 * An implementation of parseInt that returns NaN if any characters are not part of the number
 * @param value The string to parse
 * @param radix The radix to use when parsing the number. Defaults to 10 (or 16 if the string starts with 0x)
 * @returns The parsed number or NaN if the string is not a valid number
 */
export function strictParseInt(value: string | undefined, radix?: number): number {
	if(value === undefined) return NaN;
	value = value.trim();
	if(/^-?\d+$/.test(value)) return parseInt(value, radix);
	return NaN;
}

/**
 * Converts an unsigned 8-bit integer to a signed number.
 * @param n The unsigned 8-bit integer to convert.
 * @returns The signed number.
 */
export function s8IntToNumber(n: number): number {
	if (n > 127) return n - 256
	return n;
}

//#endregion
