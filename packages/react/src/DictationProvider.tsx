import { useTerminalRuntime } from './TerminalRuntime.js';

export function useDictation() {
  return useTerminalRuntime().dictation;
}
