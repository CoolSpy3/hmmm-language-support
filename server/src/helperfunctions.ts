import { Position, TextDocument } from 'vscode-languageserver-textdocument';
import {
    CompletionItemKind,
    CompletionList,
    Range,
    uinteger
} from 'vscode-languageserver/node';
import { getInstructionRepresentation, getInstructionSignature, hmmmInstructions, preprocessLine } from '../../hmmm-spec/out/hmmm';

//#region VSCode

/**
 * Checks if a position is within a group in a RegExpMatchArray
 *
 * @param value The position to check
 * @param index The index of the group to check
 * @param indices The indices of the groups
 * @returns true if the position is within the group, false if it is not or the group was not found
 */
export function isInIndexRange(value: number, index: number, indices: RegExpIndicesArray): boolean {
    return (value >= indices[index]?.[0] && value <= indices[index]?.[1]) ?? false;
}

/**
 * Gets the word at the given position
 *
 * @param document The text document to get the word from
 * @param position The position to get the word at
 * @returns The word at the given position and the range of the word
 */
export function getSelectedWord(document: TextDocument, position: Position): [string, Range] {
    const line = document.getText(getRangeForLine(position.line)); // Get the whole line
    // Set the range to the given position (0 width)
    let wordRange = Range.create(position.line, position.character, position.line, position.character); // Copy position so start and end don't point to the same object
    while (wordRange.start.character > 0 && !/\s/.test(line[wordRange.start.character - 1])) wordRange.start.character--; // Move the start of the range to the beginning of the word
    while (wordRange.end.character < line.length && !/\s/.test(line[wordRange.end.character])) wordRange.end.character++; // Move the end of the range to the end of the word
    return [line.slice(wordRange.start.character, wordRange.end.character), wordRange]; // Return the word and the range
}

/**
 * Creates a range which spans the entire line
 * @param line The line number to create the range for
 * @returns A range which spans the entire line
 */
export function getRangeForLine(line: number): Range {
    return Range.create(line, uinteger.MIN_VALUE, line, uinteger.MAX_VALUE);
}

//#endregion

//#region HMMM

/**
 * Populates the completion list with the HMMM instructions
 *
 * @param completionList The completion list to populate
 */
export function populateInstructions(completionList: CompletionList) {
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
 * Gets the instruction number that should be expected at the given line number
 *
 * @param lineNumber The line number in the text document to check
 * @param document The text document to check
 * @returns The expected instruction number
 */
export function getExpectedInstructionNumber(lineNumber: number, document: TextDocument): number {
    let numCodeLines = 0; // Keep track of the number of lines that contain code so we can check the instruction numbers

    for(let i = 0; i < lineNumber; i++) { // Loop through all the lines before the given line
        // Get the line and remove any comments
        const line = preprocessDocumentLine(document, i);

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
export function populateLineNumber(completionList: CompletionList, lineNumber: number, document: TextDocument) {
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
export function populateRegisters(completionList: CompletionList) {
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
 * Preprocesses a line of HMMM code by removing comments and trimming trailing whitespace
 * @param document The document to read the line from
 * @param line The line number to preprocess
 * @returns The preprocessed line
 */

export function preprocessDocumentLine(document: TextDocument, line: number) {
    return preprocessLine(document.getText(getRangeForLine(line)));
}

//#endregion
