import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';
import { analyzeProject, type Analysis, type LockPackage } from './versions-common.ts';

// Fixes the version mismatches reported by verify-versions.ts:
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

const packumentCache = new Map<string, Record<string, { dependencies?: Record<string, string> }>>();
const fetchVersions = async (name: string) => {
  if (!packumentCache.has(name)) {
    const url = `https://registry.npmjs.org/${name.replace('/', '%2f')}`;
    const response = await fetch(url, { headers: { accept: 'application/vnd.npm.install-v1+json' } });
    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }
    packumentCache.set(name, ((await response.json()) as { versions: {} }).versions);
  }
  return packumentCache.get(name)!;
};

const applyFixes = async (analysis: Analysis): Promise<{ actions: number; declaredChanges: number }> => {
  const { projectRoot, mismatches, lockPackages } = analysis;
  let actions = 0;
  let declaredChanges = 0;

  const run = (command: string, commandArgs: string[]) => {
    console.log(`${prefix}$ ${command} ${commandArgs.join(' ')}`);
    actions++;
    if (dryRun) {
      return;
    }
    const result = spawnSync(command, commandArgs, { cwd: projectRoot, stdio: 'inherit' });
    if (result.status !== 0) {
      console.error(`${command} failed with exit code ${result.status}`);
      process.exit(1);
    }
  };

  const updateDeclaration = (packageJsonPath: string, section: string, dependency: string, newRange: string) => {
    console.log(`${prefix}${packageJsonPath}: ${dependency} (${section}) -> ${newRange}`);
    actions++;
    declaredChanges++;
    if (dryRun) {
      return;
    }
    const filePath = path.join(projectRoot, packageJsonPath);
    const packageJson = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    packageJson[section][dependency] = newRange;
    fs.writeFileSync(filePath, `${JSON.stringify(packageJson, null, 2)}\n`);
  };

  const styledRange = (oldRange: string, version: string) =>
    /^[\^~]/.test(oldRange) ? `${oldRange[0]}${version}` : semver.valid(oldRange) ? version : `^${version}`;

  // Rewrite declared ranges in the package.json files, keeping the range style.
  const declaredFixes = mismatches.filter((mismatch) => mismatch.section && !mismatch.declaredMatches);
  for (const mismatch of declaredFixes) {
    updateDeclaration(
      mismatch.packageJson,
      mismatch.section!,
      mismatch.dependency,
      styledRange(mismatch.declared, mismatch.manifest),
    );
  }

  // Correct mismatched lockfile resolutions whose range allows the manifest
  // version. Entries whose declared range was wrong are skipped - their new
  // range is resolved by the yarn install below.
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

  // Lockfile entries whose range cannot reach the manifest version are
  // declared by dependencies that were built against an older Backstage
  // release - bump those dependencies to their newest version whose
  // @backstage/* ranges allow the manifest versions.
  const unfixable = mismatches.filter((mismatch) => mismatch.packageJson === 'yarn.lock' && !mismatch.declaredMatches);
  const dependentOffenses = new Map<LockPackage, Map<string, string>>();
  for (const mismatch of unfixable) {
    for (const lockPackage of lockPackages) {
      const declaredRange = lockPackage.dependencies[mismatch.dependency]?.replace(/^npm:/, '');
      if (declaredRange !== mismatch.declared) {
        continue;
      }
      // Workspace packages declare their dependencies in the project's own
      // package.json files - those are already handled above and re-synced
      // by the next yarn install.
      if (!lockPackage.external) {
        continue;
      }
      if (!dependentOffenses.has(lockPackage)) {
        dependentOffenses.set(lockPackage, new Map());
      }
      dependentOffenses.get(lockPackage)!.set(mismatch.dependency, mismatch.manifest);
    }
  }

  for (const [dependent, offenses] of dependentOffenses) {
    const available = await fetchVersions(dependent.name);
    const compatible = Object.keys(available)
      .filter((version) =>
        [...offenses].every(([dependency, manifestVersion]) => {
          const range = available[version].dependencies?.[dependency];
          return range && semver.validRange(range) && semver.satisfies(manifestVersion, range, { includePrerelease: true });
        }),
      )
      .sort(semver.compare);
    if (compatible.length === 0) {
      console.warn(
        `${prefix}Cannot fix ${dependent.name}@${dependent.version}: no published version is ` +
          `compatible with ${[...offenses.keys()].join(', ')} from the manifest.`,
      );
      continue;
    }

    for (const range of dependent.ranges) {
      const inRange = compatible.filter((version) => semver.satisfies(version, range, { includePrerelease: true }));
      if (inRange.length > 0) {
        run('yarn', ['set', 'resolution', `${dependent.name}@npm:${range}`, `npm:${inRange.at(-1)}`]);
      } else {
        // No compatible version within the selector range - the declaring
        // package.json files have to move to a newer range.
        const best = compatible.at(-1)!;
        let declared = false;
        for (const packageJsonPath of analysis.packageJsonPaths) {
          const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, packageJsonPath), 'utf8'));
          for (const section of ['dependencies', 'devDependencies']) {
            if (packageJson[section]?.[dependent.name]?.replace(/^npm:/, '') === range) {
              updateDeclaration(packageJsonPath, section, dependent.name, styledRange(range, best));
              declared = true;
            }
          }
        }
        if (!declared) {
          console.warn(
            `${prefix}Cannot fix ${dependent.name}@${range}: the compatible version ${best} is outside ` +
              `the range, which is declared by another dependency - that dependency needs an update.`,
          );
        }
      }
    }
  }

  return { actions, declaredChanges };
};

const maxPasses = 5;
for (let pass = 1; pass <= maxPasses; pass++) {
  const analysis = await analyzeProject(input);
  if (analysis.mismatches.length === 0) {
    console.log(pass === 1 ? 'All versions match the manifest, nothing to fix.' : 'All versions match the manifest now.');
    process.exit(0);
  }

  console.log(`${prefix}Fix pass ${pass}: ${analysis.mismatches.length} mismatches`);
  const { actions, declaredChanges } = await applyFixes(analysis);

  if (dryRun) {
    console.log(`[dry-run] Planned ${actions} fixes for the first pass.`);
    process.exit(0);
  }
  if (actions === 0) {
    console.error(`${analysis.mismatches.length} mismatches cannot be fixed automatically.`);
    process.exit(1);
  }
  if (declaredChanges > 0 && !install) {
    console.log('Declared ranges changed - run `yarn install` (or pass --install) to update the yarn.lock, then re-run this script.');
    process.exit(0);
  }
  if (install) {
    console.log(`$ yarn install --no-immutable`);
    const result = spawnSync('yarn', ['install', '--no-immutable'], {
      cwd: analysis.projectRoot,
      stdio: 'inherit',
    });
    if (result.status !== 0) {
      console.error(`yarn install failed with exit code ${result.status}`);
      process.exit(1);
    }
  }
}

const finalAnalysis = await analyzeProject(input);
if (finalAnalysis.mismatches.length > 0) {
  console.error(`${finalAnalysis.mismatches.length} mismatches remain after ${maxPasses} fix passes.`);
  process.exit(1);
}
console.log('All versions match the manifest now.');
