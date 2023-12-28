import { DebugConfiguration, DebugConfigurationProvider, ProviderResult } from "vscode";

export class HMMMDebugConfigurationProvider implements DebugConfigurationProvider {

	constructor(private readonly isBinary: boolean) { }

	provideDebugConfigurations(): ProviderResult<DebugConfiguration[]> {
		return [
			{
				name: `Debug HMMM${this.isBinary ? ' (Binary)' : ''}`,
				type: 'hmmm',
				request: 'launch',
				program: '${file}',
				isBinary: this.isBinary
			}
		];
	}
}
