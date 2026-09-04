import { describe, expect, it } from 'vitest';

import {
  buildWebLinkSegments,
  extractWebLinkCandidates,
} from './terminalWebLinks';

describe('extractWebLinkCandidates', () => {
  it('finds secure, local, and www website links', () => {
    const candidates = extractWebLinkCandidates(
      'Docs https://docs.example.com/a?q=tmux#links, local http://127.0.0.1:8421/status and www.example.org/help.',
    );

    expect(candidates.map(({ text, href }) => ({ text, href }))).toEqual([
      {
        text: 'https://docs.example.com/a?q=tmux#links',
        href: 'https://docs.example.com/a?q=tmux#links',
      },
      {
        text: 'http://127.0.0.1:8421/status',
        href: 'http://127.0.0.1:8421/status',
      },
      {
        text: 'www.example.org/help',
        href: 'https://www.example.org/help',
      },
    ]);
  });

  it('drops prose wrappers but keeps balanced URL parentheses', () => {
    const candidates = extractWebLinkCandidates(
      '(https://example.com/docs) and https://en.wikipedia.org/wiki/Function_(mathematics).',
    );

    expect(candidates.map((candidate) => candidate.text)).toEqual([
      'https://example.com/docs',
      'https://en.wikipedia.org/wiki/Function_(mathematics)',
    ]);
  });

  it('does not activate unsafe schemes or the tail of an email address', () => {
    expect(
      extractWebLinkCandidates(
        'javascript:alert(1) file:///tmp/a.txt person@www.example.com',
      ),
    ).toEqual([]);
  });
});

describe('buildWebLinkSegments', () => {
  it('rejoins to the exact terminal text including punctuation', () => {
    const text =
      'Codex: open <https://example.com/a?x=1#result>, then continue.';
    const segments = buildWebLinkSegments(text);

    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.kind === 'web')).toEqual([
      {
        kind: 'web',
        text: 'https://example.com/a?x=1#result',
        href: 'https://example.com/a?x=1#result',
      },
    ]);
  });
});
