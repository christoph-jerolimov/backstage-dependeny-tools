import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { analyzeProject } from './versions-common.ts';

// Fixes the version mismatches reported by verify-versions.ts:
//
// - Declared ranges in package.json files that don't match the manifest are
//   rewritten to the manifest version, keeping the range style (^, ~ or an
//   exact pin).
// - Lockfile entries that resolved to a different version than the manifest
//   are corrected with `yarn set resolution`, which lets yarn rewrite the
//   yarn.lock consistently instead of editing it by hand.
//
// After changing declared ranges a `yarn install` is required to update the
// lockfile — pass --install to run it automatically.
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

const analysis = await analyzeProject(input);
const { projectRoot, mismatches } = analysis;

if (mismatches.length === 0) {
  console.log('All versions match the manifest, nothing to fix.');
  process.exit(0);
}

const run = (command: string, commandArgs: string[]) => {
  console.log(`${dryRun ? '[dry-run] ' : ''}$ ${command} ${commandArgs.join(' ')}`);
  if (dryRun) {
    return;
  }
  const result = spawnSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' });
  if (result.status !== 0) {
    console.error(`${command} failed with exit code ${result.status}`);
    process.exit(1);
  }
};

// Rewrite declared ranges in the package.json files, keeping the range style.
const declaredFixes = mismatches.filter((mismatch) => mismatch.section && !mismatch.declaredMatches);
for (const mismatch of declaredFixes) {
  const newRange = /^[\^~]/.test(mismatch.declared)
    ? `${mismatch.declared[0]}${mismatch.manifest}`
    : semver.valid(mismatch.declared)
      ? mismatch.manifest
      : `^${mismatch.manifest}`;
  console.log(
    `${dryRun ? '[dry-run] ' : ''}${mismatch.packageJson}: ${mismatch.dependency} ` +
      `(${mismatch.section}) ${mismatch.declared} -> ${newRange}`,
  );
  if (!dryRun) {
    const packageJsonPath = path.join(projectRoot, mismatch.packageJson);
    const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
    packageJson[mismatch.section!][mismatch.dependency] = newRange;
    fs.writeFileSync(packageJsonPath, `${JSON.stringify(packageJson, null, 2)}\n`);
  }
}

// Correct mismatched lockfile resolutions. This is only valid when the
// selector range allows the manifest version - forcing e.g. ^0.15.1 to
// resolve to 0.17.2 would pretend an incompatible version is compatible.
// Entries whose range doesn't allow the manifest version have to be fixed
// in the declaring package.json: project-local declarations are rewritten
// above and re-resolved by the yarn install below; ranges declared by
// dependencies disappear once the packages that declare them are updated.
const resolutionFixes = new Map<string, string>();
for (const mismatch of mismatches) {
  if (mismatch.declaredMatches && mismatch.resolved && mismatch.resolved !== mismatch.manifest) {
    const range = mismatch.declared.replace(/^npm:/, '');
    resolutionFixes.set(`${mismatch.dependency}@npm:${range}`, mismatch.manifest);
  }
}
for (const [descriptor, version] of resolutionFixes) {
  run('yarn', ['set', 'resolution', descriptor, `npm:${version}`]);
}

const unfixable = mismatches.filter((mismatch) => mismatch.packageJson === 'yarn.lock' && !mismatch.declaredMatches);
for (const mismatch of unfixable) {
  console.warn(
    `Cannot fix yarn.lock entry ${mismatch.dependency}@${mismatch.declared}: the range does not ` +
      `allow the manifest version ${mismatch.manifest}. It resolves again after the declaring ` +
      `package.json files are fixed and yarn install ran, or requires updating the dependency ` +
      `that declares it.`,
  );
}

if (declaredFixes.length > 0) {
  if (install) {
    run('yarn', ['install', '--no-immutable']);
  } else {
    console.log('Declared ranges changed - run `yarn install` (or pass --install) to update the yarn.lock.');
  }
}

console.log(
  `${dryRun ? '[dry-run] ' : ''}Fixed ${declaredFixes.length} declared ranges ` +
    `and ${resolutionFixes.size} lockfile resolutions.`,
);
