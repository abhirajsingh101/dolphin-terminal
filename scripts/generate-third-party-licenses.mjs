#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const runtimePackages = [
  '@dnd-kit/accessibility',
  '@dnd-kit/core',
  '@dnd-kit/utilities',
  '@xterm/addon-fit',
  '@xterm/addon-webgl',
  '@xterm/xterm',
  'lucide-react',
  'react',
  'react-dom',
  'react-resizable-panels',
  'scheduler',
  'tslib',
];
const allowedLicenses = new Set(['0BSD', 'Apache-2.0', 'ISC', 'MIT']);

const sections = runtimePackages.map((name) => {
  const packageRoot = resolve(projectRoot, 'node_modules', name);
  const metadata = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
  if (!allowedLicenses.has(metadata.license)) {
    throw new Error(`${name} uses unreviewed license ${metadata.license ?? 'UNKNOWN'}`);
  }
  const licenseName =
    ['LICENSE', 'LICENSE.md', 'LICENSE.txt'].find((candidate) => {
      try {
        readFileSync(resolve(packageRoot, candidate));
        return true;
      } catch {
        return false;
      }
    }) ?? null;
  if (!licenseName) throw new Error(`${name} has no packaged license text`);
  const licenseText = readFileSync(resolve(packageRoot, licenseName), 'utf8').trim();
  return [
    '================================================================================',
    `${name} ${metadata.version}`,
    `License: ${metadata.license}`,
    metadata.homepage ? `Project: ${metadata.homepage}` : null,
    '--------------------------------------------------------------------------------',
    licenseText,
  ]
    .filter(Boolean)
    .join('\n');
});

const output = [
  'Dolphin Terminal third-party runtime licenses',
  '',
  'Generated from the exact npm lockfile installation by',
  '`node scripts/generate-third-party-licenses.mjs`.',
  '',
  ...sections,
  '',
].join('\n');
const targets = [
  resolve(projectRoot, 'THIRD_PARTY_LICENSES.txt'),
  resolve(projectRoot, 'python/dolphin_terminal/THIRD_PARTY_LICENSES.txt'),
];

if (process.argv.includes('--check')) {
  for (const target of targets) {
    if (readFileSync(target, 'utf8') !== output) {
      throw new Error(`${target} is stale; regenerate third-party licenses`);
    }
  }
  console.log(`THIRD_PARTY_LICENSES=PASS packages=${runtimePackages.length}`);
} else {
  for (const target of targets) writeFileSync(target, output);
  console.log(`THIRD_PARTY_LICENSES=GENERATED packages=${runtimePackages.length}`);
}
