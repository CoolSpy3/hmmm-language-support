export enum HMMMOperandType {
    REGISTER = 1, // Without the =1, TypeScript is unhappy
    SIGNED_NUMBER,
    UNSIGNED_NUMBER
}

export type HMMMOperand = HMMMOperandType | undefined;

export interface HMMMInstruction {
    name: string;
    opcode: number;
    mask: number;
    operand1: HMMMOperand;
    operand2: HMMMOperand;
    operand3: HMMMOperand;
    description: string;
}

export let hmmmInstructions: HMMMInstruction[];

{
    function hmmmInstr(name: string, opcode: number, operand1: HMMMOperand, operand2: HMMMOperand, operand3: HMMMOperand, description: string): HMMMInstruction {
        const instr = { name, opcode, mask: 0, operand1, operand2, operand3, description };
        instr.mask = getInstructionMask(instr);
        return instr;
    }

    hmmmInstructions = [
        hmmmInstr("halt", 0b0000_0000_0000_0000, undefined, undefined, undefined, "Halt Program!"),
        hmmmInstr("read", 0b0000_0000_0000_0001, HMMMOperandType.REGISTER, undefined, undefined, "Stop for user input, which will then be stored in register rX (input is an integer from -32768 to +32767)"),
        hmmmInstr("write", 0b0000_0000_0000_0010, HMMMOperandType.REGISTER, undefined, undefined, "Print contents of register rX"),
        hmmmInstr("jumpr", 0b0000_0000_0000_0011, HMMMOperandType.REGISTER, undefined, undefined, "Set program counter to address in rX"),
        hmmmInstr("setn", 0b0001_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.SIGNED_NUMBER, undefined, "Set register rX equal to the integer N (-128 to +127)"),
        hmmmInstr("loadn", 0b0010_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "Load register rX with the contents of memory address N"),
        hmmmInstr("storen", 0b0011_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "Store contents of register rX into memory address N"),
        hmmmInstr("loadr", 0b0100_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Load register rX with the contents of memory address N"),
        hmmmInstr("storer", 0b0100_0000_0000_0001, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Store contents of register rX into memory address held in reg. rY"),
        hmmmInstr("popr", 0b0100_0000_0000_0010, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Load contents of register rX from stack pointed to by reg. rY"),
        hmmmInstr("pushr", 0b0100_0000_0000_0011, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Store contents of register rX onto stack pointed to by reg. rY"),
        hmmmInstr("addn", 0b0101_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.SIGNED_NUMBER, undefined, "Add integer N (-128 to 127) to register rX"),
        hmmmInstr("nop", 0b0110_0000_0000_0000, undefined, undefined, undefined, "Do nothing"),
        hmmmInstr("copy", 0b0110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Set rX = rY"),
        hmmmInstr("add", 0b0110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, "Set rX = rY + rZ"),
        hmmmInstr("neg", 0b0111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, undefined, "Set rX = -rY"),
        hmmmInstr("sub", 0b0111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, "Set rX = rY - rZ"),
        hmmmInstr("mul", 0b1000_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, "Set rx = rY * rZ"),
        hmmmInstr("div", 0b1001_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, "Set rX = rY // rZ (integer division; rounds down; no remainder)"),
        hmmmInstr("mod", 0b1010_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER, "Set rX = rY % rZ (returns the remainder of integer division)"),
        hmmmInstr("jumpn", 0b1011_0000_0000_0000, HMMMOperandType.UNSIGNED_NUMBER, undefined, undefined, "Set program counter to address N"),
        hmmmInstr("calln", 0b1011_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "Copy addr. of next instr. into rX and then jump to mem. addr. N"),
        hmmmInstr("jeqzn", 0b1100_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX == 0, then jump to line N"),
        hmmmInstr("jnezn", 0b1101_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX != 0, then jump to line N"),
        hmmmInstr("jgtzn", 0b1110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX > 0, then jump to line N"),
        hmmmInstr("jltzn", 0b1111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX < 0, then jump to line N"),
    ];
}

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

export function getInstructionByName(name: string): HMMMInstruction | undefined {
    if(hmmmAliases.has(name)) name = hmmmAliases.get(name)!; // Get the instruction name from the alias map if it exists (otherwise use the original name
    return hmmmInstructions.find(instr => instr.name === name);
}

const operandRegex = /(?:(\S+)(?:\s+|$))?/gm;
const lastOperandRegex = /(?:(\S+)\s*)?/gm;
export const instructionRegex = RegExp(`^\\s*${operandRegex.source}${operandRegex.source}${operandRegex.source}${operandRegex.source}${lastOperandRegex.source}(?:\\s+(.+))?$`, 'md');

export enum InstructionPart {
    FULL_LINE = 0,
    LINE_NUM = 1,
    INSTRUCTION = 2,
    OPERAND1 = 3,
    OPERAND2 = 4,
    OPERAND3 = 5,
    OTHER = 6,
}

export enum HMMMDetectedOperandType {
    R0,
    REGISTER,
    INVALID_REGISTER,
    NUMBER,
    SIGNED_NUMBER,
    UNSIGNED_NUMBER,
    INVALID_NUMBER
}

export type HMMMDetectedOperand = HMMMDetectedOperandType | undefined;

/**
 * Determines the type of an operand
 * @param operand The string to check
 * @returns The detected operand type or undefined if the operand is invalid
 */
export function validateOperand(operand: string): HMMMDetectedOperand {
    if (!operand) return undefined;

    if (/^r0$/i.test(operand)) return HMMMDetectedOperandType.R0; // Test for r0 separately. It might be useful to be able to distinguish it later

    // Check if the argument is a register
    if (/^r\d+$/i.test(operand)) {
        if (/^r(\d|1[0-5])$/i.test(operand)) return HMMMDetectedOperandType.REGISTER; // r0-r15
        return HMMMDetectedOperandType.INVALID_REGISTER; // r16+
    }

    // Test if the argument is a number
    const num = parseInt(operand);

    if (isNaN(num)) return undefined; // Not a number

    if (num < -128 || num > 255) return HMMMDetectedOperandType.INVALID_NUMBER; // Out of range of what can be represented in HMMM binary
    if (num < 0) return HMMMDetectedOperandType.SIGNED_NUMBER; // Can be represented as a signed number
    if (num > 127) return HMMMDetectedOperandType.UNSIGNED_NUMBER; // Can be represented as an unsigned number
    return HMMMDetectedOperandType.NUMBER; // Can be represented as either a signed or unsigned number
}

/**
 * Gets the operand signature of an instruction
 * @param instr The instruction to get the signature of
 * @returns The signature of the instruction
 */
export function getInstructionSignature(instr: HMMMInstruction): string {
    let sig = '';

    if (instr.operand1) {
        sig += `${instr.operand1 === HMMMOperandType.REGISTER ? 'rX' : 'N'}`;
    }

    if (instr.operand2) {
        sig += ` ${instr.operand2 === HMMMOperandType.REGISTER ? 'rY' : 'N'}`;
    }

    if (instr.operand3) {
        sig += ` ${instr.operand3 === HMMMOperandType.REGISTER ? 'rZ' : 'N'}`;
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
        if(instr.operand1 === HMMMOperandType.REGISTER) {
            rep = `${rep.substring(0, 4)} XXXX ${rep.substring(10)}`;
        } else {
            rep = `${rep.substring(0, 9)} NNNN NNNN`;
        }
    }

    if (instr.operand2) {
        if(instr.operand2 === HMMMOperandType.REGISTER) {
            rep = `${rep.substring(0, 9)} YYYY ${rep.substring(15)}`;
        } else {
            rep = `${rep.substring(0, 9)} NNNN NNNN`;
        }
    }

    if (instr.operand3) {
        if(instr.operand3 === HMMMOperandType.REGISTER) {
            rep = `${rep.substring(0, 14)} ZZZZ`;
        } else {
            // All numbers are represented with 8 bits, so the third argument cannot be a number
            console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
        }
    }

    return rep;
}

interface ParsedHMMMOperand {
    type: HMMMOperandType;
    value: number;
}

interface ParsedHMMMInstruction {
    instruction: HMMMInstruction;
    operands: ParsedHMMMOperand[];
}

/**
 * Gets the bitmask for the opcode of an instruction (the bits that are not used for the operands)
 * @param instr The instruction to get the mask for
 * @returns The mask for the instruction
*/
export function getInstructionMask(instr: HMMMInstruction): number {
    // Start with a mask that has all 16 bits set to 1, and then remove bits based on the operands
    let mask = 0b1111_1111_1111_1111;

    // An operand is 4 bits long, so remove 4 bits for each operand
    if (instr.operand1 === HMMMOperandType.REGISTER) {
        mask &= 0b1111_0000_1111_1111;
    }

    const hasNumericalArg = instr.operand1 === HMMMOperandType.SIGNED_NUMBER || instr.operand1 === HMMMOperandType.UNSIGNED_NUMBER || instr.operand2 === HMMMOperandType.SIGNED_NUMBER || instr.operand2 === HMMMOperandType.UNSIGNED_NUMBER;

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
 * Parses an instruction from its binary representation
 * @param line The line to parse
 * @returns The parsed instruction
 */
export function parseBinaryInstruction(line: string): ParsedHMMMInstruction | undefined {
    // Remove all whitespace from the line and ensure it only contains binary
    line = line.replace(/[^01]/g, '');

    if (line.length !== 16) return undefined; // Invalid instruction! It should be 16 bits long

    // Get the instruction
    const opcode = parseInt(line, 2);
    const instructions = hmmmInstructions.filter(instr => ((instr.opcode ^ opcode) & instr.mask) === 0);

    if (!instructions.length) return undefined; // Invalid instruction!

    // If multiple instructions match, use the one with the highest mask (the one which is the most restrictive) (ex. prefer jumpn of calln)
    const instr = instructions.sort((instr1, instr2) => -(instr1.mask - instr2.mask))[0]; // negate the result so it sorts in descending order

    // Get the operands
    const operands: ParsedHMMMOperand[] = [];

    /**
     * Parses an operand from its binary representation
     * @param operandType The type of the operand
     * @param operand The binary representation of the operand
     * @returns The parsed operand
     */
    function parseOperand(operandType: HMMMOperandType, operand: string): ParsedHMMMOperand {
        switch(operandType) {
            case HMMMOperandType.REGISTER:
                return { type: HMMMOperandType.REGISTER, value: parseInt(operand, 2) };
            case HMMMOperandType.SIGNED_NUMBER:
                return { type: HMMMOperandType.SIGNED_NUMBER, value: parseSignedInt(line.substring(8, 16)) };
            case HMMMOperandType.UNSIGNED_NUMBER:
                return { type: HMMMOperandType.UNSIGNED_NUMBER, value: parseInt(line.substring(8, 16), 2) };
        }
    }

    if (instr.operand1) {
        operands.push(parseOperand(instr.operand1, line.substring(4, 8)));
    }

    if (instr.operand2) {
        operands.push(parseOperand(instr.operand2, line.substring(8, 12)));
    }

    if (instr.operand3) {
        if(instr.operand3 === HMMMOperandType.SIGNED_NUMBER || instr.operand3 === HMMMOperandType.UNSIGNED_NUMBER) {
            // All numbers are represented with 8 bits, so the third argument cannot be a number
            console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
        } else {
            operands.push(parseOperand(instr.operand3, line.substring(12, 16)));
        }
    }

    return { instruction: instr, operands: operands };
}

/**
 * Preprocesses a line of HMMM code by removing comments and trimming trailing whitespace
 * @param line The line to preprocess
 * @returns The preprocessed line
 */
export function preprocessLine(line: string) {
    return line.split('#')[0].trimEnd();
}

//--helper functions

/**
 * Parses a signed binary string in two's complement notation to a number
 * @param value The binary string to parse
 * @returns The parsed number
 */
function parseSignedInt(value: string): number {
    if (value[0] === '1') { // Negative number
        return parseInt(value.slice(1), 2) - 2 ** (value.length - 1);
    } else { // Positive number
        return parseInt(value, 2);
    }
}
