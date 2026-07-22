# backstage-dependeny-tools

Tools to keep Backstage plugin workspaces aligned with the package versions
of their configured [Backstage release](https://github.com/backstage/versions).

The `manifests/` folder contains a copy of the release manifest for every
Backstage release since 1.45.0 as `manifests/<version>.json`, plus a
`manifests/next.json` when the latest `-next` prerelease is newer than the
highest stable release.

## Setup

The project uses yarn 4, bootstrapped from the committed
`.yarn/releases/yarn-4.9.2.cjs`:

```sh
git clone https://github.com/christoph-jerolimov/backstage-dependeny-tools.git
cd backstage-dependeny-tools
yarn install
```

## Scripts

### `yarn verify-versions <project-path-or-package.json>`

Verifies that a Backstage project uses the package versions of its
configured Backstage release:

- Takes a project path or `package.json` and walks the folder structure
  upwards to the next `yarn.lock` / `backstage.json`.
- Reads the Backstage version from `backstage.json` and loads the manifest
  for it — from the local `manifests/` folder, falling back to fetching it
  from backstage/versions on GitHub.
- Compares the declared version ranges of the root `package.json` and all
  `package.json` files in `packages/*` and `plugins/*` against the manifest
  versions, and checks that the resolved versions in the `yarn.lock` match
  the manifest exactly. Every `@backstage/`-scoped entry in the `yarn.lock`
  is checked as well, including transitive dependencies that appear in no
  `package.json`.
- Prints mismatches as a table and exits with code 1 if anything doesn't
  match.

### `yarn fix-versions <project-path-or-package.json> [--dry-run] [--install]`

Repairs the mismatches that `verify-versions` reports:

- Declared ranges that don't match the manifest are rewritten in the
  `package.json` files to the manifest version, keeping the range style
  (`^`, `~` or an exact pin).
- Mismatched `yarn.lock` resolutions are corrected with
  `yarn set resolution`, so yarn rewrites the lockfile consistently.
- `--dry-run` prints the planned changes without touching anything.
- `--install` runs `yarn install` automatically after declared ranges
  changed (otherwise a reminder is printed, since changed ranges need an
  install to update the lockfile).

## Workflows

### [update-manifests](.github/workflows/update-manifests.yml)

Runs every morning at 03:17 UTC (05:17 CEST / 04:17 CET / 08:47 IST) and
manually via workflow dispatch. It clones backstage/versions, runs
`copy-manifests` and commits any changes in `manifests/` directly to `main`.

### [verify-workspaces](.github/workflows/verify-workspaces.yml)

Runs on every pull request, every morning at 04:17 UTC (one hour after
update-manifests) and manually via workflow dispatch. A non-fail-fast matrix
clones plugin workspaces from
[backstage/community-plugins](https://github.com/backstage/community-plugins)
and
[redhat-developer/rhdh-plugins](https://github.com/redhat-developer/rhdh-plugins)
and runs `verify-versions` against each of them. A summary job prints the
number of successful and failed checks afterwards.
