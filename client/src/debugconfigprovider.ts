import { DebugConfiguration, DebugConfigurationProvider, ProviderResult } from "vscode";

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
