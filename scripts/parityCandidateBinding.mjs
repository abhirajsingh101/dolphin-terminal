import { execFileSync } from 'node:child_process';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
  }).trim();
}

export function exactCleanCandidateFailures(root, expectedRevision) {
  const failures = [];
  if (!/^[0-9a-f]{40}$/.test(expectedRevision ?? '')) {
    return ['recorded candidate is not a full 40-character Git commit'];
  }
  let head;
  try {
    head = git(root, ['rev-parse', 'HEAD']);
  } catch {
    return ['supplied checkout does not have a readable Git HEAD'];
  }
  if (head !== expectedRevision) {
    failures.push(`supplied checkout HEAD ${head} does not equal ${expectedRevision}`);
  }
  try {
    const status = git(root, ['status', '--porcelain=v1', '--untracked-files=all']);
    if (status) failures.push('supplied checkout has tracked or untracked changes');
  } catch {
    failures.push('supplied checkout cleanliness could not be determined');
  }
  return failures;
}

export function requiredExactCleanCandidateFailures(root, expectedRevision) {
  if (!expectedRevision) {
    return ['expected release candidate commit was not supplied'];
  }
  return exactCleanCandidateFailures(root, expectedRevision);
}
