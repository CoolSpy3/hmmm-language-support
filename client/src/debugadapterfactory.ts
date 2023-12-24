import {
    DebugAdapterDescriptor,
    DebugAdapterDescriptorFactory,
    DebugAdapterInlineImplementation,
    DebugSession,
    ProviderResult
} from "vscode";
import { HMMMDebugSession } from "./debugadapter";

export class HMMMDebugAdapterFactory implements DebugAdapterDescriptorFactory {
	createDebugAdapterDescriptor(_session: DebugSession): ProviderResult<DebugAdapterDescriptor> {
		return new DebugAdapterInlineImplementation(new HMMMDebugSession());
	}
}
