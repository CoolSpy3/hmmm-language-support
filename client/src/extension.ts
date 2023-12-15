// Language client sample modified from https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/client/src/extension.ts

import * as path from 'path';
import { ExtensionContext } from 'vscode';

import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';

let hbClient: LanguageClient;
let hmmmClient: LanguageClient;

export function activate(context: ExtensionContext) {
	const hbServerModule = context.asAbsolutePath(path.join('server', 'out', 'hbserver.js'));
	const hmmmServerModule = context.asAbsolutePath(path.join('server', 'out', 'hmmmserver.js'));

	// Server options
	const hbServerOptions: ServerOptions = {
		run: { module: hbServerModule, transport: TransportKind.ipc },
		debug: {
			module: hbServerModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] } // Allow debugging
		}
	};
	const hmmmServerOptions: ServerOptions = {
		run: { module: hmmmServerModule, transport: TransportKind.ipc },
		debug: {
			module: hmmmServerModule,
			transport: TransportKind.ipc,
			options: { execArgv: ['--nolazy', '--inspect=6009'] } // Allow debugging
		}
	};

	// Client options
	const hbClientOptions: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'hb' }] };
	const hmmmClientOptions: LanguageClientOptions = { documentSelector: [{ scheme: 'file', language: 'hmmm' }] };

	// Create the language clients
	hbClient = new LanguageClient(
		'hbLanguageServer',
		'HMMM Binary Language Server',
		hbServerOptions,
		hbClientOptions
	);
	hmmmClient = new LanguageClient(
		'hmmmLanguageServer',
		'HMMM Language Server',
		hmmmServerOptions,
		hmmmClientOptions
	);

	// Start the clients. This will also launch the servers
	hbClient.start();
	hmmmClient.start();
}

export function deactivate(): Thenable<void> | undefined {
	if (!hbClient && !hmmmClient) {
		return undefined;
	}
	return Promise.all([hbClient?.stop(), hmmmClient?.stop()]).then(() => undefined);
}
