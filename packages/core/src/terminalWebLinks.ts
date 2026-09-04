/* Website links in the terminal's selectable copy layer.
 *
 * This stays deliberately narrower than a general-purpose URI parser: http,
 * https, and the familiar www. shorthand are useful browser destinations;
 * file:, javascript:, and other schemes must remain inert terminal text.
 * Offsets preserve the same round-trip guarantee as terminalFilePaths.ts —
 * joining the rendered segments always reproduces exactly what the terminal printed.
 */

const WEB_URL_PATTERN = /(?:https?:\/\/|www\.)[^\s<>"'`]+/giu;
const MAX_WEB_URL_LENGTH = 4096;
const SENTENCE_PUNCTUATION = new Set(['.', ',', ';', ':', '!', '?']);
const CLOSING_DELIMITERS: Readonly<Record<string, string>> = {
  ')': '(',
  ']': '[',
  '}': '{',
};

export interface WebLinkCandidate {
  text: string;
  href: string;
  start: number;
  end: number;
}

export type WebLinkSegment =
  | { kind: 'text'; text: string }
  | { kind: 'web'; text: string; href: string };

function occurrences(text: string, character: string): number {
  let count = 0;
  for (const current of text) {
    if (current === character) count += 1;
  }
  return count;
}

function trimUrlEnding(value: string): string {
  let trimmed = value;
  let changed = true;

  while (trimmed && changed) {
    changed = false;
    const last = trimmed[trimmed.length - 1] ?? '';
    if (SENTENCE_PUNCTUATION.has(last)) {
      trimmed = trimmed.slice(0, -1);
      changed = true;
      continue;
    }

    const opener = CLOSING_DELIMITERS[last];
    if (
      opener &&
      occurrences(trimmed, last) > occurrences(trimmed, opener)
    ) {
      trimmed = trimmed.slice(0, -1);
      changed = true;
    }
  }

  return trimmed;
}

function safeWebHref(text: string): string | null {
  const href = text.toLowerCase().startsWith('www.')
    ? `https://${text}`
    : text;

  try {
    const parsed = new URL(href);
    if (!['http:', 'https:'].includes(parsed.protocol) || !parsed.hostname) {
      return null;
    }
    return href;
  } catch {
    return null;
  }
}

export function extractWebLinkCandidates(text: string): WebLinkCandidate[] {
  const candidates: WebLinkCandidate[] = [];

  for (const match of text.matchAll(WEB_URL_PATTERN)) {
    const start = match.index ?? 0;
    const previous = start > 0 ? text[start - 1] : '';
    /* Do not turn the tail of an identifier or email address into a link. */
    if (previous && /[\p{L}\p{N}_@]/u.test(previous)) continue;

    const display = trimUrlEnding(match[0]);
    if (!display || display.length > MAX_WEB_URL_LENGTH) continue;
    const href = safeWebHref(display);
    if (!href) continue;

    candidates.push({
      text: display,
      href,
      start,
      end: start + display.length,
    });
  }

  return candidates;
}

export function buildWebLinkSegments(text: string): WebLinkSegment[] {
  const segments: WebLinkSegment[] = [];
  let cursor = 0;

  for (const candidate of extractWebLinkCandidates(text)) {
    if (candidate.start < cursor) continue;
    if (text.slice(candidate.start, candidate.end) !== candidate.text) continue;

    if (candidate.start > cursor) {
      segments.push({ kind: 'text', text: text.slice(cursor, candidate.start) });
    }
    segments.push({
      kind: 'web',
      text: candidate.text,
      href: candidate.href,
    });
    cursor = candidate.end;
  }

  if (cursor < text.length || segments.length === 0) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}
