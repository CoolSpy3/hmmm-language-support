import { TextDocument } from 'vscode-languageserver-textdocument';
import {
	CodeAction,
	CodeActionKind,
	CodeActionParams,
	CompletionList,
	CompletionParams,
	Definition,
	DefinitionParams,
	Diagnostic,
	DiagnosticSeverity,
	DocumentFormattingParams,
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
import {
	HMMMDetectedOperandType,
	HMMMInstruction,
	HMMMOperandType,
	InstructionPart,
	getInstructionByName,
	instructionRegex,
	preprocessLine,
	strictParseInt,
	validateOperand
} from '../../hmmm-spec/out/hmmm';
import {
	applyTrailingNewlineEdits,
	getExpectedInstructionNumber,
	getRangeForLine,
	getSelectedWord,
	isInIndexRange, populateInstructions, populateLineNumber, populateRegisters,
	preprocessDocumentLine,
} from './helperfunctions';

//#region Language Server Setup

// Create a connection for the server
const connection = createConnection(ProposedFeatures.all)

// Create a document manager to listen for changes to text documents and keep track of their source
// The client will send various document sync events. This object listens for those events and updates
// document objects so we can read them later
let documents: TextDocuments<TextDocument> = new TextDocuments(TextDocument)

// When the client connects, tell it what we can do
connection.onInitialize((params: InitializeParams) => {
	return {
		// Tell the client what we can do
		capabilities: {
			textDocumentSync: TextDocumentSyncKind.Incremental,
			codeActionProvider: true,
			completionProvider: {
				triggerCharacters: [' ', '\n']
			},
			definitionProvider: true,
			documentFormattingProvider: true,
			hoverProvider: true,
			referencesProvider: true
		}
	};
});

//#endregion

//#region Language Server Implementation

documents.onDidChangeContent(change => {
	validateTextDocument(change.document); // When the document changes, validate it
});

// Keep track of error causes, so we can suggest fixes
type HMMMErrorType = 'invalid_line' | 'missing_line_num' | 'incorrect_line_num' | 'invalid_operand' | 'invalid_register' | 'invalid_number' | 'unexpected_token' | 'missing_instruction' | 'invalid_instruction' | 'missing_operand' | 'too_many_operands';

/**
 * Validates a text document and sends diagnostics to the client
 *
 * @param textDocument The text document to validate
 * @returns A promise that resolves when the validation is complete
 */
async function validateTextDocument(textDocument: TextDocument): Promise<void> {
	/*
		Each line in the document should have the format: <line number> <instruction> <operand 1> <operand 2> <operand 3> # <comment>
		The line number should be the number of the instruction in the file, starting at 0
		The instruction should be one of the HMMM instructions
		The operands should be either registers (r0-r15) or numbers (-128 to 127 or 0 to 255), matching the type expected by the instruction
		The comment is optional and can be anything
		Flag any lines that don't match this format
	*/

	let diagnostics: Diagnostic[] = [];

	// Create an array of ranges which are the full line. This is used as a default in some cases if the regex fails to match
	const defaultIndices = Array(7).fill([uinteger.MIN_VALUE, uinteger.MAX_VALUE]);

	// Keep track of the number of lines that contain code so we can check if the line numbers are correct
	let numCodeLines = 0;

	for (let lineIdx = 0; lineIdx < textDocument.lineCount; lineIdx++) {
		// Get the line and remove any comments
		const line = preprocessDocumentLine(textDocument, lineIdx);

		if (!line.trim()) continue; // Skip empty lines

		// Try to match the line to the instruction regex
		let m: RegExpMatchArray | null;
		if (!(m = instructionRegex.exec(line))) {
			// If the regex fails to match, add an error diagnostic (The regex is pretty general, so this shouldn't happen)
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: getRangeForLine(lineIdx),
				message: `Invalid line!`,
				source: 'HMMM Language Server',
				data: 'invalid_line'
			});
			continue;
		}

		// Get the indices of the matched groups, if the regex fails to get the indices, use the default indices
		let indices = m.indices ?? defaultIndices;
		indices = indices.map(range => range ?? [uinteger.MIN_VALUE, uinteger.MAX_VALUE]); // Make sure all ranges are defined

		const lineNum = strictParseInt(m[InstructionPart.LINE_NUM]); // Get the line number

		if (isNaN(lineNum)) { // The line number is not a number
			diagnostics.push({ // Add an error diagnostic
				severity: DiagnosticSeverity.Error,
				range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][0] + 1),
				message: `Missing line number`,
				source: 'HMMM Language Server',
				data: 'missing_line_num'
			});

			// Assume the user just forgot a line number and the rest of the line is correct. Try to match the line with a line number of 0
			m = instructionRegex.exec(`0 ${line}`) ?? m;
			indices = m.indices ?? defaultIndices;
		} else if (lineNum !== numCodeLines) { // The line number is not correct
			diagnostics.push({ // Add a warning diagnostic
				severity: DiagnosticSeverity.Warning,
				range: Range.create(lineIdx, indices[InstructionPart.LINE_NUM][0], lineIdx, indices[InstructionPart.LINE_NUM][1]),
				message: `Incorrect line number! Should be ${numCodeLines}`,
				source: 'HMMM Language Server',
				data: 'incorrect_line_num'
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
		function reportOperandErrors(operandType: HMMMDetectedOperandType | undefined, operandIdx: number) {
			if (operandType === undefined) { // The operand is invalid
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
					message: `Invalid operand!`,
					source: 'HMMM Language Server',
					data: 'invalid_operand'
				});
			} else if (operandType === 'invalid_register') { // The operand is a register that is not r0-r15
				diagnostics.push({
					severity: DiagnosticSeverity.Error,
					range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
					message: `Invalid register! HMMM only supports registers r0-r15`,
					source: 'HMMM Language Server',
					data: 'invalid_register'
				});
			} else if (operandType === 'invalid_number') { // The operand is a number that is out of range
				diagnostics.push({
					severity: DiagnosticSeverity.Warning,
					range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
					message: `Invalid number! HMMM only supports numerical arguments from -128 to 127 (signed) or 0 to 255 (unsigned)`,
					source: 'HMMM Language Server',
					data: 'invalid_number'
				});
			}
		}

		let operand1Type: HMMMDetectedOperandType | undefined = undefined;
		let operand2Type: HMMMDetectedOperandType | undefined = undefined;
		let operand3Type: HMMMDetectedOperandType | undefined = undefined;

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
				data: 'unexpected_token'
			});
		}

		const instruction = m[InstructionPart.INSTRUCTION];

		if (!instruction) {
			// There is a line number, but no instruction
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: Range.create(lineIdx, Math.max(0, indices[InstructionPart.LINE_NUM][1] - 1), lineIdx, indices[InstructionPart.LINE_NUM][1]),
				message: `Expected instruction`,
				source: 'HMMM Language Server',
				data: 'missing_instruction'
			});
			continue;
		}

		// Try to get the instruction from the name
		const hmmmInstruction = getInstructionByName(instruction);

		if (!hmmmInstruction) {
			// The instruction is not valid
			diagnostics.push({
				severity: DiagnosticSeverity.Error,
				range: Range.create(lineIdx, indices[InstructionPart.INSTRUCTION][0], lineIdx, indices[InstructionPart.INSTRUCTION][1]),
				message: `Unknown instruction`,
				source: 'HMMM Language Server',
				data: 'invalid_instruction'
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
		function reportOperandTypeMismatchErrors(operand: string, operandType: HMMMDetectedOperandType | undefined, operandIdx: number, instruction: HMMMInstruction, expectedType: HMMMOperandType | undefined): boolean {
			if (expectedType) { // The instruction expects an operand
				if (operand) { // An operand was provided
					switch (expectedType) {
						case 'register':
							if (operandType !== 'register' && operandType !== 'r0' && operandType !== 'invalid_register') {
								diagnostics.push({ // The instruction expects a register, but the operand is not a register
									severity: DiagnosticSeverity.Error,
									range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
									message: `${instruction.name} expects a register as operand 1`,
									source: 'HMMM Language Server',
									data: 'invalid_register'
								});
							}
							break;
						case 'signed_number':
							if (operandType !== 'signed_number' && operandType !== 'number') {
								diagnostics.push({ // The instruction expects a signed number, but the operand is not a signed number
									severity: operandType === 'unsigned_number' || operandType === 'invalid_number' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, // Warning if the number is out of range, error otherwise
									range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
									message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
									source: 'HMMM Language Server',
									data: 'invalid_number'
								});
							}
							break;
						case 'unsigned_number':
							if (operandType !== 'unsigned_number' && operandType !== 'number') {
								diagnostics.push({ // The instruction expects an unsigned number, but the operand is not an unsigned number
									severity: operandType === 'signed_number' || operandType === 'invalid_number' ? DiagnosticSeverity.Warning : DiagnosticSeverity.Error, // Warning if the number is out of range, error otherwise
									range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
									message: `${instruction.name} expects a signed number (-128 to 127) as operand 1`,
									source: 'HMMM Language Server',
									data: 'invalid_number'
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
						data: 'missing_operand'
					});
					return true; // There are no more operands to check (because this one was missing), so stop checking for errors
				}
			} else if (operand) {
				diagnostics.push({ // The instruction does not expect an operand, but one was provided
					severity: DiagnosticSeverity.Error,
					range: Range.create(lineIdx, indices[operandIdx][0], lineIdx, indices[operandIdx][1]),
					message: `${instruction.name} only expects ${numExpectedArgs} argument${numExpectedArgs === 1 ? '' : 's'}`,
					source: 'HMMM Language Server',
					data: 'too_many_operands'
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

connection.onCodeAction(
	(params: CodeActionParams): CodeAction[] => {
		/*
			Suggest fixes for errors. Currently, this is only line numbers, but it could be expanded to other errors in the future (e.g. n vs r variants of instructions)
		*/

		let actions: CodeAction[] = [];
		params.context.diagnostics.forEach(diagnostic => {
			if (diagnostic.source !== 'HMMM Language Server') return; // Only handle diagnostics from the HMMM Language Server

			const document = documents.get(params.textDocument.uri);
			if (!document) return; // We can't read the document, so just return

			// Get the line and remove any comments
			const line = preprocessDocumentLine(document, diagnostic.range.start.line);

			// Get the cause of the diagnostic
			const errorCode = diagnostic.data as HMMMErrorType;

			switch (errorCode) {
				case 'incorrect_line_num': // The line number is incorrect, so suggest changing it to the expected line number
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
				case 'missing_line_num': // The line number is missing, so suggest adding it
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
				case 'too_many_operands': // There are too many operands, so suggest removing the extra ones
					{
						actions.push({
							title: 'Remove Extra Operands',
							kind: CodeActionKind.QuickFix,
							diagnostics: [diagnostic],
							edit: {
								changes: {
									[params.textDocument.uri]: [TextEdit.del(diagnostic.range)]
								}
							}
						});
						break;
					}
				case 'unexpected_token':
					{
						actions.push({
							title: 'Remove Unexpected Token',
							kind: CodeActionKind.QuickFix,
							diagnostics: [diagnostic],
							edit: {
								changes: {
									[params.textDocument.uri]: [TextEdit.del(diagnostic.range)]
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

connection.onCompletion(
	(params: CompletionParams): CompletionList => {
		/*
			We can suggest:
			- The next line number
			- Instructions
			- Registers

			If the cursor is at the start of the line, suggest the next line number or an instruction
			If the cursor is in an instruction, suggest an instruction
			If the cursor is in an operand, suggest a register if the instruction expects a register
		*/

		const document = documents.get(params.textDocument.uri);
		const completionList = CompletionList.create();

		if (!document) {
			// We can't read the document, so just suggest an instruction or register
			populateRegisters(completionList);
			populateInstructions(completionList);
			return completionList;
		}

		const line = preprocessDocumentLine(document, params.position.line);

		if (!line.trim()) {
			// The line is empty, so suggest the next line number or an instruction
			populateLineNumber(completionList, params.position.line, document);
			populateInstructions(completionList);
			return completionList;
		}

		// Try to parse the line as an instruction
		let m: RegExpMatchArray | null;
		if (!(m = instructionRegex.exec(line))?.indices || !m.indices) {
			// The line is invalid, so suggest an instruction
			populateInstructions(completionList);
			return completionList;
		}

		const indices = m.indices;
		const position = params.position.character;

		if (isInIndexRange(position, InstructionPart.OTHER, indices)) return completionList; // The cursor is at the end of the line, so don't suggest anything

		if (isInIndexRange(position, InstructionPart.LINE_NUM, indices)) {
			// The cursor is in the line number, so suggest the next line number
			populateLineNumber(completionList, params.position.line, document);

			if (isNaN(strictParseInt(m[InstructionPart.LINE_NUM]))) populateInstructions(completionList); // The line number is invalid, so suggest an instruction

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

		if ((!m[InstructionPart.OPERAND1] || isInIndexRange(position, InstructionPart.OPERAND1, indices)) && instruction.operand1 === 'register') {
			// The instruction expects a register argument, so suggest a register
			populateRegisters(completionList);
			return completionList;
		}
		if ((!m[InstructionPart.OPERAND2] || isInIndexRange(position, InstructionPart.OPERAND2, indices)) && instruction.operand2 === 'register') {
			// The instruction expects a register argument, so suggest a register
			populateRegisters(completionList);
			return completionList;
		}
		if ((!m[InstructionPart.OPERAND3] || isInIndexRange(position, InstructionPart.OPERAND3, indices)) && instruction.operand3 === 'register') {
			// The instruction expects a register argument, so suggest a register
			populateRegisters(completionList);
			return completionList;
		}

		// Couldn't find anything to suggest, so just return an empty list
		return completionList;
	}
);

connection.onDefinition(
	(params: DefinitionParams): Definition => {
		/*
			If the user tries to go to the definition of a line number in a jump or call instruction, return all lines with a matching line number
		*/

		// Get the document
		const document = documents.get(params.textDocument.uri);

		if (!document) return []; // We can't read the document, so just return an empty array

		const line = document.getText(getRangeForLine(params.position.line));

		const commentPos = line.indexOf('#');
		if (commentPos != -1 && params.position.character >= commentPos) return []; // The cursor is in a comment, so don't return anything

		const spacePos = line.indexOf(' ');
		if (spacePos != -1 && params.position.character <= spacePos) return []; // The cursor is before the instruction, so don't return anything

		const word = getSelectedWord(document, params.position)[0]; // Get the word at the cursor

		const lineNum = strictParseInt(word); // Try to interpret the word as a line number

		if (isNaN(lineNum) || lineNum < 0) return []; // The word is not a valid line number, so don't return anything

		// Try to interpret the line as an instruction
		let m: RegExpMatchArray | null;
		if (!(m = instructionRegex.exec(line))) return []; // The line is not an instruction, so don't return anything

		const instruction = m[InstructionPart.INSTRUCTION];

		if (!(instruction.toLowerCase().startsWith('j') || instruction.toLowerCase().startsWith('call'))) return []; // The instruction is not a jump or call; the numbers are meaningless, so don't return anything

		// Assume the number represents a line number that is being jumped to. Return all lines with a matching instruction number

		let definitions: Definition = [];

		for (let i = 0; i < document.lineCount; i++) { // Loop through all the lines in the document
			// Get the line and remove anything that's not an instruction number
			const line = preprocessDocumentLine(document, i).trim().split(/\s+/)[0];

			if (!line) continue; // Skip empty lines

			// Try to parse the instruction number
			const num = strictParseInt(line);
			if (num === lineNum) { // The instruction number matches the number we're looking for
				definitions.push({ // Add the line to the definitions
					uri: params.textDocument.uri,
					range: getRangeForLine(i)
				});
			}
		}

		// There were no matching lines. Return the current line, so the user receives "No definition found"
		if (!definitions.length) return [{ uri: params.textDocument.uri, range: getRangeForLine(params.position.line) }];

		return definitions;
	}
);

connection.onDocumentFormatting(
	(params: DocumentFormattingParams): TextEdit[] => {
		/**
		 * Format the document so all parts of each instruction are aligned
		 */

		const document = documents.get(params.textDocument.uri);

		if (!document) return []; // We can't read the document, so just return an empty array

		let maxLineNumLen = 0;
		let maxInstructionLen = 0;
		let maxOperand1Len = 0;
		let maxOperand2Len = 0;
		let maxOperand3Len = 0;

		// Loop through all the lines in the document to find the longest line number, instruction, and operands

		for (let i = 0; i < document.lineCount; i++) {
			// Get the line and remove any comments and leading/trailing whitespace
			const line = preprocessDocumentLine(document, i).trim();

			if (!line) continue; // Skip empty lines

			// Try to match the line to the instruction regex
			let m: RegExpMatchArray | null;
			if (!(m = instructionRegex.exec(line))) continue; // The line is not an instruction, so skip it

			// Convert the line number to an int and back to get the shortest string representation
			let lineNumNum = strictParseInt(m[InstructionPart.LINE_NUM]);

			if (isNaN(lineNumNum)) {
				// Assume the user just forgot a line number and the rest of the line is correct. Try to match the line with a line number of 0
				m = instructionRegex.exec(`0 ${line}`) ?? m;
				lineNumNum = 0;
			}

			const lineNumLen = lineNumNum.toString().length ?? 0;
			const instructionLen = m[InstructionPart.INSTRUCTION]?.length ?? 0;
			const operand1Len = m[InstructionPart.OPERAND1]?.length ?? 0;
			const operand2Len = m[InstructionPart.OPERAND2]?.length ?? 0;
			const operand3Len = m[InstructionPart.OPERAND3]?.length ?? 0;

			// Update the max lengths
			if (lineNumLen > maxLineNumLen) maxLineNumLen = lineNumLen;
			if (instructionLen > maxInstructionLen) maxInstructionLen = instructionLen;
			if (operand1Len > maxOperand1Len) maxOperand1Len = operand1Len;
			if (operand2Len > maxOperand2Len) maxOperand2Len = operand2Len;
			if (operand3Len > maxOperand3Len) maxOperand3Len = operand3Len;
		}

		let edits: TextEdit[] = [];

		// Loop through all the lines in the document again to format them
		for (let i = 0; i < document.lineCount; i++) {
			// Get the line
			const originalLine = document.getText(getRangeForLine(i));

			if (!originalLine) continue; // Skip empty lines

			const line = originalLine.trim(); // Remove any leading/trailing whitespace
			const commentStartPos = line.indexOf('#');

			if (commentStartPos == 0 || !line) {
				// The line does not contain any instructions, so remove any leading/trailing whitespace
				edits.push(TextEdit.replace(getRangeForLine(i), line));
				continue;
			}

			// Try to match the line to the instruction regex
			let m: RegExpMatchArray | null;
			if (!(m = instructionRegex.exec(preprocessLine(line)))) continue; // The line is not an instruction, so skip it

			// Convert the line number to an int and back to get the shortest string representation
			let lineNumNum = strictParseInt(m[InstructionPart.LINE_NUM]);

			if (isNaN(lineNumNum)) {
				// Assume the user just forgot a line number and the rest of the line is correct. Try to match the line with a line number of 0
				m = instructionRegex.exec(`0 ${line}`) ?? m;
				lineNumNum = 0;
			}

			const instructionLen = m[InstructionPart.INSTRUCTION]?.length ?? 0;
			const operand1Len = m[InstructionPart.OPERAND1]?.length ?? 0;
			const operand2Len = m[InstructionPart.OPERAND2]?.length ?? 0;
			const operand3Len = m[InstructionPart.OPERAND3]?.length ?? 0;

			// Calculate the number of spaces to add to the end of each part of the instruction
			const instructionSpaces = maxInstructionLen - instructionLen;
			const operand1Spaces = maxOperand1Len - operand1Len;
			const operand2Spaces = maxOperand2Len - operand2Len;
			const operand3Spaces = maxOperand3Len - operand3Len;

			/* What follows is some somewhat confusing formatting code. I'll try to explain it as best I can:
			 * For each part of the instruction (line number/instruction/operands), we want to write the part
			 * (padded to the max length). Then, we need another space before the next part, however,
			 * we don't want to add a space if  the next part will not be included (in any instruction).
			 * The reason for this is as follows:
			 * If we have the code:
			 * 0 setn r1 1 # Set r1 to 1
			 * 1 setn r2 2 # Set r2 to 2
			 * None of the instructions includes a 3rd operand. If we add a space after the 2nd operand, we get:
			 * 0 setn r1 1  # Set r1 to 1
			 * 1 setn r2 2  # Set r2 to 2
			 * This is inconsistent with the case where there is a third operand. However, if we omit the space if
			 * just the current instruction (rather than all instructions) doesn't include the operand, the code
			 * 0 setn r1 1     # Set r1 to 1
			 * 1 add  r1 r1 r1 # Set r2 to 2
			 * Would get formatted to
			 * 0 setn r1 1    # Set r1 to 1
			 * 1 add  r1 r1 r1 # Set r2 to 2
			 * Because the padding for the 3rd operand is included on the first line, but not the space after the second operand.
			 * Next, we append any extra text. This is invalid code, but we don't want the formatter to just delete stuff.
			 * Unlike the other parts, this has a forced space before and after it (if it exists). The reasoning is that if the line has a comment,
			 * we always want a space before the comment, and if it doesn't have one, we can just trim the extra space (which we would do anyways).
			 * Because the second space is only added if the "other" part exists, there is never any double spacing.
			 * Finally, we append the comment (if there is one) and trim any extra whitespace.
			 */

			function spaceBetween(maxLen: number): string {
				return maxLen === 0 ? '' : ' ';
			}

			const comment = commentStartPos != -1 ? line.slice(commentStartPos) : '';

			// Format the line
			const formattedLine = `${lineNumNum.toString().padStart(maxLineNumLen, '0')} ${m[InstructionPart.INSTRUCTION] ?? ''}${' '.repeat(instructionSpaces)}${spaceBetween(maxOperand1Len)}${m[InstructionPart.OPERAND1] ?? ''}${' '.repeat(operand1Spaces)}${spaceBetween(maxOperand2Len)}${m[InstructionPart.OPERAND2] ?? ''}${' '.repeat(operand2Spaces)}${spaceBetween(maxOperand3Len)}${m[InstructionPart.OPERAND3] ?? ''}${' '.repeat(operand3Spaces)} ${m[InstructionPart.OTHER] ?? ''}${m[InstructionPart.OTHER] ? ' ' : ''}${comment}`.trim();

			// Add the edit to the list of edits
			if (formattedLine !== originalLine) edits.push(TextEdit.replace(getRangeForLine(i), formattedLine));
		}

		const trailingNewlineEdit = applyTrailingNewlineEdits(params, document);
		if (trailingNewlineEdit) edits.push(trailingNewlineEdit);

		return edits;
	}
);

connection.onHover(
	(params: HoverParams): Hover => {
		/*
			Return the description of the instruction or register at the cursor
		*/

		// Get the document
		const document = documents.get(params.textDocument.uri);

		if (!document) return { contents: [] }; // We can't read the document, so just return an empty array

		// Get the text line
		const line = document.getText(getRangeForLine(params.position.line));

		const commentPos = line.indexOf('#');
		if (commentPos != -1 && params.position.character >= commentPos) return { contents: [] }; // The cursor is in a comment, so don't return anything

		const word = getSelectedWord(document, params.position); // Get the word at the cursor

		const instruction = getInstructionByName(word[0]); // Try to interpret the word as an instruction

		if (instruction) { // The word is an instruction, show the instruction description
			return {
				contents: {
					kind: MarkupKind.PlainText,
					value: instruction.description
				},
				range: word[1]
			};
		}

		if (/^r(\d|1[0-5])$/i.test(word[0])) { // Try to interpret the word as a register
			// Show the register description
			if (word[0] === 'r0') {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: 'Always 0'
					},
					range: word[1]
				};
			}
			if (word[0] === 'r13') {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: 'Return Value'
					},
					range: word[1]
				};
			}
			if (word[0] === 'r14') {
				return {
					contents: {
						kind: MarkupKind.Markdown,
						value: 'Return Address'
					},
					range: word[1]
				};
			}
			if (word[0] === 'r15') {
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
		/*
			Return all lines which jump to the line at the cursor
		*/

		// Get the document
		const document = documents.get(params.textDocument.uri);

		if (!document) return undefined; // We can't read the document, so just return undefined

		// Get the text line
		const line = document.getText(getRangeForLine(params.position.line));

		const commentPos = line.indexOf('#');
		if (commentPos != -1 && params.position.character >= commentPos) return undefined; // The cursor is in a comment, so don't return anything

		// We only support selecting the line number

		const spacePos = line.indexOf(' ');
		if (spacePos != -1 && params.position.character > spacePos) return undefined; // The cursor is after the instruction, so don't return anything

		const word = getSelectedWord(document, params.position); // Get the word at the cursor

		const lineNum = strictParseInt(word[0]); // Try to interpret the word as a line number

		if (isNaN(lineNum) || lineNum < 0) return undefined; // The word is not a valid line number, so don't return anything

		// Find all lines which jump to the given line number

		let locations: Location[] = [];

		for (let i = 0; i < document.lineCount; i++) { // Loop through all the lines in the document
			// Get the line and remove anything that's not an instruction number
			const line = preprocessDocumentLine(document, i);

			if (!line) continue; // Skip empty lines

			// Try to parse the instruction number
			let m: RegExpMatchArray | null;
			if (!(m = instructionRegex.exec(line))) continue;

			if (!m.indices) { // The regex failed to get the indices, so just check if the line contains the line number
				if (line.slice(line.indexOf(' ')).includes(lineNum.toString())) {
					locations.push({
						uri: params.textDocument.uri,
						range: getRangeForLine(i)
					});
				}
				continue;
			}

			// Check if the instruction is a jump or call
			if (!m[InstructionPart.INSTRUCTION] || !(m[InstructionPart.INSTRUCTION].toLowerCase().startsWith('j') || m[InstructionPart.INSTRUCTION].toLowerCase().startsWith('call'))) continue; // It's not :(

			// If it is, check if either of the operands are the line number
			if (m[InstructionPart.OPERAND1]) {
				const operand1 = m[InstructionPart.OPERAND1];
				if (strictParseInt(operand1) === lineNum) {
					locations.push({
						uri: params.textDocument.uri,
						range: getRangeForLine(i)
					});
				}
			}

			if (m[InstructionPart.OPERAND2]) {
				const operand2 = m[InstructionPart.OPERAND2];
				if (strictParseInt(operand2) === lineNum) {
					locations.push({
						uri: params.textDocument.uri,
						range: getRangeForLine(i)
					});
				}
			}

			// Operand 3 is never a number, so we don't need to check it
		}

		return locations;
	}
);

//#endregion

// Start the language server

documents.listen(connection);
connection.listen();
