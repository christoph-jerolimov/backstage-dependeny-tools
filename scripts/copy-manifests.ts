import * as fs from 'node:fs';
import * as path from 'node:path';
import semver from 'semver';

// Copies the manifest.json of every Backstage release (>= MINIMUM_VERSION)
// from a local clone of https://github.com/backstage/versions into the
// manifests/ folder as manifests/<version>.json.
//
// When the latest "-next" prerelease is newer than the highest stable
// release, its manifest is also written to manifests/next.json.
// Otherwise an existing manifests/next.json is removed.
//
// Usage: tsx scripts/copy-manifests.ts [path-to-versions-clone]

const MINIMUM_VERSION = '1.45.0';

const versionsRepo = process.argv[2] ?? '.clones/versions';
const releasesDir = path.join(versionsRepo, 'v1', 'releases');
const manifestsDir = 'manifests';

if (!fs.existsSync(releasesDir)) {
  console.error(`Releases directory not found: ${releasesDir}`);
  console.error('Pass the path to a clone of backstage/versions as the first argument.');
  process.exit(1);
}

const allVersions = fs
  .readdirSync(releasesDir, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => entry.name)
  .filter((name) => semver.valid(name) !== null);

// semver treats prereleases as older than the release itself
// (1.45.0-next.0 < 1.45.0), so this also drops next releases of 1.45.0.
const versions = allVersions.filter((version) => semver.gte(version, MINIMUM_VERSION));

const stableVersions = versions
  .filter((version) => semver.prerelease(version) === null)
  .sort(semver.compare);
const nextVersions = versions
  .filter((version) => semver.prerelease(version) !== null)
  .sort(semver.compare);

fs.mkdirSync(manifestsDir, { recursive: true });

const copyManifest = (version: string, targetName: string) => {
  const source = path.join(releasesDir, version, 'manifest.json');
  const target = path.join(manifestsDir, targetName);
  fs.copyFileSync(source, target);
  console.log(`Copied ${source} to ${target}`);
};

for (const version of stableVersions) {
  copyManifest(version, `${version}.json`);
}

const latestStable = stableVersions.at(-1);
const latestNext = nextVersions.at(-1);
const nextJson = path.join(manifestsDir, 'next.json');

if (latestNext && (!latestStable || semver.gt(latestNext, latestStable))) {
  console.log(`Latest next release ${latestNext} is newer than latest stable release ${latestStable ?? 'none'}`);
  copyManifest(latestNext, 'next.json');
} else if (fs.existsSync(nextJson)) {
  console.log(`No next release newer than ${latestStable}, removing ${nextJson}`);
  fs.rmSync(nextJson);
} else {
  console.log(`No next release newer than ${latestStable}`);
}

console.log(`Done: ${stableVersions.length} stable manifests`);
