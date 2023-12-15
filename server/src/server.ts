import { Position, TextDocument } from 'vscode-languageserver-textdocument';
import {
    CodeAction,
    CodeActionKind,
    CodeActionParams,
    CompletionItemKind,
    CompletionList,
    CompletionParams,
    Definition,
    DefinitionParams,
    Diagnostic,
    DiagnosticSeverity,
    Hover,
    HoverParams,
    InitializeParams,
    Location,
    MarkupKind,
    ProposedFeatures,
    Range,
    ReferenceParams,
    TextDocumentSyncKind,
    TextDocuments,
    TextEdit,
    createConnection,
    uinteger
} from 'vscode-languageserver/node';

enum HMMMOperandType {
    REGISTER = 1, // Without the =1, TypeScript is unhappy
    SIGNED_NUMBER,
    UNSIGNED_NUMBER
}

type HMMMOperand = HMMMOperandType | undefined;

interface HMMMInstruction {
    name: string;
    opcode: number;
    operand1: HMMMOperand;
    operand2: HMMMOperand;
    operand3: HMMMOperand;
    description: string;
}

let hmmmInstructions: HMMMInstruction[];

{
    function hmmmInstr(name: string, opcode: number, operand1: HMMMOperand, operand2: HMMMOperand, operand3: HMMMOperand, description: string): HMMMInstruction {
        return { name, opcode, operand1, operand2, operand3, description };
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
        hmmmInstr("jeqzn", 0b1100_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX == 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jnezn", 0b1101_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX != 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jgtzn", 0b1110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX > 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jltzn", 0b1111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined, "If rX < 0b0000_0000_0000_0000, then jump to line N"),
    ];
}

function getInstructionByName(name: string): HMMMInstruction | undefined {
    return hmmmInstructions.find(instr => instr.name === name);
}

// Language Server Setup

const connection = createConnection(ProposedFeatures.all)
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

connection.onInitialize((params: InitializeParams) => {
    return {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            codeActionProvider: true,
            completionProvider: {
                triggerCharacters: [' ', '\n']
            },
            definitionProvider: true,
            hoverProvider: true,
            referencesProvider: true
        }
    };
});

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

// Language Server Implementation

const operandRegex = /(?:(\S+)(?:\s+|$))?/gm;
const lastOperandRegex = /(?:(\S+)\s*)?/gm;
const instructionRegex = RegExp(`^\\s*${operandRegex.source}${operandRegex.source}${operandRegex.source}${operandRegex.source}${lastOperandRegex.source}(?:\\s+(.+))?$`, 'md');

enum InstructionPart {
    FULL_LINE = 0,
    LINE_NUM = 1,
    INSTRUCTION = 2,
    OPERAND1 = 3,
    OPERAND2 = 4,
    OPERAND3 = 5,
    OTHER = 6,
}

enum HMMMDetectedOperandType {
    R0,
    REGISTER,
    INVALID_REGISTER,
    NUMBER,
    SIGNED_NUMBER,
    UNSIGNED_NUMBER,
    INVALID_NUMBER
}

type HMMMDetectedOperand = HMMMDetectedOperandType | undefined;

/**
 * Determines the type of an operand
 * @param operand The string to check
 * @returns The detected operand type or undefined if the operand is invalid
 */
function validateOperand(operand: string): HMMMDetectedOperand {
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

enum HMMMErrorType {
    INVALID_LINE,
    MISSING_LINE_NUM,
    INCORRECT_LINE_NUM,
    INVALID_OPERAND,
    INVALID_REGISTER,
    INVALID_NUMBER,
    UNEXPECTED_TOKEN,
    MISSING_INSTRUCTION,
    INVALID_INSTRUCTION,
    MISSING_OPERAND,
    TOO_MANY_OPERANDS
}

/**
 * Validates a text document and sends diagnostics to the client
 * 
 * @param textDocument The text document to validate
 * @returns A promise that resolves when the validation is complete
 */
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    let diagnostics: Diagnostic[] = [];
    const defaultIndices = Array(7).fill([uinteger.MIN_VALUE, uinteger.MAX_VALUE]); // Create an array of ranges which are the full line. This is used as a default in some cases if the regex fails to match

    let numCodeLines = 0; // Keep track of the number of lines that contain code so we can check if the line numbers are correct

    for (let lineIdx = 0; lineIdx < textDocument.lineCount; lineIdx++) {
        // Get the line and remove any comments
        const line = textDocument.getText(Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        if (!line.trim()) continue; // Skip empty lines

        // Try to match the line to the instruction regex
        let m: RegExpMatchArray | null;
        if (!(m = instructionRegex.exec(line))) {
            diagnostics.push({ // If the regex fails to match, add an error diagnostic (The regex is pretty general, so this shouldn't happen)
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE),
                message: `Invalid line!`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.INVALID_LINE
            });
            continue;
        }

        let indices = m.indices ?? defaultIndices; // Get the indices of the matched groups, if the regex fails to get the indices, use the default indices
        indices = indices.map(range => range ?? [uinteger.MIN_VALUE, uinteger.MAX_VALUE]); // Make sure all ranges are defined

        const lineNum = parseInt(m[InstructionPart.LINE_NUM]); // Get the line number

        if (isNaN(lineNum)) { // The line number is not a number
            diagnostics.push({ // Add an error diagnostic
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][0] + 1),
                message: `Missing line number`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.MISSING_LINE_NUM
            });

            m = instructionRegex.exec(`0 ${line}`) ?? m; // Assume the user just forgot a line number and the rest of the line is correct. Try to match the line with a line number of 0
            indices = m.indices ?? defaultIndices;
        } else if (lineNum !== numCodeLines) { // The line number is not correct
            diagnostics.push({ // Add a warning diagnostic
                severity: DiagnosticSeverity.Warning,
                range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][1]),
                message: `Incorrect line number! Should be ${numCodeLines}`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.INCORRECT_LINE_NUM
            });
        }

        numCodeLines++; // Increment the number of code lines

        const operand1 = m[InstructionPart.OPERAND1];
        const operand2 = m[InstructionPart.OPERAND2];
        const operand3 = m[InstructionPart.OPERAND3];

        /**
         * Checks if an operand is valid and reports errors if it isn't
         *
         * @param operandType The detected operand type
         * @param operandIdx The index of the operand in the regex match
         */
        function reportOperandErrors(operandType: HMMMDetectedOperand, operandIdx: number) {
            if (operandType === undefined) { // The operand is invalid
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid operand!`,
                    source: 'HMMM Language Server',
                    data: HMMMErrorType.INVALID_OPERAND
                });
            } else if (operandType === HMMMDetectedOperandType.INVALID_REGISTER) { // The operand is a register that is not r0-r15
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid register! HMMM only supports registers r0-r15`,
                    source: 'HMMM Language Server',
                    data: HMMMErrorType.INVALID_REGISTER
                });
            } else if (operandType === HMMMDetectedOperandType.INVALID_NUMBER) { // The operand is a number that is out of range
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid number! HMMM only supports numerical arguments from -128 to 127 (signed) or 0 to 255 (unsigned)`,
                    source: 'HMMM Language Server',
                    data: HMMMErrorType.INVALID_NUMBER
                });
            }
        }

        let operand1Type: HMMMDetectedOperand = undefined;
        let operand2Type: HMMMDetectedOperand = undefined;
        let operand3Type: HMMMDetectedOperand = undefined;

        // Validate the operands if they exist
        if (operand1) {
            operand1Type = validateOperand(operand1);
            reportOperandErrors(operand1Type, InstructionPart.OPERAND1);
        }
        if (operand2) {
            operand2Type = validateOperand(operand2);
            reportOperandErrors(operand2Type, InstructionPart.OPERAND2);
        }
        if (operand3) {
            operand3Type = validateOperand(operand3);
            reportOperandErrors(operand3Type, InstructionPart.OPERAND3);
        }

        if (m[InstructionPart.OTHER]) { // There is an unexpected token at the end of the line
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.OTHER][0], lineIdx, indices[InstructionPart.OTHER][1]),
                message: `Unexpected token!`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.UNEXPECTED_TOKEN
            });
        }

        const instruction = m[InstructionPart.INSTRUCTION];

        if (!instruction) { // There is a line number, but no instruction
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, Math.max(0, indices[InstructionPart.LINE_NUM][1] - 1), lineIdx, indices[InstructionPart.LINE_NUM][1]),
                message: `Expected instruction`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.MISSING_INSTRUCTION
            });
            continue;
        }

        const hmmmInstruction = getInstructionByName(instruction); // Try to get the instruction from the name

        if (!hmmmInstruction) { // The instruction is not valid
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.INSTRUCTION][0], lineIdx, indices[InstructionPart.INSTRUCTION][1]),
                message: `Unknown instruction`,
                source: 'HMMM Language Server',
                data: HMMMErrorType.INVALID_INSTRUCTION
            });
            continue;
        }

        // Calculate the number of expected arguments for the given instruction
        const numExpectedArgs = [hmmmInstruction.operand1, hmmmInstruction.operand2, hmmmInstruction.operand3].filter(operand => operand !== undefined).length;

        /**
         * Checks if an operand is valid for the given instruction and reports errors if it isn't
         *
         * @param operand The operand to check
         * @param operandType The detected operand type
         * @param operandIdx The index of the operand in the regex match
         * @param instruction The instruction to check against
         * @param expectedType The expected operand type
         *
         * @returns true if the operand is missing and the code should stop checking for errors, false otherwise
         */
        function reportOperandTypeMismatchErrors(operand: string, operandType: HMMMDetectedOperand, operandIdx: number, instruction: HMMMInstruction, expectedType: HMMMOperand): boolean {
            if (expectedType) { // The instruction expects an operand
                if (operand) { // An operand was provided
                    switch (expectedType) {
                        case HMMMOperandType.REGISTER:
                            if (operandType !== HMMMDetectedOperandType.REGISTER && operandType !== HMMMDetectedOperandType.R0 && operandType !== HMMMDetectedOperandType.INVALID_REGISTER) {
                                diagnostics.push({ // The instruction expects a register, but the operand is not a register
                                    severity: DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a register as operand 1`,
                                    source: 'HMMM Language Server',
                                    data: HMMMErrorType.INVALID_REGISTER
                                });
                            }
                            break;
                        case HMMMOperandType.SIGNED_NUMBER:
                            if (operandType !== HMMMDetectedOperandType.SIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
                                diagnostics.push({ // The instruction expects a signed number, but the operand is not a signed number
                                    severity: operandType === HMMMDetectedOperandType.UNSIGNED_NUMBER || operandType === HMMMDetectedOperandType.INVALID_NUMBER ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, // Warning if the number is out of range, error otherwise
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
                                    source: 'HMMM Language Server',
                                    data: HMMMErrorType.INVALID_NUMBER
                                });
                            }
                            break;
                        case HMMMOperandType.UNSIGNED_NUMBER:
                            if (operandType !== HMMMDetectedOperandType.UNSIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
                                diagnostics.push({ // The instruction expects an unsigned number, but the operand is not an unsigned number
                                    severity: operandType === HMMMDetectedOperandType.SIGNED_NUMBER || operandType === HMMMDetectedOperandType.INVALID_NUMBER ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, // Warning if the number is out of range, error otherwise
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
                                    source: 'HMMM Language Server',
                                    data: HMMMErrorType.INVALID_NUMBER
                                });
                            }
                            break;
                    }
                } else {
                    diagnostics.push({ // The instruction expects an operand, but none was provided
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(lineIdx, indices[InstructionPart.INSTRUCTION][0], lineIdx, indices[InstructionPart.INSTRUCTION][1]),
                        message: `${instruction.name} expects ${numExpectedArgs} argument${numExpectedArgs === 1 ? '' : 's'}`,
                        source: 'HMMM Language Server',
                        data: HMMMErrorType.MISSING_OPERAND
                    });
                    return true; // There are no more operands to check (because this one was missing), so stop checking for errors
                }
            } else if (operand) {
                diagnostics.push({ // The instruction does not expect an operand, but one was provided
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `${instruction.name} only expects ${numExpectedArgs} argument${numExpectedArgs === 1 ? '' : 's'}`,
                    source: 'HMMM Language Server',
                    data: HMMMErrorType.TOO_MANY_OPERANDS
                });
            }
            return false;
        }

        // Check if the operands are valid for the given instruction
        if (reportOperandTypeMismatchErrors(operand1, operand1Type, InstructionPart.OPERAND1, hmmmInstruction, hmmmInstruction.operand1)) continue;
        if (reportOperandTypeMismatchErrors(operand2, operand2Type, InstructionPart.OPERAND2, hmmmInstruction, hmmmInstruction.operand2)) continue;
        if (reportOperandTypeMismatchErrors(operand3, operand3Type, InstructionPart.OPERAND3, hmmmInstruction, hmmmInstruction.operand3)) continue;

    }

    // Send the diagnostics to the client
    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

/**
 * Gets the instruction number that should be expected at the given line number
 *
 * @param lineNumber The line number in the text document to check
 * @param document The text document to check
 * @returns The expected instruction number
 */
function getExpectedInstructionNumber(lineNumber: number, document: TextDocument): number {
    let numCodeLines = 0; // Keep track of the number of lines that contain code so we can check the instruction numbers

    for(let i = 0; i < lineNumber; i++) { // Loop through all the lines before the given line
        // Get the line and remove any comments
        const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        if (!line.trim()) continue; // Skip empty lines

        numCodeLines++; // The line contains code, so increment the number of code lines
    }

    return numCodeLines; // The instruction number is the number of code lines
}

/**
 * Populates the completion list with the next instruction number
 *
 * @param completionList The completion list to populate
 * @param lineNumber The line number in the text document to check
 * @param document The text document to check
 */
function populateLineNumber(completionList: CompletionList, lineNumber: number, document: TextDocument) {
    completionList.items.push({
        label: getExpectedInstructionNumber(lineNumber, document).toString(),
        labelDetails: { description: 'Next Line Number'},
        kind: CompletionItemKind.Snippet
    });
}

/**
 * Populates the completion list with the registers
 *
 * @param completionList The completion list to populate
 */
function populateRegisters(completionList: CompletionList) {
    completionList.items.push({
        label: `r0`,
        labelDetails: { description: 'Always 0'},
        kind: CompletionItemKind.Variable
    });
    for (let i = 1; i < 13; i++) { // r1-r12 (r0 and r13-r15 are special registers)
        completionList.items.push({
            label: `r${i}`,
            labelDetails: { description: 'General Purpose Register'},
            kind: CompletionItemKind.Variable,
            sortText: `r${i.toString().padStart(2, '0')}`, // Make sure r10+ come after r9
        });
    }
    completionList.items.push({
        label: `r13`,
        labelDetails: { description: 'Return Value'},
        kind: CompletionItemKind.Variable
    });
    completionList.items.push({
        label: `r14`,
        labelDetails: { description: 'Return Address'},
        kind: CompletionItemKind.Variable
    });
    completionList.items.push({
        label: `r15`,
        labelDetails: { description: 'Stack Pointer'},
        kind: CompletionItemKind.Variable
    });
}

/**
 * Gets the operand signature of an instruction
 * @param instr The instruction to get the signature of
 * @returns The signature of the instruction
 */
function getInstructionSignature(instr: HMMMInstruction): string {
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
function getInstructionRepresentation(instr: HMMMInstruction): string {
    // Convert the instruction from a binary number to a binary string
    let rep = (instr.opcode >>> 0).toString(2).padStart(16, '0'); // https://stackoverflow.com/a/16155417

    // Add spaces every 4 characters to make it easier to read
    rep = rep.match(/.{4}/g)?.join(' ') ?? rep; // https://stackoverflow.com/a/53427113
    rep = rep.padEnd(19, ' '); // Shouldn't be necessary, but just in case

    if (instr.operand1) {
        if(instr.operand1 === HMMMOperandType.REGISTER) {
            rep = `${rep.substring(0, 4)} XXXX ${rep.substring(10)}`;
        } else {
            rep = `${rep.substring(0, 10)} NNNN NNNN`;
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

/**
 * Populates the completion list with the HMMM instructions
 *
 * @param completionList The completion list to populate
 */
function populateInstructions(completionList: CompletionList) {
    for (const instr of hmmmInstructions) {
        completionList.items.push({
            label: instr.name,
            labelDetails: { detail: ` ${getInstructionSignature(instr)}`, description: getInstructionRepresentation(instr) },
            kind: CompletionItemKind.Keyword,
            documentation: instr.description
        });
    }
}

/**
 * Checks if a position is within a group in a RegExpMatchArray
 *
 * @param value The position to check
 * @param index The index of the group to check
 * @param indices The indices of the groups
 * @returns true if the position is within the group, false if it is not or the group was not found
 */
function isInIndexRange(value: number, index: number, indices: RegExpIndicesArray): boolean {
    return (value >= indices[index]?.[0] && value <= indices[index]?.[1]) ?? false;
}

connection.onCompletion(
    (params: CompletionParams): CompletionList => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        const document = documents.get(params.textDocument.uri);
        const completionList = CompletionList.create();

        if (!document) {
            // We can't read the document, so just return the default completion list
            populateRegisters(completionList);
            populateInstructions(completionList);
            return completionList;
        }

        const line = document.getText(Range.create(params.position.line, uinteger.MIN_VALUE, params.position.line, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        let m: RegExpMatchArray | null;

        if (!line.trim()) {
            // The line is empty, so suggest the next line number or an instruction
            populateLineNumber(completionList, params.position.line, document);
            populateInstructions(completionList);
            return completionList;
        }

        if (!line.trim() || !(m = instructionRegex.exec(line))?.indices || !m.indices) {
            // The line is invalid, so suggest an instruction
            populateInstructions(completionList);
            return completionList;
        }

        const indices = m.indices;
        const position = params.position.character;

        if(isInIndexRange(position, InstructionPart.OTHER, indices)) return completionList; // The cursor is at the end of the line, so don't suggest anything

        if(isInIndexRange(position, InstructionPart.LINE_NUM, indices)) {
             // The cursor is in the line number, so suggest the next line number
            populateLineNumber(completionList, params.position.line, document);
            return completionList;
        }

        if (!m[InstructionPart.INSTRUCTION] || isInIndexRange(position, InstructionPart.INSTRUCTION, indices)) {
            // The cursor is in the instruction, so suggest an instruction
            populateInstructions(completionList);
            return completionList;
        }

        // Try to get the instruction being used on the current line
        const instruction = getInstructionByName(m[InstructionPart.INSTRUCTION]);
        if (!instruction) {
            // The instruction is invalid, so just suggest a register
            populateRegisters(completionList);
            return completionList;
        }

        if ((!m[InstructionPart.OPERAND1] || isInIndexRange(position, InstructionPart.OPERAND1, indices)) && instruction.operand1 === HMMMOperandType.REGISTER) {
            // The instruction expects a register argument, so suggest a register
            populateRegisters(completionList);
            return completionList;
        }
        if ((!m[InstructionPart.OPERAND2] || isInIndexRange(position, InstructionPart.OPERAND2, indices)) && instruction.operand2 === HMMMOperandType.REGISTER) {
            // The instruction expects a register argument, so suggest a register
            populateRegisters(completionList);
            return completionList;
        }
        if ((!m[InstructionPart.OPERAND3] || isInIndexRange(position, InstructionPart.OPERAND3, indices)) && instruction.operand3 === HMMMOperandType.REGISTER) {
            // The instruction expects a register argument, so suggest a register
            populateRegisters(completionList);
            return completionList;
        }

        return completionList;
    }
);

/**
 * Gets the word at the given position
 *
 * @param document The text document to get the word from
 * @param position The position to get the word at
 * @returns The word at the given position and the range of the word
 */
function getSelectedWord(document: TextDocument, position: Position): [string, Range] {
    const line = document.getText(Range.create(position.line, uinteger.MIN_VALUE, position.line, uinteger.MAX_VALUE)); // Get the whole line
    // Set the range to the given position (0 width)
    let wordRange = Range.create(position.line, position.character, position.line, position.character); // Copy position so start and end don't point to the same object
    while (wordRange.start.character > 0 && !/\s/.test(line[wordRange.start.character - 1])) wordRange.start.character--; // Move the start of the range to the beginning of the word
    while (wordRange.end.character < line.length && !/\s/.test(line[wordRange.end.character])) wordRange.end.character++; // Move the end of the range to the end of the word
    return [line.slice(wordRange.start.character, wordRange.end.character), wordRange]; // Return the word and the range
}

connection.onDefinition(
    (params: DefinitionParams): Definition => {
        const document = documents.get(params.textDocument.uri);

        if (!document) return []; // We can't read the document, so just return an empty array

        const line = document.getText(Range.create(params.position.line, uinteger.MIN_VALUE, params.position.line, uinteger.MAX_VALUE));

        const commentPos = line.indexOf('#');
        if(commentPos != -1 && params.position.character >= commentPos) return []; // The cursor is in a comment, so don't return anything

        const spacePos = line.indexOf(' ');
        if(spacePos != -1 && params.position.character <= spacePos) return []; // The cursor is before the instruction, so don't return anything

        const word = getSelectedWord(document, params.position)[0]; // Get the word at the cursor

        const lineNum = parseInt(word); // Try to interpret the word as a line number

        if (isNaN(lineNum) || lineNum < 0) return []; // The word is not a valid line number, so don't return anything

        // Try to interpret the line as an instruction
        let m: RegExpMatchArray | null;
        if (!(m = instructionRegex.exec(line))) return []; // The line is not an instruction, so don't return anything

        const instruction = m[InstructionPart.INSTRUCTION];

        if(!(instruction.toLowerCase().startsWith("j") || instruction.toLowerCase().startsWith("call"))) return []; // The instruction is not a jump or call; the numbers are meaningless, so don't return anything

        // Assume the number represents a line number that is being jumped to. Return all lines with a matching instruction number

        let definitions: Definition = [];

        for (let i = 0; i < document.lineCount; i++) { // Loop through all the lines in the document
            // Get the line and remove anything that's not an instruction number
            const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)).split('#')[0].trim().split(/\s+/)[0];

            if(!line) continue; // Skip empty lines

            // Try to parse the instruction number
            const num = parseInt(line);
            if (num === lineNum) { // The instruction number matches the number we're looking for
                definitions.push({ // Add the line to the definitions
                    uri: params.textDocument.uri,
                    range: Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)
                });
            }
        }

        // There were no matching lines. Return the current line, so the user receives "No definition found"
        if(!definitions.length) return [{ uri: params.textDocument.uri, range: Range.create(params.position.line, uinteger.MIN_VALUE, params.position.line, uinteger.MAX_VALUE) }];

        return definitions;
    }
);

connection.onHover(
    (params: HoverParams): Hover => {
        const document = documents.get(params.textDocument.uri);

        if (!document) return { contents: [] }; // We can't read the document, so just return an empty array

        // Get the text line
        const line = document.getText(Range.create(params.position.line, uinteger.MIN_VALUE, params.position.line, uinteger.MAX_VALUE));

        const commentPos = line.indexOf('#');
        if(commentPos != -1 && params.position.character >= commentPos) return { contents: [] }; // The cursor is in a comment, so don't return anything

        const word = getSelectedWord(document, params.position); // Get the word at the cursor

        const instruction = getInstructionByName(word[0]); // Try to interpret the word as an instruction

        if(instruction) { // The word is an instruction, show the instruction description
            return {
                contents: {
                    kind: MarkupKind.PlainText,
                    value: instruction.description
                },
                range: word[1]
            };
        }

        if(/^r(\d|1[0-5])$/i.test(word[0])) { // Try to interpret the word as a register
            // Show the register description
            if(word[0] === 'r0') {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: 'Always 0'
                    },
                    range: word[1]
                };
            }
            if(word[0] === 'r13') {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: 'Return Value'
                    },
                    range: word[1]
                };
            }
            if(word[0] === 'r14') {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: 'Return Address'
                    },
                    range: word[1]
                };
            }
            if(word[0] === 'r15') {
                return {
                    contents: {
                        kind: MarkupKind.Markdown,
                        value: 'Stack Pointer'
                    },
                    range: word[1]
                };
            }
            return {
                contents: {
                    kind: MarkupKind.Markdown,
                    value: 'General Purpose Register'
                },
                range: word[1]
            };
        }

        return { contents: [] }; // We couldn't interpret the word, so don't return anything
    }
);

connection.onReferences(
    (params: ReferenceParams): Location[] | undefined => {
        const document = documents.get(params.textDocument.uri);

        if (!document) return undefined; // We can't read the document, so just return undefined

        // Get the text line
        const line = document.getText(Range.create(params.position.line, uinteger.MIN_VALUE, params.position.line, uinteger.MAX_VALUE));

        const commentPos = line.indexOf('#');
        if(commentPos != -1 && params.position.character >= commentPos) return undefined; // The cursor is in a comment, so don't return anything

        const spacePos = line.indexOf(' ');
        if(spacePos != -1 && params.position.character > spacePos) return undefined; // The cursor is after the instruction, so don't return anything

        const word = getSelectedWord(document, params.position); // Get the word at the cursor

        const lineNum = parseInt(word[0]); // Try to interpret the word as a line number

        if (isNaN(lineNum) || lineNum < 0) return undefined; // The word is not a valid line number, so don't return anything

        // Find all lines which jump to the given line number

        let locations: Location[] = [];

        for (let i = 0; i < document.lineCount; i++) { // Loop through all the lines in the document
            // Get the line and remove anything that's not an instruction number
            const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

            if(!line) continue; // Skip empty lines

            // Try to parse the instruction number
            let m: RegExpMatchArray | null;
            if (!(m = instructionRegex.exec(line))) continue;

            if(!m.indices) { // The regex failed to get the indices, so just check if the line contains the line number
                if(line.slice(line.indexOf(' ')).includes(lineNum.toString())) {
                    locations.push({
                        uri: params.textDocument.uri,
                        range: Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)
                    });
                }
                continue;
            }

            // Check if the instruction is a jump or call
            if(!m[InstructionPart.INSTRUCTION] || !(m[InstructionPart.INSTRUCTION].toLowerCase().startsWith('j') || m[InstructionPart.INSTRUCTION].toLowerCase().startsWith('call'))) continue;

            // If it is, check if either of the operands are the line number
            if(m[InstructionPart.OPERAND1]) {
                const operand1 = m[InstructionPart.OPERAND1];
                if(parseInt(operand1) === lineNum) {
                    locations.push({
                        uri: params.textDocument.uri,
                        range: Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)
                    });
                }
            }

            if(m[InstructionPart.OPERAND2]) {
                const operand2 = m[InstructionPart.OPERAND2];
                if(parseInt(operand2) === lineNum) {
                    locations.push({
                        uri: params.textDocument.uri,
                        range: Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)
                    });
                }
            }

            // Operand 3 is never a number, so we don't need to check it
        }

        return locations;
    }
);

connection.onCodeAction(
    (params: CodeActionParams): CodeAction[] => {
        let actions: CodeAction[] = [];
        params.context.diagnostics.forEach(diagnostic => {
            if (diagnostic.source !== 'HMMM Language Server') return; // Only handle diagnostics from the HMMM Language Server

            const document = documents.get(params.textDocument.uri);
            if (!document) return; // We can't read the document, so just return

            // Get the line and remove any comments
            const line = document.getText(Range.create(diagnostic.range.start.line, uinteger.MIN_VALUE, diagnostic.range.start.line, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

            // Get the cause of the diagnostic
            const errorCode = diagnostic.data as HMMMErrorType;

            switch(errorCode) {
                case HMMMErrorType.INCORRECT_LINE_NUM: // The line number is incorrect, so suggest changing it to the expected line number
                    {
                        const correctLineNum = getExpectedInstructionNumber(diagnostic.range.start.line, document);
                        actions.push({
                            title: `Change Line Number to ${correctLineNum}`,
                            kind: CodeActionKind.QuickFix,
                            diagnostics: [diagnostic],
                            edit: {
                                changes: {
                                    [params.textDocument.uri]: [TextEdit.replace(diagnostic.range, correctLineNum.toString())]
                                }
                            }
                        });
                        break;
                    }
                case HMMMErrorType.MISSING_LINE_NUM: // The line number is missing, so suggest adding it
                    {
                        const correctLineNum = getExpectedInstructionNumber(diagnostic.range.start.line, documents.get(params.textDocument.uri)!);
                        actions.push({
                            title: 'Add Line Number',
                            kind: CodeActionKind.QuickFix,
                            diagnostics: [diagnostic],
                            edit: {
                                changes: {
                                    [params.textDocument.uri]: [TextEdit.replace(Range.create(diagnostic.range.start.line, 0, diagnostic.range.end.line, line.search(/\S/)) /* Replace the start of the line to the first non-space character */, correctLineNum.toString() + ' ')]
                                }
                            }
                        });
                        break;
                    }
            }
        });
        return actions;
    }
);

// Language Server Start

documents.listen(connection);
connection.listen();
