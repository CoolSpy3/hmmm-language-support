//#region Language Server Setup

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	Diagnostic,
	DiagnosticSeverity,
	DocumentFormattingParams,
	InitializeParams,
	InlayHint,
	InlayHintParams,
	ProposedFeatures,
	SemanticTokens,
	SemanticTokensBuilder,
	SemanticTokensParams,
	TextDocumentSyncKind,
	TextDocuments,
	TextEdit,
	createConnection,
	uinteger
} from 'vscode-languageserver/node';
import { binaryRegex, decompileInstruction, formatBinaryNumber, parseBinaryInstruction } from '../../hmmm-spec/out/hmmm';
import { applyTrailingNewlineEdits, getRangeForLine } from './helperfunctions';
import { TokenModifiers, TokenTypes, computeLegend } from './semantictokens';

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all);

// Create a document manager to listen for changes to text documents and keep track of their source
// The client will send various document sync events. This object listens for those events and updates
// document objects so we can read them later
const documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument);

// When the client connects, tell it what we can do
connection.onInitialize((params: InitializeParams) => {
	return {
		// Tell the client what we can do
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			documentFormattingProvider: true,
			inlayHintProvider: true,
			semanticTokensProvider: {
				legend: computeLegend(params.capabilities.textDocument?.semanticTokens ?? {
					tokenModifiers: [],
					tokenTypes: [],
					formats: [],
					requests: {}
				}),
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

	const diagnostics: Diagnostic[] = [];

	// For each line of the document
	for (let i = 0; i < textDocument.lineCount; i++) {
		const lineRange = getRangeForLine(i);
		const line = textDocument.getText(lineRange);

		if(!line.trim()) continue; // Skip empty lines

		// Try to parse the line as an instruction
		const instruction = parseBinaryInstruction(line);

		// If the line isn't a valid instruction, add a diagnostic
		if (!instruction) {
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: lineRange,
				message: 'Invalid Instruction',
				source: 'HMMM Binary Language Server',
			});
		}
	}

	// Send the diagnostics to the client
	connection.sendDiagnostics({ uri: textDocument.uri, diagnostics });
}

documents.onDidChangeContent(change => {
	validateTextDocument(change.document); // When the document changes, revalidate it
});

connection.languages.inlayHint.on(
	(params: InlayHintParams): InlayHint[] => {
		/*
			Show inlay hint disassembly for each instruction
		*/

		// Get the document from the document manager
		const document = documents.get(params.textDocument.uri);

		if (!document) return []; // If the document doesn't exist, return an empty array

		const hints: InlayHint[] = [];

		// For each line of the document
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.getText(getRangeForLine(i));

			// Try to parse the line as an instruction
			const instruction = parseBinaryInstruction(line);

			// If the line is a valid instruction, add an inlay hint showing its disassembly
			if (instruction) {
				hints.push({
					label: ` ${decompileInstruction(instruction)}`,
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

		// Get the document from the document manager
		const document = documents.get(params.textDocument.uri);

		const tokenBuilder = new SemanticTokensBuilder();

		if (!document) return tokenBuilder.build(); // If the document doesn't exist, don't return any tokens

		/**
		 * Adds a token to the token builder
		 * @param line The line the token is on
		 * @param range The characters that are part of the token
		 * @param type The type of the token
		 * @param modifiers The modifiers for the token (defaults to 0)
		 */
		function createToken(line: number, range: [number, number], type: number, modifiers: number = 0): void {
			tokenBuilder.push(line, range[0], range[1] - range[0], type, modifiers);
		}

		// For each line of the document
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.getText(getRangeForLine(i));

			// Try to parse the line as an instruction
			const instruction = parseBinaryInstruction(line);

			if (!instruction) continue; // If the line isn't a valid instruction, skip it

			// Try to match the different parts of the instruction
			let m: RegExpExecArray | null;
			if (!(m = binaryRegex.exec(line))?.indices) continue; // If the line doesn't match the regex, skip it

			// Highlight the instruction

			createToken(i, m.indices[1], TokenTypes.keyword);

			/**
			 * Gets the token type and modifiers for a register
			 * @param register The register to get the token type for
			 * @returns The token type and modifiers for the register
			 */
			function getRegisterTokenType(register: number): [TokenTypes, TokenModifiers] {
				switch (register) {
					case 0:
						return [TokenTypes.variable, (1 << TokenModifiers.readonly) | (1 << TokenModifiers.defaultLibrary)];
					case 13:
					case 14:
					case 15:
						return [TokenTypes.variable, 1 << TokenModifiers.defaultLibrary];
					default:
						return [TokenTypes.parameter, 0];
				}
			}

			let hasNumericOperand = false;
			switch (instruction.instruction.operand1) {
				case 'register':
				{
					const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[0].value);
					createToken(i, m.indices[2], tokenType, tokenModifier);
					break;
				}
				case 'signed_number':
				case 'unsigned_number':
				{
					hasNumericOperand = true;
					// If the operand is a number, the first nibble is part of the opcode
					createToken(i, m.indices[2], TokenTypes.keyword);
					// and the last two nibbles are the number
					createToken(i, m.indices[3], TokenTypes.number);
					createToken(i, m.indices[4], TokenTypes.number);
					break;
				}
				case undefined:
				default:
					// There is no operand 1, so the nibble part of the opcode
					createToken(i, m.indices[2], TokenTypes.keyword);
			}
			switch (instruction.instruction.operand2) {
				case 'register':
				{
					const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[1].value);
					createToken(i, m.indices[3], tokenType, tokenModifier);
					break;
				}
				case 'signed_number':
				case 'unsigned_number':
				{
					hasNumericOperand = true;
					createToken(i, m.indices[3], TokenTypes.number);
					createToken(i, m.indices[4], TokenTypes.number);
					break;
				}
				case undefined:
				default:
					if (!hasNumericOperand) {
						// There is no operand 2, so the nibble part of the opcode
						createToken(i, m.indices[3], TokenTypes.keyword);
					}
			}
			switch (instruction.instruction.operand3) {
				case 'register':
				{
					const [tokenType, tokenModifier] = getRegisterTokenType(instruction.operands[2].value);
					createToken(i, m.indices[4], tokenType, tokenModifier);
					break;
				}
				case 'signed_number':
				case 'unsigned_number':
				{
					// Numbers are never the third operand, so this should never happen
					console.error(`Unexpected number as third operand in instruction ${instruction.instruction.name}`);
					break;
				}
				case undefined:
				default:
					if (!hasNumericOperand) {
						// There is no operand 3, so the nibble part of the opcode
						createToken(i, m.indices[4], TokenTypes.keyword);
					}
			}
		}

		return tokenBuilder.build();
	}
);

connection.onDocumentFormatting(
	(params: DocumentFormattingParams): TextEdit[] => {
		/*
			Format the document
		*/

		// Get the document from the document manager
		const document = documents.get(params.textDocument.uri);

		if (!document) return []; // If the document doesn't exist, return an empty array

		const edits: TextEdit[] = [];

		// For each line of the document
		for (let i = 0; i < document.lineCount; i++) {
			const line = document.getText(getRangeForLine(i)).trim();

			if (!line) continue; // Skip empty lines

			// Format the line
			const formattedLine = formatBinaryNumber(line, false);

			// If formatting the line changed it, add an edit to make the change
			if (line !== formattedLine) edits.push({
				range: getRangeForLine(i),
				newText: formattedLine
			});
		}

		// Apply trailing newline edits
		const trailingNewlineEdit = applyTrailingNewlineEdits(params, document);
		if (trailingNewlineEdit) edits.push(trailingNewlineEdit);

		return edits;
	}
);

//#endregion

// Start the language server

documents.listen(connection);
connection.listen();
