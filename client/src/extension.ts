// Language client sample modified from https://github.com/microsoft/vscode-extension-samples/blob/main/lsp-sample/client/src/extension.ts

import * as path from 'path';
import { DebugConfigurationProviderTriggerKind, ExtensionContext, TextEditor, commands, debug, window } from 'vscode';

import { readFileSync, writeFileSync } from 'fs';
import {
	LanguageClient,
	LanguageClientOptions,
	ServerOptions,
	TransportKind
} from 'vscode-languageclient/node';
import { compile } from '../../hmmm-spec/out/hmmm';
import { HMMMDebugAdapterFactory } from './debugadapterfactory';
import { HMMMDebugConfigurationProvider } from './debugconfigprovider';

let hbClient: LanguageClient;
let hmmmClient: LanguageClient;

export function activate(context: ExtensionContext) {
	// Start the language servers
	{
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

	// Register the debugger
	{
		// Register the debug adapter
		context.subscriptions.push(debug.registerDebugAdapterDescriptorFactory('hmmm', new HMMMDebugAdapterFactory()));

		// Register the debug configuration provider
		context.subscriptions.push(debug.registerDebugConfigurationProvider('hmmm', new HMMMDebugConfigurationProvider(), DebugConfigurationProviderTriggerKind.Dynamic));
	}

	// Register the commands
	{
		context.subscriptions.push(commands.registerTextEditorCommand('hmmm.build', async (textEditor: TextEditor) => {
			const inFile = textEditor.document.uri.fsPath;
			const outFile = await window.showSaveDialog({
				defaultUri: textEditor.document.uri.with({ path: `${inFile.substring(0, inFile.lastIndexOf('.'))}.hb` }),
				filters: {
					'HMMM Binary': ['hb'],
					'All Files': ['*']
				}
			});

			if (outFile) {
				commands.executeCommand('workbench.action.files.save');
				const code = readFileSync(inFile).toString().split('\n');
				const compiledCode = compile(code);
				if(!compiledCode) {
					window.showErrorMessage('HMMM file contains errors. Please fix them before building.');
					return;
				}
				writeFileSync(outFile.fsPath, compiledCode[0].join('\n') + '\n');
			}
		}));
	}
}

export function deactivate(): Thenable<void> | undefined {
	if (!hbClient && !hmmmClient) {
		return undefined;
	}
	return Promise.all([hbClient?.stop(), hmmmClient?.stop()]).then(() => undefined);
}
