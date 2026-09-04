export { default as TerminalWorkspace } from './TerminalWorkspace.js';
export { default as SessionAutomationControl } from './SessionAutomationControl.js';
export { TerminalRuntimeProvider, useTerminalRuntime } from './TerminalRuntime.js';
export { defaultTerminalIcons } from './customization.js';
export { createTerminalHttpClient, TerminalHttpError } from './httpClient.js';
export { createTerminalDictationHttpClient } from './dictationClient.js';
export {
  TerminalDictationControl,
  TerminalDictationProvider,
  useTerminalDictation,
} from './TerminalDictation.js';
export type { TerminalHttpClient } from './httpClient.js';
export type {
  TerminalDictationControlProps,
  TerminalDictationProviderProps,
} from './TerminalDictation.js';
export type { TerminalWorkspaceProps } from './TerminalWorkspace.js';
export type { TerminalRuntimeProviderProps } from './TerminalRuntime.js';
export type { TerminalIconRegistry, TerminalRuntimeSlots } from './customization.js';
export type { SessionAutomationControlProps } from './SessionAutomationControl.js';
export type * from '@dolphin-terminal/protocol';
