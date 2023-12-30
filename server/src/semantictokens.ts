// Copied from: https://github.com/microsoft/vscode-languageserver-node/blob/main/testbed/server/src/server.ts

import { SemanticTokensClientCapabilities, SemanticTokensLegend } from "vscode-languageserver/node";

export enum TokenTypes {
	comment = 0,
	keyword = 1,
	string = 2,
	number = 3,
	regexp = 4,
	type = 5,
	class = 6,
	interface = 7,
	enum = 8,
	typeParameter = 9,
	function = 10,
	member = 11,
	property = 12,
	variable = 13,
	parameter = 14,
	lambdaFunction = 15,
	_ = 16
}

export enum TokenModifiers {
	declaration = 0,
	definition = 1,
	readonly = 2,
	static = 3,
	deprecated = 4,
	abstract = 5,
	async = 6,
	modification = 7,
	documentation = 8,
	defaultLibrary = 9,
	_ = 10,
}

/**
 * Compute a semantic tokens legend for all tokens used by the server
 * @param capability The client capabilities
 * @returns A legend which maps all tokens used by the server to types used by the client
 */
export function computeLegend(capability: SemanticTokensClientCapabilities): SemanticTokensLegend {

	const clientTokenTypes = new Set<string>(capability.tokenTypes);
	const clientTokenModifiers = new Set<string>(capability.tokenModifiers);

	const tokenTypes: string[] = [];
	// For every token type used by the server,
	for (let i = 0; i < TokenTypes._; i++) {
		const str = TokenTypes[i];
		if (clientTokenTypes.has(str)) {
			// If the client supports the type, push it
			tokenTypes.push(str);
		} else {
			// If the client doesn't support the type, push something so that the indices don't get misaligned
			if (str === 'lambdaFunction') {
				tokenTypes.push('function');
			} else {
				tokenTypes.push('type');
			}
		}
	}

	const tokenModifiers: string[] = [];
	// For every token modifier used by the server,
	for (let i = 0; i < TokenModifiers._; i++) {
		const str = TokenModifiers[i];
		if (clientTokenModifiers.has(str)) {
			// If the client supports the modifier, push it
			tokenModifiers.push(str);
		} else {
			// If the client doesn't support the modifier, push something so that the indices don't get misaligned
			tokenModifiers.push('')
		}
	}

	return { tokenTypes, tokenModifiers };
}
