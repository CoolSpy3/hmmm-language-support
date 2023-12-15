//#region Language Server Setup

import { TextDocument } from "vscode-languageserver-textdocument";
import {
    InitializeParams,
    InlayHint,
    InlayHintParams,
    ProposedFeatures,
    Range,
    TextDocumentSyncKind,
    TextDocuments,
    createConnection,
    uinteger
} from "vscode-languageserver/node";
import { HMMMOperandType, parseBinaryInstruction } from "./hmmm";

const connection = createConnection(ProposedFeatures.all)
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

connection.onInitialize((params: InitializeParams) => {
    return {
        // Tell the client what we can do
        capabilities: {
            textDocumentSync: TextDocumentSyncKind.Incremental,
            inlayHintProvider: true
        }
    };
});

//#endregion

//#region Language Server Implementation

connection.languages.inlayHint.on(
    (params: InlayHintParams): InlayHint[] => {
        /*
            Show inlay hint disassembly for each instruction
        */

        let document = documents.get(params.textDocument.uri);

        if(!document) return []; // If the document doesn't exist, return an empty array

        let hints: InlayHint[] = [];

        for(let i = 0; i < document.lineCount; i++) {
            const line = document.getText(Range.create(i, uinteger.MIN_VALUE, i, uinteger.MAX_VALUE));

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

//#endregion

// Start the language server

documents.listen(connection);
connection.listen();