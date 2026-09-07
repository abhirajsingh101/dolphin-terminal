#!/usr/bin/env node

import { execFileSync, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export function containerVersionTagDecision(existingRevision, releaseRevision) {
  if (!/^[0-9a-f]{40}$/.test(releaseRevision ?? '')) {
    throw new Error('release revision must be a full 40-character Git commit');
  }
  if (existingRevision === null) return { publish: true, reason: 'tag-absent' };
  if (existingRevision === releaseRevision) {
    return { publish: false, reason: 'matching-revision' };
  }
  throw new Error(
    `refusing to overwrite an existing version tag from revision ${existingRevision || 'unknown'}`,
  );
}

export function inspectContainerVersionTag(image, releaseRevision) {
  const inspected = spawnSync(
    'docker',
    ['buildx', 'imagetools', 'inspect', image],
    { encoding: 'utf8' },
  );
  if (inspected.status !== 0) {
    const diagnostic = `${inspected.stdout ?? ''}\n${inspected.stderr ?? ''}`;
    if (!/not found|manifest unknown|no such manifest/i.test(diagnostic)) {
      throw new Error(`container registry preflight failed: ${diagnostic.trim()}`);
    }
    return containerVersionTagDecision(null, releaseRevision);
  }

  execFileSync('docker', ['pull', image], {
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const existingRevision = execFileSync(
    'docker',
    [
      'image',
      'inspect',
      '--format',
      '{{ index .Config.Labels "org.opencontainers.image.revision" }}',
      image,
    ],
    { encoding: 'utf8' },
  ).trim();
  return containerVersionTagDecision(existingRevision, releaseRevision);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , image, releaseRevision] = process.argv;
  if (!image || !releaseRevision) {
    console.error('usage: containerTagPreflight.mjs <version-image> <release-sha>');
    process.exit(2);
  }
  try {
    const decision = inspectContainerVersionTag(image, releaseRevision);
    console.log(`publish=${decision.publish}`);
    console.error(`container version tag preflight: ${decision.reason}`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
