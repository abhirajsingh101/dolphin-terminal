import assert from 'node:assert/strict';
import test from 'node:test';

import { containerVersionTagDecision } from './containerTagPreflight.mjs';

const releaseRevision = 'a'.repeat(40);

test('publishes only when the immutable version tag is absent', () => {
  assert.deepEqual(containerVersionTagDecision(null, releaseRevision), {
    publish: true,
    reason: 'tag-absent',
  });
});

test('treats the same existing revision as an idempotent rerun', () => {
  assert.deepEqual(
    containerVersionTagDecision(releaseRevision, releaseRevision),
    { publish: false, reason: 'matching-revision' },
  );
});

test('refuses to overwrite a version tag from another revision', () => {
  assert.throws(
    () => containerVersionTagDecision('b'.repeat(40), releaseRevision),
    /refusing to overwrite/,
  );
});
