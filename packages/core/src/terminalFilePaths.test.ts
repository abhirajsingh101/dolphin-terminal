import { describe, expect, it } from 'vitest';

import {
  MAX_PATH_CANDIDATES,
  MAX_PATHS_PER_RESOLVE_REQUEST,
  buildSnapshotSegments,
  extractPathCandidates,
  pathCandidateBatches,
} from './terminalFilePaths';

function raws(text: string): string[] {
  return extractPathCandidates(text).map((candidate) => candidate.raw);
}

describe('extractPathCandidates', () => {
  it('finds absolute, relative and bare-filename paths', () => {
    expect(raws('wrote dolphin-web/src/api.ts and README.md')).toEqual([
      'dolphin-web/src/api.ts',
      'README.md',
    ]);
    expect(raws('see /home/user/logs/backend.log')).toEqual([
      '/home/user/logs/backend.log',
    ]);
    expect(raws('open ~/.claude/settings.json')).toEqual([
      '~/.claude/settings.json',
    ]);
  });

  it('strips the location suffix compilers print', () => {
    expect(raws('FAILED tests/test_tmux.py:214')).toEqual(['tests/test_tmux.py']);
    expect(raws('at src/api.ts:12:5 in')).toEqual(['src/api.ts']);
    expect(raws('at src/api.ts:12-18 in')).toEqual(['src/api.ts']);
  });

  it('understands Codex and Claude path decorations', () => {
    expect(raws('open file:///srv/projects/brain/ops/tasks.md')).toEqual([
      '/srv/projects/brain/ops/tasks.md',
    ]);
    expect(raws('review @/home/user/projects/example/AGENTS.md')).toEqual(
      ['/home/user/projects/example/AGENTS.md'],
    );
  });

  it('keeps quoted, escaped-space and unicode paths intact', () => {
    const text = [
      "Claude's note says 'docs/My Plan.md'",
      'open `/srv/projects/My Project/보고서.md:12`',
      'then ./build/My\\ Report.pdf',
      'and <docs/Release Notes.md>',
    ].join(' ');
    const candidates = extractPathCandidates(text);

    expect(candidates.map((candidate) => candidate.raw)).toEqual([
      'docs/My Plan.md',
      '/srv/projects/My Project/보고서.md',
      './build/My\\ Report.pdf',
      'docs/Release Notes.md',
    ]);
    expect(candidates.map((candidate) => candidate.lookup)).toEqual([
      'docs/My Plan.md',
      '/srv/projects/My Project/보고서.md',
      './build/My Report.pdf',
      'docs/Release Notes.md',
    ]);
  });

  it('offers common extensionless files to the resolver', () => {
    expect(raws('updated Dockerfile, Makefile and LICENSE')).toEqual([
      'Dockerfile',
      'Makefile',
      'LICENSE',
    ]);
  });

  it('strips trailing punctuation without eating leading dots', () => {
    expect(raws('edited src/api.ts.')).toEqual(['src/api.ts']);
    expect(raws('(src/api.ts:12)')).toEqual(['src/api.ts']);
    expect(raws('config: .env works')).toEqual(['.env']);
  });

  it('finds dotfiles whose name is longer than an extension', () => {
    expect(raws('check .gitignore and .env now')).toEqual(['.gitignore', '.env']);
  });

  it('rejects URLs, bare numbers and short noise', () => {
    expect(raws('https://example.com/docs/guide.html')).toEqual([]);
    expect(raws('took 1.5 seconds, 12:30 elapsed')).toEqual([]);
    expect(raws('ok')).toEqual([]);
  });

  it('reports offsets that address the trimmed token in the source', () => {
    const text = 'at (src/api.ts:12) now';
    const [candidate] = extractPathCandidates(text);

    expect(candidate.raw).toBe('src/api.ts');
    expect(text.slice(candidate.start, candidate.end)).toBe('src/api.ts');
  });

  it('keeps every occurrence, and caps the list', () => {
    const text = Array.from(
      { length: MAX_PATH_CANDIDATES + 50 },
      (_, index) => `file-${index}.txt`,
    ).join(' ');
    expect(extractPathCandidates(text)).toHaveLength(MAX_PATH_CANDIDATES);

    expect(raws('a/b.ts a/b.ts a/b.ts')).toEqual(['a/b.ts', 'a/b.ts', 'a/b.ts']);
  });
});

describe('buildSnapshotSegments', () => {
  /* The property that matters. Select mode must never show text the terminal
     did not print, so whatever the segmentation does, rejoining has to
     reproduce the snapshot character for character. */
  it('reproduces the input exactly when rejoined', () => {
    const text = 'wrote src/api.ts:12 and (README.md).\nnext /tmp/x.log line\n';
    const segments = buildSnapshotSegments(
      text,
      extractPathCandidates(text),
      () => true,
    );
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('links only what the resolver accepted', () => {
    const text = 'src/api.ts and src/gone.ts';
    const segments = buildSnapshotSegments(
      text,
      extractPathCandidates(text),
      (candidate) => candidate === 'src/api.ts',
    );
    const linked = segments.filter((segment) => segment.kind === 'path');

    expect(linked).toHaveLength(1);
    expect(linked[0].text).toBe('src/api.ts');
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('returns one text segment when nothing is linkable', () => {
    expect(buildSnapshotSegments('plain output', [], () => true)).toEqual([
      { kind: 'text', text: 'plain output' },
    ]);
  });

  it('drops candidates whose offsets no longer match the text', () => {
    const text = 'src/api.ts here';
    const stale = [
      {
        raw: 'src/other.ts',
        lookup: 'src/other.ts',
        start: 0,
        end: 12,
      },
    ];

    const segments = buildSnapshotSegments(text, stale, () => true);

    expect(segments).toEqual([{ kind: 'text', text }]);
  });

  it('links every occurrence of a repeated path', () => {
    const text = 'a/b.ts then a/b.ts';
    const segments = buildSnapshotSegments(
      text,
      extractPathCandidates(text),
      () => true,
    );

    expect(segments.filter((segment) => segment.kind === 'path')).toHaveLength(2);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });
});

describe('pathCandidateBatches', () => {
  it('resolves every candidate without exceeding the backend request cap', () => {
    const candidates = Array.from(
      { length: MAX_PATH_CANDIDATES },
      (_, index) => `path-${index}.txt`,
    );
    const batches = pathCandidateBatches(candidates);

    expect(batches.flat()).toEqual(candidates);
    expect(
      batches.every((batch) => batch.length <= MAX_PATHS_PER_RESOLVE_REQUEST),
    ).toBe(true);
    expect(batches).toHaveLength(
      Math.ceil(MAX_PATH_CANDIDATES / MAX_PATHS_PER_RESOLVE_REQUEST),
    );
  });
});
