#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dolphinRoot = resolve(
  process.env.DOLPHIN_TASKS_ROOT ?? resolve(projectRoot, '..', 'dolphin-tasks'),
);
const requireDolphin = process.argv.includes('--require-dolphin');
const dolphinAvailable = existsSync(resolve(dolphinRoot, 'dolphin-web'));
const ledger = JSON.parse(readFileSync(resolve(projectRoot, 'parity/features.json'), 'utf8'));
const catalog = JSON.parse(
  readFileSync(resolve(projectRoot, 'parity/evidence-catalog.json'), 'utf8'),
);
const failures = [];
const expectedGroups = new Map([
  ['SESS', 14],
  ['LAY', 14],
  ['TERM', 12],
  ['UI', 8],
  ['SEL', 10],
  ['ATT', 8],
  ['VOICE', 7],
  ['AUTO', 7],
  ['HOST', 3],
]);
const roots = { standalone: projectRoot, dolphin: dolphinRoot };
const evidence = catalog.evidence ?? {};

function fail(message) {
  failures.push(message);
}

if (ledger.features?.length !== 83) fail(`expected 83 features, found ${ledger.features?.length}`);
const ids = new Set();
const actualGroups = new Map();
for (const feature of ledger.features ?? []) {
  if (ids.has(feature.id)) fail(`duplicate feature id ${feature.id}`);
  ids.add(feature.id);
  const match = /^DT-([A-Z]+)-\d{3}$/.exec(feature.id);
  if (!match) fail(`invalid feature id ${feature.id}`);
  else actualGroups.set(match[1], (actualGroups.get(match[1]) ?? 0) + 1);
  if (feature.status !== 'verified') fail(`${feature.id} is ${feature.status}`);
  for (const field of ['standalone_test', 'dolphin_integration_test']) {
    if (!feature[field] || !evidence[feature[field]]) {
      fail(`${feature.id} has missing ${field} evidence: ${feature[field] ?? 'null'}`);
    }
  }
  if (!['reviewed', 'automated_assertion', 'not_applicable'].includes(feature.visual_review_status)) {
    fail(`${feature.id} has unresolved visual status ${feature.visual_review_status}`);
  }
  if (feature.visual_review_status === 'reviewed' && !evidence[feature.visual_evidence]) {
    fail(`${feature.id} has missing reviewed visual evidence`);
  }
  if (feature.visual_review_status === 'automated_assertion' && !evidence[feature.visual_evidence]) {
    fail(`${feature.id} has missing browser assertion evidence`);
  }
}

for (const [group, count] of expectedGroups) {
  if (actualGroups.get(group) !== count) {
    fail(`expected ${count} ${group} features, found ${actualGroups.get(group) ?? 0}`);
  }
}

for (const [evidenceId, item] of Object.entries(evidence)) {
  const root = roots[item.repository];
  if (!root) {
    fail(`${evidenceId} names unknown repository ${item.repository}`);
    continue;
  }
  if (!item.command || !item.scope) fail(`${evidenceId} lacks command or scope`);
  if (item.repository === 'dolphin' && !dolphinAvailable) continue;
  for (const file of item.files ?? []) {
    if (!existsSync(resolve(root, file))) fail(`${evidenceId} file is missing: ${file}`);
  }
}

if (requireDolphin && !dolphinAvailable) {
  fail(`Dolphin Tasks checkout is required but missing: ${dolphinRoot}`);
}

if (failures.length) {
  console.error(`PARITY_LEDGER=FAIL (${failures.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}

console.log(
  `PARITY_LEDGER=PASS features=${ids.size} evidence=${Object.keys(evidence).length} dolphin_files=${dolphinAvailable ? 'verified' : 'external'}`,
);
