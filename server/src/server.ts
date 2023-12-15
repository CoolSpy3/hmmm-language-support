// Modified from https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/server/src/server.ts

import { Position, TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItemKind,
    CompletionList,
    CompletionParams,
    Definition,
    DefinitionParams,
    Diagnostic,
    DiagnosticSeverity,
    DidChangeConfigurationNotification,
    Hover,
    HoverParams,
    InitializeParams,
    InitializeResult,
    MarkupKind,
    ProposedFeatures,
    Range,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    uinteger
} from 'vscode-languageserver/node';

enum HMMMOperandType {
    REGISTER = 1,
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

let hasConfigurationCapability: boolean = false;
let hasWorkspaceFolderCapability: boolean = false;
let hasDiagnosticRelatedInformationCapability: boolean = false;

connection.onInitialize((params: InitializeParams) => {
    let capabilities = params.capabilities;

    // Does the client support the `workspace/configuration` request?
    // If not, we fall back using global settings.
    hasConfigurationCapability = !!(
        capabilities.workspace && !!capabilities.workspace.configuration
    );
    hasWorkspaceFolderCapability = !!(
        capabilities.workspace && !!capabilities.workspace.workspaceFolders
    );
    hasDiagnosticRelatedInformationCapability = !!(
        capabilities.textDocument &&
        capabilities.textDocument.publishDiagnostics &&
        capabilities.textDocument.publishDiagnostics.relatedInformation
    );

    const result: InitializeResult = {
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            // Tell the client that this server supports code completion.
            completionProvider: {
                triggerCharacters: [' ', '\n']
            },
            definitionProvider: true,
            hoverProvider: true
        }
    };
    if (hasWorkspaceFolderCapability) {
        result.capabilities.workspace = {
            workspaceFolders: {
                supported: true
            }
        };
    }
    return result;
});

connection.onInitialized(() => {
    if (hasConfigurationCapability) {
        // Register for all configuration changes.
        connection.client.register(DidChangeConfigurationNotification.type, undefined);
    }
    if (hasWorkspaceFolderCapability) {
        connection.workspace.onDidChangeWorkspaceFolders(_event => {
            connection.console.log('Workspace folder change event received.');
        });
    }
});

// Language Server Implementation

documents.onDidChangeContent(change => {
    validateTextDocument(change.document);
});

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

function validateOperand(operand: string): HMMMDetectedOperand {
    if (!operand) return undefined;

    if (/^r0$/i.test(operand)) return HMMMDetectedOperandType.R0;

    if (/^r\d+$/i.test(operand)) {
        if (/^r(\d|1[0-5])$/i.test(operand)) return HMMMDetectedOperandType.REGISTER;
        return HMMMDetectedOperandType.INVALID_REGISTER;
    }

    const num = parseInt(operand);

    if (isNaN(num)) return undefined;

    if (num < -128 || num > 255) return HMMMDetectedOperandType.INVALID_NUMBER;
    if (num < 0) return HMMMDetectedOperandType.SIGNED_NUMBER;
    if (num > 127) return HMMMDetectedOperandType.UNSIGNED_NUMBER;
    return HMMMDetectedOperandType.NUMBER;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    let diagnostics: Diagnostic[] = [];
    const defaultIndices = Array(7).fill([uinteger.MIN_VALUE, uinteger.MAX_VALUE]);

    let numCodeLines = 0;

    for (let lineIdx = 0; lineIdx < textDocument.lineCount; lineIdx++) {
        const line = textDocument.getText(Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        if (!line.trim()) continue;

        let m: RegExpMatchArray | null;
        if (!(m = instructionRegex.exec(line))) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE),
                message: `Invalid line!`,
                source: 'HMMM Language Server'
            });
            continue;
        }

        let indices = m.indices ?? defaultIndices;
        indices = indices.map(range => range ?? [uinteger.MIN_VALUE, uinteger.MAX_VALUE]);

        const lineNum = parseInt(m[InstructionPart.LINE_NUM]);

        if (isNaN(lineNum)) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][0] + 1),
                message: `Missing line number`,
                source: 'HMMM Language Server'
            });

            m = instructionRegex.exec(`0 ${line}`) ?? m;
            indices = m.indices ?? defaultIndices;
        } else if (lineNum !== numCodeLines) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][1]),
                message: `Incorrect line number! Should be ${numCodeLines}`,
                source: 'HMMM Language Server'
            });
        }

        numCodeLines++;

        const operand1 = m[InstructionPart.OPERAND1];
        const operand2 = m[InstructionPart.OPERAND2];
        const operand3 = m[InstructionPart.OPERAND3];

        function reportOperandErrors(operandType: HMMMDetectedOperand, operandIdx: number) {
            if (operandType === undefined) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid operand!`,
                    source: 'HMMM Language Server'
                });
            } else if (operandType === HMMMDetectedOperandType.INVALID_REGISTER) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid register! HMMM only supports registers r0-r15`,
                    source: 'HMMM Language Server'
                });
            } else if (operandType === HMMMDetectedOperandType.INVALID_NUMBER) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Warning,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid number! HMMM only supports numerical arguments from -128 to 127 (signed) or 0 to 255 (unsigned)`,
                    source: 'HMMM Language Server'
                });
            }
        }

        let operand1Type: HMMMDetectedOperand = undefined;
        let operand2Type: HMMMDetectedOperand = undefined;
        let operand3Type: HMMMDetectedOperand = undefined;

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

        if (m[InstructionPart.OTHER]) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.OTHER][0], lineIdx, indices[InstructionPart.OTHER][1]),
                message: `Unexpected token!`,
                source: 'HMMM Language Server'
            });
        }

        const instruction = m[InstructionPart.INSTRUCTION];

        if (!instruction) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, Math.max(0, indices[InstructionPart.LINE_NUM][1] - 1), lineIdx, indices[InstructionPart.LINE_NUM][1]),
                message: `Expected instruction`,
                source: 'HMMM Language Server'
            });
            continue;
        }

        const hmmmInstruction = getInstructionByName(instruction);

        if (!hmmmInstruction) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[InstructionPart.INSTRUCTION][0], lineIdx, indices[InstructionPart.INSTRUCTION][1]),
                message: `Unknown instruction`,
                source: 'HMMM Language Server'
            });
        }

        if (!hmmmInstruction) continue;

        const numExpectedArgs = [hmmmInstruction.operand1, hmmmInstruction.operand2, hmmmInstruction.operand3].filter(operand => operand !== undefined).length;

        function reportOperandTypeMismatchErrors(operand: string, operandType: HMMMDetectedOperand, operandIdx: number, instruction: HMMMInstruction, expectedType: HMMMOperand): boolean {
            if (expectedType) {
                if (operand) {
                    switch (expectedType) {
                        case HMMMOperandType.REGISTER:
                            if (operandType !== HMMMDetectedOperandType.REGISTER && operandType !== HMMMDetectedOperandType.R0 && operandType !== HMMMDetectedOperandType.INVALID_REGISTER) {
                                diagnostics.push({
                                    severity: DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a register as operand 1`,
                                    source: 'HMMM Language Server'
                                });
                            }
                            break;
                        case HMMMOperandType.SIGNED_NUMBER:
                            if (operandType !== HMMMDetectedOperandType.SIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
                                diagnostics.push({
                                    severity: operandType === HMMMDetectedOperandType.UNSIGNED_NUMBER || operandType === HMMMDetectedOperandType.INVALID_NUMBER ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
                                    source: 'HMMM Language Server'
                                });
                            }
                            break;
                        case HMMMOperandType.UNSIGNED_NUMBER:
                            if (operandType !== HMMMDetectedOperandType.UNSIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
                                diagnostics.push({
                                    severity: operandType === HMMMDetectedOperandType.SIGNED_NUMBER || operandType === HMMMDetectedOperandType.INVALID_NUMBER ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
                                    source: 'HMMM Language Server'
                                });
                            }
                            break;
                    }
                } else {
                    diagnostics.push({
                        severity: DiagnosticSeverity.Error,
                        range: Range.create(lineIdx, indices[InstructionPart.INSTRUCTION][0], lineIdx, indices[InstructionPart.INSTRUCTION][1]),
                        message: `${instruction.name} expects ${numExpectedArgs} argument${numExpectedArgs === 1 ? '' : 's'}`,
                        source: 'HMMM Language Server'
                    });
                    return true;
                }
            } else if (operand) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `${instruction.name} only expects ${numExpectedArgs} argument${numExpectedArgs === 1 ? '' : 's'}`,
                    source: 'HMMM Language Server'
                });
            }
            return false;
        }

        if (reportOperandTypeMismatchErrors(operand1, operand1Type, InstructionPart.OPERAND1, hmmmInstruction, hmmmInstruction.operand1)) continue;
        if (reportOperandTypeMismatchErrors(operand2, operand2Type, InstructionPart.OPERAND2, hmmmInstruction, hmmmInstruction.operand2)) continue;
        if (reportOperandTypeMismatchErrors(operand3, operand3Type, InstructionPart.OPERAND3, hmmmInstruction, hmmmInstruction.operand3)) continue;

    }

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

function getExpectedLineNumber(lineNumber: number, document: TextDocument): number {
    let numCodeLines = 0;

    for(let i = 0; i < lineNumber; i++) {
        const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        if (!line.trim()) continue;

        numCodeLines++;
    }

    return numCodeLines;
}

function populateLineNumber(completionList: CompletionList, lineNumber: number, document: TextDocument) {
    completionList.items.push({
        label: getExpectedLineNumber(lineNumber, document).toString(),
        labelDetails: { description: 'Next Line Number'},
        kind: CompletionItemKind.Snippet
    });
}

function populateRegisters(completionList: CompletionList) {
    completionList.items.push({
        label: `r0`,
        labelDetails: { description: 'Always 0'},
        kind: CompletionItemKind.Variable
    });
    for (let i = 1; i < 13; i++) {
        completionList.items.push({
            label: `r${i}`,
            labelDetails: { description: 'General Purpose Register'},
            kind: CompletionItemKind.Variable,
            sortText: `r${i.toString().padStart(2, '0')}`,
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

function getInstructionRepresentation(instr: HMMMInstruction): string {
    let rep = (instr.opcode >>> 0).toString(2).padStart(16, '0'); // https://stackoverflow.com/a/16155417

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
            console.error(`Invalid instruction! ${instr.name} has an operand 3 of type ${instr.operand3}`);
        }
    }

    return rep;
}

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

function isInIndexRange(value: number, index: number, indices: RegExpIndicesArray): boolean {
    return (value >= indices[index]?.[0] && value <= indices[index]?.[1]) ?? false;
}

connection.onCompletion(
    (textDocumentPosition: CompletionParams): CompletionList => {
        // The pass parameter contains the position of the text document in
        // which code complete got requested. For the example we ignore this
        // info and always provide the same completion items.
        const document = documents.get(textDocumentPosition.textDocument.uri);
        const completionList = CompletionList.create();

        if (!document) {
            populateRegisters(completionList);
            populateInstructions(completionList);
            return completionList;
        }

        const line = document.getText(Range.create(textDocumentPosition.position.line, uinteger.MIN_VALUE, textDocumentPosition.position.line, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        let m: RegExpMatchArray | null;

        if (!line.trim()) {
            populateLineNumber(completionList, textDocumentPosition.position.line, document);
            populateInstructions(completionList);
            return completionList;
        }

        if (!line.trim() || !(m = instructionRegex.exec(line))?.indices || !m.indices) {
            populateInstructions(completionList);
            return completionList;
        }

        const indices = m.indices;
        const position = textDocumentPosition.position.character;

    if(isInIndexRange(position, InstructionPart.OTHER, indices)) return completionList;

        if(isInIndexRange(position, InstructionPart.LINE_NUM, indices)) {
            populateLineNumber(completionList, textDocumentPosition.position.line, document);
            return completionList;
        }

        if (!m[InstructionPart.INSTRUCTION] || isInIndexRange(position, InstructionPart.INSTRUCTION, indices)) {
            populateInstructions(completionList);
            return completionList;
        }

        const instruction = getInstructionByName(m[InstructionPart.INSTRUCTION]);

        if (!instruction) {
            populateRegisters(completionList);
            return completionList;
        }

        if ((!m[InstructionPart.OPERAND1] || isInIndexRange(position, InstructionPart.OPERAND1, indices)) && instruction.operand1 === HMMMOperandType.REGISTER) {
            populateRegisters(completionList);
            return completionList;
        }
        if ((!m[InstructionPart.OPERAND2] || isInIndexRange(position, InstructionPart.OPERAND2, indices)) && instruction.operand2 === HMMMOperandType.REGISTER) {
            populateRegisters(completionList);
            return completionList;
        }
        if ((!m[InstructionPart.OPERAND3] || isInIndexRange(position, InstructionPart.OPERAND3, indices)) && instruction.operand3 === HMMMOperandType.REGISTER) {
            populateRegisters(completionList);
            return completionList;
        }

        return completionList;
    }
);

function getSelectedWord(document: TextDocument, position: Position): [string, Range] {
    const line = document.getText(Range.create(position.line, uinteger.MIN_VALUE, position.line, uinteger.MAX_VALUE));
    let wordRange = Range.create(position.line, position.character, position.line, position.character); // Copy position so start and end don't point to the same object
    while (wordRange.start.character > 0 && !/\s/.test(line[wordRange.start.character - 1])) wordRange.start.character--;
    while (wordRange.end.character < line.length && !/\s/.test(line[wordRange.end.character])) wordRange.end.character++;
    return [line.slice(wordRange.start.character, wordRange.end.character), wordRange];
}

connection.onDefinition(
    (textDocumentPosition: DefinitionParams): Definition => {
        const document = documents.get(textDocumentPosition.textDocument.uri);

        if (!document) return [];

        const line = document.getText(Range.create(textDocumentPosition.position.line, uinteger.MIN_VALUE, textDocumentPosition.position.line, uinteger.MAX_VALUE));

        const commentPos = line.indexOf('#');
        if(commentPos != -1 && textDocumentPosition.position.character >= commentPos) return [];

        const spacePos = line.indexOf(' ');
        if(spacePos != -1 && textDocumentPosition.position.character <= spacePos) return [];

        const word = getSelectedWord(document, textDocumentPosition.position)[0];

        const lineNum = parseInt(word);

        if (isNaN(lineNum) || lineNum < 0) return [];

        let definitions: Definition = [];

        for (let i = 0; i < document.lineCount; i++) {
            const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)).split('#')[0].trim().split(/\s+/)[0];

            if(!line) continue;

            const num = parseInt(line);
            if (num === lineNum) {
                definitions.push({
                    uri: textDocumentPosition.textDocument.uri,
                    range: Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE)
                });
            }
        }

        if(!definitions.length) return [{ uri: textDocumentPosition.textDocument.uri, range: Range.create(textDocumentPosition.position.line, uinteger.MIN_VALUE, textDocumentPosition.position.line, uinteger.MAX_VALUE) }];

        return definitions;
    }
);

connection.onHover(
    (textDocumentPosition: HoverParams): Hover => {
        const document = documents.get(textDocumentPosition.textDocument.uri);

        if (!document) return { contents: [] };

        const line = document.getText(Range.create(textDocumentPosition.position.line, uinteger.MIN_VALUE, textDocumentPosition.position.line, uinteger.MAX_VALUE));

        const commentPos = line.indexOf('#');
        if(commentPos != -1 && textDocumentPosition.position.character >= commentPos) return { contents: [] };

        const word = getSelectedWord(document, textDocumentPosition.position);

        const instruction = getInstructionByName(word[0]);

        if(instruction) {
            return {
                contents: {
                    kind: MarkupKind.PlainText,
                    value: instruction.description
                },
                range: word[1]
            };
        }

        if(/^r(\d|1[0-5])$/i.test(word[0])) {
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

        return { contents: [] };
    }
);

// Language Server Start

documents.listen(connection);
connection.listen();
