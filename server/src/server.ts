// Modified from https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/server/src/server.ts

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
    Diagnostic,
    DiagnosticSeverity,
    DidChangeConfigurationNotification,
    InitializeParams,
    InitializeResult,
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
        hmmmInstr("halt",   0b0000_0000_0000_0000, undefined,                undefined,                       undefined,                "Halt Program!"),
        hmmmInstr("read",   0b0000_0000_0000_0001, HMMMOperandType.REGISTER, undefined,                       undefined,                "Stop for user input, which will then be stored in register rX (input is an integer from -32768 to +32767)"),
        hmmmInstr("write",  0b0000_0000_0000_0010, HMMMOperandType.REGISTER, undefined,                       undefined,                "Print contents of register rX"),
        hmmmInstr("jumpr",  0b0000_0000_0000_0011, HMMMOperandType.REGISTER, undefined,                       undefined,                "Set program counter to address in rX"),
        hmmmInstr("setn",   0b0001_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.SIGNED_NUMBER,   undefined,                "Set register rX equal to the integer N (-128 to +127)"),
        hmmmInstr("loadn",  0b0010_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "Load register rX with the contents of memory address N"),
        hmmmInstr("storen", 0b0011_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "Store contents of register rX into memory address N"),
        hmmmInstr("loadr",  0b0100_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Load register rX with the contents of memory address N"),
        hmmmInstr("storer", 0b0100_0000_0000_0001, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Store contents of register rX into memory address held in reg. rY"),
        hmmmInstr("popr",   0b0100_0000_0000_0010, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Load contents of register rX from stack pointed to by reg. rY"),
        hmmmInstr("pushr",  0b0100_0000_0000_0011, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Store contents of register rX onto stack pointed to by reg. rY"),
        hmmmInstr("addn",   0b0101_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.SIGNED_NUMBER,   undefined,                "Add integer N (-128 to 127) to register rX"),
        hmmmInstr("nop",    0b0110_0000_0000_0000, undefined,                undefined,                       undefined,                "Do nothing"),
        hmmmInstr("copy",   0b0110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Set rX = rY"),
        hmmmInstr("add",    0b0110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        HMMMOperandType.REGISTER, "Set rX = rY + rZ"),
        hmmmInstr("neg",    0b0111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        undefined,                "Set rX = -rY"),
        hmmmInstr("sub",    0b0111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        HMMMOperandType.REGISTER, "Set rX = rY - rZ"),
        hmmmInstr("mul",    0b1000_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        HMMMOperandType.REGISTER, "Set rx = rY * rZ"),
        hmmmInstr("div",    0b1001_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        HMMMOperandType.REGISTER, "Set rX = rY // rZ (integer division; rounds down; no remainder)"),
        hmmmInstr("mod",    0b1010_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.REGISTER,        HMMMOperandType.REGISTER, "Set rX = rY % rZ (returns the remainder of integer division)"),
        hmmmInstr("jumpn",  0b1011_0000_0000_0000, HMMMOperandType.UNSIGNED_NUMBER, undefined,                undefined,                "Set program counter to address N"),
        hmmmInstr("calln",  0b1011_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "Copy addr. of next instr. into rX and then jump to mem. addr. N"),
        hmmmInstr("jeqzn",  0b1100_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "If rX == 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jnezn",  0b1101_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "If rX != 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jgtzn",  0b1110_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "If rX > 0b0000_0000_0000_0000, then jump to line N"),
        hmmmInstr("jltzn",  0b1111_0000_0000_0000, HMMMOperandType.REGISTER, HMMMOperandType.UNSIGNED_NUMBER, undefined,                "If rX < 0b0000_0000_0000_0000, then jump to line N"),
    ];
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
                resolveProvider: true
            }
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
    if(!operand) return undefined;

    if(/r0/i.test(operand)) return HMMMDetectedOperandType.R0;

    if(/r\d+/i.test(operand)) {
        if(/r(\d|1[0-5])/i.test(operand)) return HMMMDetectedOperandType.REGISTER;
        return HMMMDetectedOperandType.INVALID_REGISTER;
    }

    const num = parseInt(operand);

    if(isNaN(num)) return undefined;

    if(num < -128 || num > 255) return HMMMDetectedOperandType.INVALID_NUMBER;
    if(num < 0) return HMMMDetectedOperandType.SIGNED_NUMBER;
    if(num > 127) return HMMMDetectedOperandType.UNSIGNED_NUMBER;
    return HMMMDetectedOperandType.NUMBER;
}

async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    let diagnostics: Diagnostic[] = [];
    const defaultIndices = Array(7).fill([uinteger.MIN_VALUE, uinteger.MAX_VALUE]);

    let numCodeLines = 0;
    console.log(instructionRegex);

    for(let lineIdx = 0; lineIdx < textDocument.lineCount; lineIdx++) {
        const line = textDocument.getText(Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE)).split('#')[0].trimEnd();

        if(!line.trim()) continue;

        let m: RegExpMatchArray | null;
        if(!(m = instructionRegex.exec(line))) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, uinteger.MIN_VALUE, lineIdx, uinteger.MAX_VALUE),
                message: `Invalid line!`,
                source: 'HMMM Language Server'
            });
            continue;
        }

        let indices = m.indices ?? defaultIndices;

        const FULL_LINE = 0;
        const LINE_NUM = 1;
        const INSTRUCTION = 2;
        const OPERAND1 = 3;
        const OPERAND2 = 4;
        const OPERAND3 = 5;
        const OTHER = 6;

        const lineNum = parseInt(m[LINE_NUM]);

        if(isNaN(lineNum)) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[LINE_NUM][0], lineIdx, indices[LINE_NUM][0]+1),
                message: `Missing line number`,
                source: 'HMMM Language Server'
            });

            m = instructionRegex.exec(`0 ${line}`) ?? m;
            indices = m.indices ?? defaultIndices;
        } else if(lineNum !== numCodeLines) {
            diagnostics.push({
                severity: DiagnosticSeverity.Warning,
                range: Range.create(lineIdx, indices[LINE_NUM][0], lineIdx, indices[LINE_NUM][1]),
                message: `Incorrect line number! Should be ${numCodeLines}`,
                source: 'HMMM Language Server'
            });
        }

        numCodeLines++;

        if(m[OTHER]) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[OTHER][0], lineIdx, indices[OTHER][1]),
                message: `Unexpected token!`,
                source: 'HMMM Language Server'
            });
        }

        const instruction = m[INSTRUCTION];

        if(!instruction) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, Math.max(0, indices[LINE_NUM][1]-1), lineIdx, indices[LINE_NUM][1]),
                message: `Expected instruction`,
                source: 'HMMM Language Server'
            });
            continue;
        }

        const hmmmInstruction = hmmmInstructions.find(instr => instr.name === instruction);

        if(!hmmmInstruction) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: Range.create(lineIdx, indices[INSTRUCTION][0], lineIdx, indices[INSTRUCTION][1]),
                message: `Unknown instruction`,
                source: 'HMMM Language Server'
            });
        }

        const operand1 = m[OPERAND1];
        const operand2 = m[OPERAND2];
        const operand3 = m[OPERAND3];

        function reportOperandErrors(operandType: HMMMDetectedOperand, operandIdx: number) {
            if(operandType === undefined) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid operand!`,
                    source: 'HMMM Language Server'
                });
            } else if(operandType === HMMMDetectedOperandType.INVALID_REGISTER) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `Invalid register! HMMM only supports registers r0-r15`,
                    source: 'HMMM Language Server'
                });
            } else if(operandType === HMMMDetectedOperandType.INVALID_NUMBER) {
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

        if(operand1) {
            operand1Type = validateOperand(operand1);
            reportOperandErrors(operand1Type, OPERAND1);
        }
        if(operand2) {
            operand2Type = validateOperand(operand2);
            reportOperandErrors(operand2Type, OPERAND2);
        }
        if(operand3) {
            operand3Type = validateOperand(operand3);
            reportOperandErrors(operand3Type, OPERAND3);
        }

        if(!hmmmInstruction) continue;

        const numExpectedArgs = [hmmmInstruction.operand1, hmmmInstruction.operand2, hmmmInstruction.operand3].filter(operand => operand !== undefined).length;

        function reportOperandTypeMismatchErrors(operand: string, operandType: HMMMDetectedOperand, operandIdx: number, instruction: HMMMInstruction, expectedType: HMMMOperand): boolean {
            if(expectedType) {
                if(operand) {
                    switch(expectedType) {
                        case HMMMOperandType.REGISTER:
                            if(operandType !== HMMMDetectedOperandType.REGISTER && operandType !== HMMMDetectedOperandType.R0) {
                                diagnostics.push({
                                    severity: DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a register as operand 1`,
                                    source: 'HMMM Language Server'
                                });
                            }
                            break;
                        case HMMMOperandType.SIGNED_NUMBER:
                            if(operandType !== HMMMDetectedOperandType.SIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
                                diagnostics.push({
                                    severity: operandType === HMMMDetectedOperandType.UNSIGNED_NUMBER || operandType === HMMMDetectedOperandType.INVALID_NUMBER ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error,
                                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                                    message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
                                    source: 'HMMM Language Server'
                                });
                            }
                            break;
                        case HMMMOperandType.UNSIGNED_NUMBER:
                            if(operandType !== HMMMDetectedOperandType.UNSIGNED_NUMBER && operandType !== HMMMDetectedOperandType.NUMBER) {
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
                        range: Range.create(lineIdx, indices[INSTRUCTION][0], lineIdx, indices[INSTRUCTION][1]),
                        message: `${instruction.name} expects ${numExpectedArgs} arguments`,
                        source: 'HMMM Language Server'
                    });
                    return true;
                }
            } else if(operand) {
                diagnostics.push({
                    severity: DiagnosticSeverity.Error,
                    range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
                    message: `${instruction.name} only expects ${numExpectedArgs} arguments`,
                    source: 'HMMM Language Server'
                });
            }
            return false;
        }

        if(reportOperandTypeMismatchErrors(operand1, operand1Type, OPERAND1, hmmmInstruction, hmmmInstruction.operand1)) continue;
        if(reportOperandTypeMismatchErrors(operand2, operand2Type, OPERAND2, hmmmInstruction, hmmmInstruction.operand2)) continue;
        if(reportOperandTypeMismatchErrors(operand3, operand3Type, OPERAND3, hmmmInstruction, hmmmInstruction.operand3)) continue;

    }

    connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

// Language Server Start

documents.listen(connection);
connection.listen();
