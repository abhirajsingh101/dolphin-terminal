/* Finding file paths in terminal output.
 *
 * Agents name files constantly — "wrote src/api.ts", "FAILED tests/x.py:214" —
 * and in select mode that text is sitting in the DOM where the names are
 * addressable. This turns a snapshot into candidate tokens with their offsets.
 * The server decides which ones are real files; buildSnapshotSegments splices
 * the survivors back in as links.
 *
 * The offsets are the contract. Whatever this module decides, rejoining the
 * segments has to reproduce the snapshot character for character: select mode
 * must never show text the terminal did not print.
 */

/* The backend deliberately accepts at most 300 candidates per request. A
   2,000-line agent snapshot can contain more than that, so the frontend keeps
   a larger bounded set and resolves it in safe-sized batches. */
export const MAX_PATH_CANDIDATES = 2000;
export const MAX_PATHS_PER_RESOLVE_REQUEST = 300;
const MAX_CANDIDATE_LENGTH = 4096;

export interface PathCandidate {
  /* Text exactly as it appeared in the terminal. */
  raw: string;
  /* Filesystem spelling sent to the resolver (for example, an escaped space
     in `My\ File.md` becomes a real space). */
  lookup: string;
  start: number;
  end: number;
}

export type SnapshotSegment =
  | { kind: 'text'; text: string }
  | { kind: 'path'; text: string; candidate: string };

/* ':' is inside the token class on purpose. Both of the rules that care about
   a colon — the compiler location suffix and the URL scheme — need to see one,
   and they cannot if the tokenizer splits there first. Brackets, quotes,
   commas and spaces are outside it, so "(src/api.ts)" needs no unwrapping. */
const TOKEN_PATTERN = /[\p{L}\p{N}._~+@%:/-]+(?:\\ [\p{L}\p{N}._~+@%:/-]+)*/gu;
const LOCATION_SUFFIX = /:\d+(?::\d+)?(?:-\d+(?::\d+)?)?$/;
const TRAILING_PUNCTUATION = /[.:]+$/;
const FILENAME_WITH_EXTENSION = /\.[\p{L}\p{N}]{1,16}$/u;
const DOTFILE_NAME = /^\.[\p{L}\p{N}][\p{L}\p{N}._-]*$/u;
const KNOWN_EXTENSIONLESS_FILES = new Set([
  'Containerfile',
  'Dockerfile',
  'Gemfile',
  'Justfile',
  'LICENSE',
  'Makefile',
  'NOTICE',
  'Procfile',
  'Rakefile',
  'README',
]);

function trimCandidate(token: string): string {
  return token.replace(LOCATION_SUFFIX, '').replace(TRAILING_PUNCTUATION, '');
}

function isPlausiblePath(candidate: string): boolean {
  if (candidate.length < 3 || candidate.length > MAX_CANDIDATE_LENGTH) {
    return false;
  }
  // '//host/path' is the tail of a URL whose scheme the tokenizer kept.
  if (candidate.includes('://') || candidate.startsWith('//')) return false;
  // At least one letter. Without this "1.5" reads as name-plus-extension and
  // every decimal number in the output becomes a candidate.
  if (!/\p{L}/u.test(candidate)) return false;
  return (
    candidate.includes('/') ||
    DOTFILE_NAME.test(candidate) ||
    FILENAME_WITH_EXTENSION.test(candidate) ||
    KNOWN_EXTENSIONLESS_FILES.has(candidate)
  );
}

function candidateFromToken(
  token: string,
  tokenStart: number,
): PathCandidate | null {
  let display = token;
  let start = tokenStart;
  let isFileUrl = false;

  /* Codex sometimes emits local links as file:///… and Claude uses @/… when
     referring to a file. Link only the path portion, not the decoration. */
  if (display.startsWith('file:///')) {
    display = display.slice('file://'.length);
    start += 'file://'.length;
    isFileUrl = true;
  } else if (
    display.startsWith('@/') ||
    display.startsWith('@~/') ||
    display.startsWith('@./') ||
    display.startsWith('@../')
  ) {
    display = display.slice(1);
    start += 1;
  }

  const raw = trimCandidate(display);
  if (!raw) return null;

  let lookup = raw.replace(/\\ /g, ' ');
  if (isFileUrl) {
    try {
      lookup = decodeURIComponent(lookup);
    } catch {
      return null;
    }
  }
  if (!isPlausiblePath(lookup)) return null;
  return { raw, lookup, start, end: start + raw.length };
}

export function extractPathCandidates(text: string): PathCandidate[] {
  const found: PathCandidate[] = [];

  /* Quoting is how shells and Markdown preserve paths containing spaces. Scan
     wrappers first, then let the ordinary token pass cover unquoted output. */
  for (const [open, close] of [
    ['`', '`'],
    ['"', '"'],
    ["'", "'"],
    ['<', '>'],
  ] as const) {
    let cursor = 0;
    while (cursor < text.length) {
      const openAt = text.indexOf(open, cursor);
      if (openAt < 0) break;
      const closeAt = text.indexOf(close, openAt + open.length);
      if (closeAt < 0) break;
      const innerStart = openAt + open.length;
      const candidate = candidateFromToken(
        text.slice(innerStart, closeAt),
        innerStart,
      );
      if (candidate) {
        found.push(candidate);
        cursor = closeAt + close.length;
      } else {
        /* A prose apostrophe can be followed by a real quoted path. Advance
           only past the opener so that the first closer can be reconsidered
           as the next opener. */
        cursor = openAt + open.length;
      }
    }
  }

  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const candidate = candidateFromToken(match[0], match.index ?? 0);
    if (candidate) found.push(candidate);
  }

  /* A generic token inside a quoted path overlaps the wrapper candidate. Keep
     the widest candidate at a given position and discard only overlaps, while
     retaining repeated paths at distinct positions. */
  found.sort((left, right) => left.start - right.start || right.end - left.end);
  const candidates: PathCandidate[] = [];
  let occupiedUntil = -1;
  for (const candidate of found) {
    if (candidates.length >= MAX_PATH_CANDIDATES) break;
    if (candidate.start < occupiedUntil) continue;
    candidates.push(candidate);
    occupiedUntil = candidate.end;
  }
  return candidates;
}

export function pathCandidateBatches(candidates: string[]): string[][] {
  const batches: string[][] = [];
  for (
    let index = 0;
    index < candidates.length;
    index += MAX_PATHS_PER_RESOLVE_REQUEST
  ) {
    batches.push(
      candidates.slice(index, index + MAX_PATHS_PER_RESOLVE_REQUEST),
    );
  }
  return batches;
}

export function buildSnapshotSegments(
  text: string,
  candidates: PathCandidate[],
  isLinkable: (candidate: string) => boolean,
): SnapshotSegment[] {
  const segments: SnapshotSegment[] = [];
  let cursor = 0;

  for (const candidate of candidates) {
    if (candidate.start < cursor) continue;
    if (!isLinkable(candidate.lookup)) continue;
    // Offsets can only be stale if the snapshot changed under us. Re-checking
    // is what keeps the round-trip property true rather than merely intended.
    if (text.slice(candidate.start, candidate.end) !== candidate.raw) continue;

    if (candidate.start > cursor) {
      segments.push({
        kind: 'text',
        text: text.slice(cursor, candidate.start),
      });
    }
    segments.push({
      kind: 'path',
      text: candidate.raw,
      candidate: candidate.lookup,
    });
    cursor = candidate.end;
  }

  if (cursor < text.length || segments.length === 0) {
    segments.push({ kind: 'text', text: text.slice(cursor) });
  }
  return segments;
}
