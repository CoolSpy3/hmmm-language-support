import {
	DebugAdapterDescriptor,
	DebugAdapterDescriptorFactory,
	DebugAdapterInlineImplementation,
	DebugConfiguration,
	DebugConfigurationProvider,
	DebugSession,
	ProviderResult
} from "vscode";
import { HMMMDebugSession } from "./debugadapter";

export class HMMMDebugAdapterFactory implements DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: DebugSession): ProviderResult<DebugAdapterDescriptor> {
		return new DebugAdapterInlineImplementation(new HMMMDebugSession());
	}
}

export class HMMMDebugConfigurationProvider implements DebugConfigurationProvider {
	provideDebugConfigurations(): ProviderResult<DebugConfiguration[]> {
		return [
			{
				name: 'Debug HMMM',
				type: 'hmmm',
				request: 'launch',
				program: '${file}',
				isBinary: false
			},
			{
				name: 'Debug HMMM (Binary)',
				type: 'hmmm',
				request: 'launch',
				program: '${file}',
				isBinary: true
			}
		];
	}
}
