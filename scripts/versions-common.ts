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

export interface Analysis {
  projectRoot: string;
  backstageVersion: string;
  manifest: Manifest;
  manifestVersions: Map<string, string>;
  packageJsonPaths: string[];
  checkedDeclarations: number;
  checkedLockEntries: number;
  mismatches: Mismatch[];
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
  {
    const lockfile = parseSyml(fs.readFileSync(path.join(projectRoot, 'yarn.lock'), 'utf8'));
    for (const [key, entry] of Object.entries(lockfile)) {
      const version = entry?.version;
      if (key === '__metadata' || typeof version !== 'string') {
        continue;
      }
      for (const selector of key.split(',').map((part) => part.trim())) {
        const atIndex = selector.indexOf('@', 1);
        if (atIndex === -1) {
          continue;
        }
        const name = selector.slice(0, atIndex);
        const range = selector.slice(atIndex + 1).replace(/^npm:/, '');
        resolvedBySelector.set(`${name}@${range}`, version);
        lockEntries.push({ name, range, version });
        if (!resolvedByName.has(name)) {
          resolvedByName.set(name, new Set());
        }
        resolvedByName.get(name)!.add(version);
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
  };
};
