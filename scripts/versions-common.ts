import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSyml } from '@yarnpkg/parsers';
import semver from 'semver';

// Shared analysis used by verify-versions.ts and fix-versions.ts: locates a
// Backstage project, loads the release manifest for its backstage.json
// version and collects all version mismatches in the package.json files and
// the yarn.lock.

export interface Manifest {
  releaseVersion: string;
  packages: { name: string; version: string }[];
}

export type Section = 'dependencies' | 'devDependencies';

export interface Mismatch {
  // Relative package.json path, or 'yarn.lock' for lockfile-only entries.
  packageJson: string;
  section?: Section;
  dependency: string;
  declared: string;
  manifest: string;
  resolved?: string;
  declaredMatches: boolean;
  status: string;
}

export interface LockPackage {
  name: string;
  version: string;
  // The (npm: stripped) selector ranges that resolve to this entry.
  ranges: string[];
  dependencies: Record<string, string>;
  external: boolean;
}

export interface Analysis {
  projectRoot: string;
  backstageVersion: string;
  manifest: Manifest;
  manifestVersions: Map<string, string>;
  packageJsonPaths: string[];
  checkedDeclarations: number;
  checkedLockEntries: number;
  mismatches: Mismatch[];
  lockPackages: LockPackage[];
}

export const findProjectRoot = (input: string): string => {
  let startDir = path.resolve(input);
  if (fs.statSync(startDir).isFile()) {
    startDir = path.dirname(startDir);
  }
  for (let dir = startDir; ; dir = path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, 'yarn.lock')) || fs.existsSync(path.join(dir, 'backstage.json'))) {
      return dir;
    }
    if (path.dirname(dir) === dir) {
      throw new Error(`No yarn.lock or backstage.json found in ${startDir} or any parent folder`);
    }
  }
};

export const loadManifest = async (version: string): Promise<Manifest> => {
  const localManifest = path.join(import.meta.dirname, '..', 'manifests', `${version}.json`);
  if (fs.existsSync(localManifest)) {
    return JSON.parse(fs.readFileSync(localManifest, 'utf8'));
  }
  const url = `https://raw.githubusercontent.com/backstage/versions/main/v1/releases/${version}/manifest.json`;
  console.log(`No local manifest for ${version}, fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch manifest for ${version}: ${response.status} ${response.statusText}`);
  }
  return (await response.json()) as Manifest;
};

const resolvedStatus = (resolved: string, manifestVersion: string) => {
  if (semver.valid(resolved) && semver.valid(manifestVersion)) {
    return semver.gt(resolved, manifestVersion)
      ? 'resolved newer than manifest'
      : 'resolved older than manifest';
  }
  return 'resolved mismatch';
};

export const analyzeProject = async (input: string): Promise<Analysis> => {
  const projectRoot = findProjectRoot(input);
  console.log(`Project root: ${projectRoot}`);

  const backstageJsonPath = path.join(projectRoot, 'backstage.json');
  if (!fs.existsSync(backstageJsonPath)) {
    throw new Error(`No backstage.json found in ${projectRoot}`);
  }
  const backstageVersion: string = JSON.parse(fs.readFileSync(backstageJsonPath, 'utf8')).version;
  console.log(`Backstage version: ${backstageVersion}`);

  const manifest = await loadManifest(backstageVersion);
  const manifestVersions = new Map(manifest.packages.map((pkg) => [pkg.name, pkg.version]));
  console.log(`Manifest ${manifest.releaseVersion} contains ${manifestVersions.size} packages`);

  // Parses the (yarn berry) lockfile into a map of "name@range" selectors to
  // resolved versions, plus a map of all resolved versions per package name.
  const resolvedBySelector = new Map<string, string>();
  const resolvedByName = new Map<string, Set<string>>();
  const lockEntries: { name: string; range: string; version: string }[] = [];
  const lockPackages: LockPackage[] = [];
  {
    const lockfile = parseSyml(fs.readFileSync(path.join(projectRoot, 'yarn.lock'), 'utf8'));
    for (const [key, entry] of Object.entries(lockfile)) {
      const version = entry?.version;
      if (key === '__metadata' || typeof version !== 'string') {
        continue;
      }
      const lockPackage: LockPackage = {
        name: '',
        version,
        ranges: [],
        dependencies: entry.dependencies ?? {},
        external: typeof entry.resolution === 'string' && entry.resolution.includes('@npm:'),
      };
      for (const selector of key.split(',').map((part) => part.trim())) {
        const atIndex = selector.indexOf('@', 1);
        if (atIndex === -1) {
          continue;
        }
        const name = selector.slice(0, atIndex);
        const range = selector.slice(atIndex + 1).replace(/^npm:/, '');
        lockPackage.name = name;
        lockPackage.ranges.push(range);
        resolvedBySelector.set(`${name}@${range}`, version);
        lockEntries.push({ name, range, version });
        if (!resolvedByName.has(name)) {
          resolvedByName.set(name, new Set());
        }
        resolvedByName.get(name)!.add(version);
      }
      if (lockPackage.name) {
        lockPackages.push(lockPackage);
      }
    }
  }

  const packageJsonPaths = ['package.json'];
  for (const folder of ['packages', 'plugins']) {
    const folderPath = path.join(projectRoot, folder);
    if (!fs.existsSync(folderPath)) {
      continue;
    }
    for (const entry of fs.readdirSync(folderPath, { withFileTypes: true })) {
      if (entry.isDirectory() && fs.existsSync(path.join(folderPath, entry.name, 'package.json'))) {
        packageJsonPaths.push(path.join(folder, entry.name, 'package.json'));
      }
    }
  }

  const mismatches: Mismatch[] = [];
  let checkedDeclarations = 0;

  for (const packageJsonPath of packageJsonPaths) {
    const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, packageJsonPath), 'utf8'));
    for (const section of ['dependencies', 'devDependencies'] as Section[]) {
      for (const [dependency, declared] of Object.entries<string>(packageJson[section] ?? {})) {
        const manifestVersion = manifestVersions.get(dependency);
        if (!manifestVersion) {
          continue;
        }
        // Non-npm protocols like workspace:^ or link: cannot be compared.
        // backstage:^ is resolved to the manifest version by the Backstage
        // yarn plugin, so it always matches.
        if (/^(workspace|link|portal|file|patch):/.test(declared)) {
          continue;
        }
        checkedDeclarations++;

        const range = declared.replace(/^npm:/, '');
        const declaredMatches =
          declared.startsWith('backstage:') ||
          semver.satisfies(manifestVersion, range, { includePrerelease: true });

        const resolved =
          resolvedBySelector.get(`${dependency}@${declared}`) ??
          resolvedBySelector.get(`${dependency}@${range}`);
        const resolvedMatches = resolved === manifestVersion;

        if (!declaredMatches || !resolvedMatches) {
          const status = [
            ...(declaredMatches ? [] : ['declared mismatch']),
            ...(resolvedMatches ? [] : [resolved ? resolvedStatus(resolved, manifestVersion) : 'not in yarn.lock']),
          ].join(', ');
          mismatches.push({
            packageJson: packageJsonPath,
            section,
            dependency,
            declared,
            manifest: manifestVersion,
            resolved: resolved ?? ([...(resolvedByName.get(dependency) ?? [])].join(', ') || undefined),
            declaredMatches,
            status,
          });
        }
      }
    }
  }

  // Additionally check every @backstage/ entry in the yarn.lock — including
  // transitive dependencies that appear in no package.json — for exactly the
  // version from the manifest.
  let checkedLockEntries = 0;
  for (const { name, range, version } of lockEntries) {
    if (!name.startsWith('@backstage/')) {
      continue;
    }
    const manifestVersion = manifestVersions.get(name);
    if (!manifestVersion) {
      continue;
    }
    checkedLockEntries++;
    if (version !== manifestVersion) {
      // When the selector range doesn't allow the manifest version (for
      // example ^0.15.1 vs 0.17.2 - caret ranges don't cross minor versions
      // on 0.x), the lockfile entry cannot be fixed with a resolution
      // override - the declaring package.json has to change instead.
      const declaredMatches = semver.satisfies(manifestVersion, range, { includePrerelease: true });
      mismatches.push({
        packageJson: 'yarn.lock',
        dependency: name,
        declared: range,
        manifest: manifestVersion,
        resolved: version,
        declaredMatches,
        status: declaredMatches
          ? resolvedStatus(version, manifestVersion)
          : `range incompatible with manifest, ${resolvedStatus(version, manifestVersion)}`,
      });
    }
  }

  console.log(
    `Checked ${checkedDeclarations} dependency declarations in ${packageJsonPaths.length} package.json files ` +
      `and ${checkedLockEntries} @backstage/ yarn.lock entries against manifest ${manifest.releaseVersion}`,
  );

  return {
    projectRoot,
    backstageVersion,
    manifest,
    manifestVersions,
    packageJsonPaths,
    checkedDeclarations,
    checkedLockEntries,
    mismatches,
    lockPackages,
  };
};

// ---------------------------------------------------------------------------
// Fix planning - shared by fix-versions.ts (to apply the fixes) and
// verify-versions.ts (to report whether a fix is expected to work).

export interface FixPlan {
  // package.json rewrites: dependency@to in the given file and section.
  declaredFixes: { packageJson: string; section: Section; dependency: string; from: string; to: string }[];
  // `yarn set resolution <descriptor> npm:<version>` calls.
  resolutionFixes: { descriptor: string; version: string }[];
  // Blocking package name -> the @backstage/* dependencies it holds back.
  blockedOnUpstream: Map<string, { mismatches: Set<string> }>;
  // Blocking descriptor -> the version an update of its declarer would unlock.
  blockedOnTransitive: Map<string, { mismatches: Set<string>; best: string }>;
}

export const styledRange = (oldRange: string, version: string) =>
  /^[\^~]/.test(oldRange) ? `${oldRange[0]}${version}` : semver.valid(oldRange) ? version : `^${version}`;

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

export const planFixes = async (analysis: Analysis): Promise<FixPlan> => {
  const { projectRoot, mismatches, lockPackages } = analysis;
  const plan: FixPlan = {
    declaredFixes: [],
    resolutionFixes: [],
    blockedOnUpstream: new Map(),
    blockedOnTransitive: new Map(),
  };

  // Declared ranges that don't match the manifest are rewritten in the
  // package.json files, keeping the range style.
  for (const mismatch of mismatches) {
    if (mismatch.section && !mismatch.declaredMatches) {
      plan.declaredFixes.push({
        packageJson: mismatch.packageJson,
        section: mismatch.section,
        dependency: mismatch.dependency,
        from: mismatch.declared,
        to: styledRange(mismatch.declared, mismatch.manifest),
      });
    }
  }

  // Mismatched lockfile resolutions whose range allows the manifest version
  // are corrected with a resolution override. Entries whose declared range
  // was wrong are skipped - their new range is resolved by a yarn install.
  const seenResolutions = new Set<string>();
  for (const mismatch of mismatches) {
    if (mismatch.declaredMatches && mismatch.resolved && mismatch.resolved !== mismatch.manifest) {
      const descriptor = `${mismatch.dependency}@npm:${mismatch.declared.replace(/^npm:/, '')}`;
      if (!seenResolutions.has(descriptor)) {
        seenResolutions.add(descriptor);
        plan.resolutionFixes.push({ descriptor, version: mismatch.manifest });
      }
    }
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
      // The dependent has no published version that works with the manifest
      // - it has to release one before these mismatches can be fixed.
      plan.blockedOnUpstream.set(dependent.name, { mismatches: new Set(offenses.keys()) });
      continue;
    }

    for (const range of dependent.ranges) {
      const inRange = compatible.filter((version) => semver.satisfies(version, range, { includePrerelease: true }));
      if (inRange.length > 0) {
        plan.resolutionFixes.push({ descriptor: `${dependent.name}@npm:${range}`, version: inRange.at(-1)! });
      } else {
        // No compatible version within the selector range - the declaring
        // package.json files have to move to a newer range.
        const best = compatible.at(-1)!;
        let declared = false;
        for (const packageJsonPath of analysis.packageJsonPaths) {
          const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, packageJsonPath), 'utf8'));
          for (const section of ['dependencies', 'devDependencies'] as Section[]) {
            if (packageJson[section]?.[dependent.name]?.replace(/^npm:/, '') === range) {
              plan.declaredFixes.push({
                packageJson: packageJsonPath,
                section,
                dependency: dependent.name,
                from: range,
                to: styledRange(range, best),
              });
              declared = true;
            }
          }
        }
        if (!declared) {
          // The range is declared by another dependency, so only an update
          // of that dependency can move it.
          const key = `${dependent.name}@${range}`;
          if (!plan.blockedOnTransitive.has(key)) {
            plan.blockedOnTransitive.set(key, { mismatches: new Set(offenses.keys()), best });
          }
        }
      }
    }
  }

  return plan;
};

export const printFixPlan = (plan: FixPlan, label: string, prefix = '') => {
  const count = (n: number) => `${n} ${n === 1 ? 'mismatch' : 'mismatches'}`;
  const fixable = plan.declaredFixes.length + plan.resolutionFixes.length;
  const blockedUpstream = [...plan.blockedOnUpstream.values()].reduce((sum, blocked) => sum + blocked.mismatches.size, 0);
  const blockedTransitive = [...plan.blockedOnTransitive.values()].reduce((sum, blocked) => sum + blocked.mismatches.size, 0);
  console.log(
    `${prefix}${label}: ${fixable} fixable, ` +
      `${blockedUpstream} blocked on upstream releases, ` +
      `${blockedTransitive} blocked on transitive dependencies`,
  );
  for (const [dependent, blocked] of plan.blockedOnUpstream) {
    console.warn(
      `${prefix}- ${count(blocked.mismatches.size)} blocked because ${dependent} has not published a ` +
        `version compatible with the manifest (${[...blocked.mismatches].join(', ')})`,
    );
  }
  for (const [descriptor, blocked] of plan.blockedOnTransitive) {
    console.warn(
      `${prefix}- ${count(blocked.mismatches.size)} blocked because ${descriptor} is declared by ` +
        `another dependency and only its update can move it to ${blocked.best}`,
    );
  }
};
