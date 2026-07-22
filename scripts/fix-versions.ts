import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { analyzeProject, planFixes, printFixPlan } from './versions-common.ts';

// Fixes the version mismatches reported by verify-versions.ts, applying the
// fix plan from versions-common.ts:
//
// - Declared ranges in package.json files that don't match the manifest are
//   rewritten to the manifest version, keeping the range style (^, ~ or an
//   exact pin).
// - Lockfile entries that resolved to a different version than the manifest
//   are corrected with `yarn set resolution` when their range allows the
//   manifest version, which lets yarn rewrite the yarn.lock consistently
//   instead of editing it by hand.
// - Lockfile entries whose range cannot reach the manifest version (for
//   example ^0.15.1 vs 0.17.2 - caret ranges don't cross minor versions on
//   0.x) come from a dependency that was built against an older Backstage
//   release. The npm registry is queried for the newest version of that
//   dependency whose @backstage/* ranges allow the manifest versions, and
//   the dependency is bumped to it - within its selector range via
//   `yarn set resolution`, or by rewriting the declaring package.json files
//   when the compatible version is outside the range.
//
// Because one round of fixes can surface new lockfile entries (a bumped
// dependency pulls in new descriptors), the script re-analyzes and fixes
// until nothing changes anymore.
//
// After changing declared ranges a `yarn install` is required to update the
// lockfile - pass --install to run it automatically.
//
// Usage: tsx scripts/fix-versions.ts <project-path-or-package.json> [--dry-run] [--install]

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const install = args.includes('--install');
const input = args.find((arg) => !arg.startsWith('--'));
if (!input) {
  console.error('Usage: tsx scripts/fix-versions.ts <project-path-or-package.json> [--dry-run] [--install]');
  process.exit(1);
}

const prefix = dryRun ? '[dry-run] ' : '';

const runYarn = (projectRoot: string, yarnArgs: string[]) => {
  console.log(`${prefix}$ yarn ${yarnArgs.join(' ')}`);
  if (dryRun) {
    return;
  }
  const result = spawnSync('yarn', yarnArgs, { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`yarn failed with exit code ${result.status}`);
    process.exit(1);
  }
};

const maxPasses = 5;
for (let pass = 1; pass <= maxPasses; pass++) {
  const analysis = await analyzeProject(input);
  if (analysis.mismatches.length === 0) {
    console.log(pass === 1 ? 'All versions match the manifest, nothing to fix.' : 'All versions match the manifest now.');
    process.exit(0);
  }

  console.log(`${prefix}Fix pass ${pass}: ${analysis.mismatches.length} mismatches`);
  const plan = await planFixes(analysis);

  for (const fix of plan.declaredFixes) {
    console.log(`${prefix}${fix.packageJson}: ${fix.dependency} (${fix.section}) ${fix.from} -> ${fix.to}`);
    if (!dryRun) {
      const filePath = path.join(analysis.projectRoot, fix.packageJson);
      const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      packageJson[fix.section][fix.dependency] = fix.to;
      fs.writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`);
    }
  }
  for (const fix of plan.resolutionFixes) {
    runYarn(analysis.projectRoot, ['set', 'resolution', fix.descriptor, `npm:${fix.version}`]);
  }
  printFixPlan(plan, 'Pass summary', prefix);

  const actions = plan.declaredFixes.length + plan.resolutionFixes.length;
  if (dryRun) {
    console.log(`[dry-run] Planned ${actions} fixes for the first pass.`);
    process.exit(0);
  }
  if (actions === 0) {
    console.error(`${analysis.mismatches.length} mismatches cannot be fixed automatically.`);
    process.exit(1);
  }
  if (plan.declaredFixes.length > 0 && !install) {
    console.log('Declared ranges changed - run `yarn install` (or pass --install) to update the yarn.lock, then re-run this script.');
    process.exit(0);
  }
  if (install) {
    runYarn(analysis.projectRoot, ['install', '--no-immutable']);
  }
}

const finalAnalysis = await analyzeProject(input);
if (finalAnalysis.mismatches.length > 0) {
  console.error(`${finalAnalysis.mismatches.length} mismatches remain after ${maxPasses} fix passes.`);
  process.exit(1);
}
console.log('All versions match the manifest now.');
