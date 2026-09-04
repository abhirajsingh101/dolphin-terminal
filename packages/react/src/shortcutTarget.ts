const TERMINAL_LIKE_SELECTOR =
  '.terminal-host, .xterm, .xterm-helper-textarea, [data-dolphin-terminal-input="true"]';

export function isTerminalLikeTarget(target: HTMLElement | null): boolean {
  return Boolean(target?.closest(TERMINAL_LIKE_SELECTOR));
}
