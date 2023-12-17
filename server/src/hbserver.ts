//#region Language Server Setup

import { TextDocument } from "vscode-languageserver-textdocument";
import {
    Diagnostic,
    DiagnosticSeverity,
    InitializeParams,
    InlayHint,
    InlayHintParams,
    ProposedFeatures,
    SemanticTokens,
    SemanticTokensBuilder,
    SemanticTokensParams,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    uinteger
} from "vscode-languageserver/node";
import { HMMMOperandType, parseBinaryInstruction } from "../../hmmm-spec/out/hmmm";
import { getRangeForLine } from "./helperfunctions";
import { TokenModifiers, TokenTypes, computeLegend } from "./semantictokens";

const connection = createConnection(ProposedFeatures.all)
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

connection.onInitialize((params: InitializeParams) => {
    return {
        // Tell the client what we can do
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            inlayHintProvider: true,
            semanticTokensProvider: {
                legend: computeLegend(params.capabilities.textDocument?.semanticTokens!),
                full: true
            }
        }
    };
});

//#endregion

//#region Language Server Implementation

/**
 * Validates a text document and sends diagnostics to the client
 *
 * @param textDocument The text document to validate
 * @returns A promise that resolves when the validation is complete
 */
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
    /*
        Flag invalid instructions
    */

    let diagnostics: Diagnostic[] = [];

    for(let i = 0; i < textDocument.lineCount; i++) {
        const lineRange = getRangeForLine(i);
        const line = textDocument.getText(lineRange);

        const instruction = parseBinaryInstruction(line);

        if(!instruction) {
            diagnostics.push({
                severity: DiagnosticSeverity.Error,
                range: lineRange,
                message: 'Invalid Instruction',
                source: 'HMMM Binary Language Server',
            });
        }
    }
}

documents.onDidChangeContent(change => {
    validateTextDocument(change.document); // When the document changes, validate it
});

connection.languages.inlayHint.on(
    (params: InlayHintParams): InlayHint[] => {
        /*
            Show inlay hint disassembly for each instruction
        */

        let document = documents.get(params.textDocument.uri);

        if(!document) return []; // If the document doesn't exist, return an empty array

        let hints: InlayHint[] = [];

        for(let i = 0; i < document.lineCount; i++) {
            const line = document.getText(getRangeForLine(i));

            const instruction = parseBinaryInstruction(line);

            if(instruction) {
                hints.push({
                    label: ` ${instruction.instruction.name}${instruction.operands.length !== 0 ? ' ' : ''}${instruction.operands.map(operand => `${operand.type === HMMMOperandType.REGISTER ? 'r' : ''}${operand.value}`).join(', ')}`,
                    position: {
                        line: i,
                        character: uinteger.MAX_VALUE
                    }
                });
            }
        }

        return hints;
    }
);

connection.languages.semanticTokens.on(
    (params: SemanticTokensParams): SemanticTokens => {
        /*
            Show semantic tokens for each instruction
        */

        let document = documents.get(params.textDocument.uri);

        const tokenBuilder = new SemanticTokensBuilder();

        if(!document) return tokenBuilder.build(); // If the document doesn't exist, return an empty array

        for(let i = 0; i < document.lineCount; i++) {
            const line = document.getText(getRangeForLine(i));

            const instruction = parseBinaryInstruction(line);

            if(!instruction) continue; // If the line isn't a valid instruction, skip it

            // Try to match the different parts of the instruction
            let m: RegExpExecArray | null;
            if(!(m = /^\s*([01]{4})\s*([01]{4})\s*([01]{4})\s*([01]{4})/d.exec(line))?.indices) continue; // If the line doesn't match the regex, skip it

            // Highlight the instruction
            tokenBuilder.push(i, m.indices[1][0], 4, TokenTypes.keyword, 0);

            /**
             * Gets the token type and modifiers for a register
             * @param register The register to get the token type for
             * @returns The token type and modifiers for the register
             */
            function getRegisterTokenType(register: number): [TokenTypes, TokenModifiers] {
                switch(register) { // This mostly works, but I think there are still some problems with TokenModifiers that I haven't been able to figure out yet
                    case 0:
                        return [TokenTypes.number, (1 << TokenModifiers.readonly) | (1 << TokenModifiers.defaultLibrary)];
                    case 13:
                    case 14:
                    case 15:
                        return [TokenTypes.variable, 1 << TokenModifiers.defaultLibrary];
                    default:
                        return [TokenTypes.parameter, 0];
                }
            }

            switch(instruction.instruction.operand1) {
                case HMMMOperandType.REGISTER:
                    {
                        const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[0].value);
                        tokenBuilder.push(i, m.indices[2][0], 4, tokenType, tokenModifier);
                        break;
                    }
                case HMMMOperandType.SIGNED_NUMBER:
                case HMMMOperandType.UNSIGNED_NUMBER:
                    {
                        tokenBuilder.push(i, m.indices[3][0], 4, TokenTypes.number, 0);
                        tokenBuilder.push(i, m.indices[4][0], 4, TokenTypes.number, 0);
                        break;
                    }
                default:
                    tokenBuilder.push(i, m.indices[2][0], 4, TokenTypes.keyword, 0);
            }
            switch(instruction.instruction.operand2) {
                case HMMMOperandType.REGISTER:
                    {
                        const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[1].value);
                        tokenBuilder.push(i, m.indices[3][0], 4, tokenType, tokenModifier);
                        break;
                    }
                case HMMMOperandType.SIGNED_NUMBER:
                case HMMMOperandType.UNSIGNED_NUMBER:
                    {
                        tokenBuilder.push(i, m.indices[3][0], 4, TokenTypes.number, 0);
                        tokenBuilder.push(i, m.indices[4][0], 4, TokenTypes.number, 0);
                        break;
                    }
                default:
                    tokenBuilder.push(i, m.indices[3][0], 4, TokenTypes.keyword, 0);
            }
            switch(instruction.instruction.operand3) {
                case HMMMOperandType.REGISTER:
                    {
                        const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[2].value);
                        tokenBuilder.push(i, m.indices[4][0], 4, tokenType, tokenModifier);
                        break;
                    }
                case HMMMOperandType.SIGNED_NUMBER:
                case HMMMOperandType.UNSIGNED_NUMBER:
                    // Numbers are never the third operand, so this should never happen
                    console.error(`Unexpected number as third operand in instruction ${instruction.instruction.name}`);
                    break;
                default:
                    tokenBuilder.push(i, m.indices[4][0], 4, TokenTypes.keyword, 0);
            }
        }

        return tokenBuilder.build();
    }
);

//#endregion

// Start the language server

documents.listen(connection);
connection.listen();
