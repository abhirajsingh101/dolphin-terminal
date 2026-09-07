import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
  exactCleanCandidateFailures,
  requiredExactCleanCandidateFailures,
} from './parityCandidateBinding.mjs';

function git(root, ...args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'dolphin-parity-binding-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'release-test@dolphin-terminal.invalid');
  git(root, 'config', 'user.name', 'Dolphin Terminal Release Test');
  writeFileSync(join(root, 'candidate.txt'), 'reviewed\n');
  git(root, 'add', 'candidate.txt');
  git(root, 'commit', '-qm', 'reviewed candidate');
  return { root, revision: git(root, 'rev-parse', 'HEAD') };
}

test('accepts only the exact clean candidate checkout', () => {
  const { root, revision } = fixture();
  try {
    assert.deepEqual(exactCleanCandidateFailures(root, revision), []);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('requires an externally supplied release candidate revision', () => {
  const { root } = fixture();
  try {
    assert.deepEqual(requiredExactCleanCandidateFailures(root, undefined), [
      'expected release candidate commit was not supplied',
    ]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects a clean descendant of the recorded candidate', () => {
  const { root, revision } = fixture();
  try {
    writeFileSync(join(root, 'successor.txt'), 'unreviewed\n');
    git(root, 'add', 'successor.txt');
    git(root, 'commit', '-qm', 'unreviewed successor');
    assert.match(
      requiredExactCleanCandidateFailures(root, revision).join('\n'),
      /does not equal/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects tracked worktree changes', () => {
  const { root, revision } = fixture();
  try {
    writeFileSync(join(root, 'candidate.txt'), 'dirty\n');
    assert.match(
      requiredExactCleanCandidateFailures(root, revision).join('\n'),
      /tracked or untracked changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an otherwise clean worktree with only an untracked file', () => {
  const { root, revision } = fixture();
  try {
    writeFileSync(join(root, 'untracked.txt'), 'unreviewed\n');
    assert.match(
      requiredExactCleanCandidateFailures(root, revision).join('\n'),
      /tracked or untracked changes/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
