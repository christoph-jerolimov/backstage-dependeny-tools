import * as fs from 'node:fs';
import * as path from 'node:path';
import { parseSyml } from '@yarnpkg/parsers';
import semver from 'semver';

// Verifies that a Backstage project uses the package versions of its
// configured Backstage release.
//
// Given a project path (or package.json), it walks the folder structure
// upwards until it finds a yarn.lock or backstage.json, reads the
// Backstage version from backstage.json and loads the release manifest
// for it (from the local manifests/ folder, falling back to
// backstage/versions on GitHub).
//
// It then compares the declared version ranges of the root package.json
// and all package.json files in packages/* and plugins/* — as well as
// the resolved versions in yarn.lock — against the manifest versions,
// prints a table of mismatches and exits with code 1 if anything
// doesn't match.
//
// Usage: tsx scripts/verify-versions.ts <project-path-or-package.json>

interface Manifest {
  releaseVersion: string;
  packages: { name: string; version: string }[];
}

interface Row {
  packageJson: string;
  dependency: string;
  declared: string;
  manifest: string;
  resolved: string;
  status: string;
}

const input = process.argv[2];
if (!input) {
  console.error('Usage: tsx scripts/verify-versions.ts <project-path-or-package.json>');
  process.exit(1);
}

let startDir = path.resolve(input);
if (fs.statSync(startDir).isFile()) {
  startDir = path.dirname(startDir);
}

let projectRoot: string | undefined;
for (let dir = startDir; ; dir = path.dirname(dir)) {
  if (fs.existsSync(path.join(dir, 'yarn.lock')) || fs.existsSync(path.join(dir, 'backstage.json'))) {
    projectRoot = dir;
    break;
  }
  if (path.dirname(dir) === dir) {
    break;
  }
}
if (!projectRoot) {
  console.error(`No yarn.lock or backstage.json found in ${startDir} or any parent folder`);
  process.exit(1);
}
console.log(`Project root: ${projectRoot}`);

const backstageJsonPath = path.join(projectRoot, 'backstage.json');
if (!fs.existsSync(backstageJsonPath)) {
  console.error(`No backstage.json found in ${projectRoot}`);
  process.exit(1);
}
const backstageVersion: string = JSON.parse(fs.readFileSync(backstageJsonPath, 'utf8')).version;
console.log(`Backstage version: ${backstageVersion}`);

const loadManifest = async (version: string): Promise<Manifest> => {
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

const rows: Row[] = [];
let checked = 0;

const resolvedStatus = (resolved: string, manifestVersion: string) => {
  if (semver.valid(resolved) && semver.valid(manifestVersion)) {
    return semver.gt(resolved, manifestVersion)
      ? 'resolved newer than manifest'
      : 'resolved older than manifest';
  }
  return 'resolved mismatch';
};

for (const packageJsonPath of packageJsonPaths) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, packageJsonPath), 'utf8'));
  const dependencies: [string, string][] = [
    ...Object.entries<string>(packageJson.dependencies ?? {}),
    ...Object.entries<string>(packageJson.devDependencies ?? {}),
  ];
  for (const [dependency, declared] of dependencies) {
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
    checked++;

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
      rows.push({
        packageJson: packageJsonPath,
        dependency,
        declared,
        manifest: manifestVersion,
        resolved: resolved ?? ([...(resolvedByName.get(dependency) ?? [])].join(', ') || '-'),
        status,
      });
    }
  }
}

// Additionally check every @backstage/ entry in the yarn.lock — including
// transitive dependencies that appear in no package.json — for exactly the
// version from the manifest.
let lockChecked = 0;
for (const { name, range, version } of lockEntries) {
  if (!name.startsWith('@backstage/')) {
    continue;
  }
  const manifestVersion = manifestVersions.get(name);
  if (!manifestVersion) {
    continue;
  }
  lockChecked++;
  if (version !== manifestVersion) {
    rows.push({
      packageJson: 'yarn.lock',
      dependency: name,
      declared: range,
      manifest: manifestVersion,
      resolved: version,
      status: resolvedStatus(version, manifestVersion),
    });
  }
}

console.log(
  `Checked ${checked} dependency declarations in ${packageJsonPaths.length} package.json files ` +
    `and ${lockChecked} @backstage/ yarn.lock entries against manifest ${manifest.releaseVersion}`,
);

if (rows.length === 0) {
  console.log('All versions match the manifest.');
  process.exit(0);
}

const printTable = (tableRows: Row[]) => {
  const columns: { key: keyof Row; title: string }[] = [
    { key: 'packageJson', title: 'package.json' },
    { key: 'dependency', title: 'Dependency' },
    { key: 'declared', title: 'Declared' },
    { key: 'manifest', title: 'Manifest' },
    { key: 'resolved', title: 'Resolved (yarn.lock)' },
    { key: 'status', title: 'Status' },
  ];
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...tableRows.map((row) => row[column.key].length)),
  );
  const line = (values: string[]) =>
    `| ${values.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;
  console.log(line(columns.map((column) => column.title)));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const row of tableRows) {
    console.log(line(columns.map((column) => row[column.key])));
  }
};

console.log();
printTable(rows);
console.log();
console.error(`${rows.length} version mismatches found.`);
process.exit(1);
