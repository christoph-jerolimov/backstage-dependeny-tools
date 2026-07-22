import { analyzeProject, planFixes, printFixPlan, type Mismatch } from './versions-common.ts';

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

const input = process.argv[2];
if (!input) {
  console.error('Usage: tsx scripts/verify-versions.ts <project-path-or-package.json>');
  process.exit(1);
}

const analysis = await analyzeProject(input);

if (analysis.mismatches.length === 0) {
  console.log('All versions match the manifest.');
  process.exit(0);
}

const printTable = (mismatches: Mismatch[]) => {
  const columns: { key: keyof Mismatch; title: string }[] = [
    { key: 'packageJson', title: 'package.json' },
    { key: 'dependency', title: 'Dependency' },
    { key: 'declared', title: 'Declared' },
    { key: 'manifest', title: 'Manifest' },
    { key: 'resolved', title: 'Resolved (yarn.lock)' },
    { key: 'status', title: 'Status' },
  ];
  const cell = (mismatch: Mismatch, key: keyof Mismatch) => String(mismatch[key] ?? '-');
  const widths = columns.map((column) =>
    Math.max(column.title.length, ...mismatches.map((mismatch) => cell(mismatch, column.key).length)),
  );
  const line = (values: string[]) =>
    `| ${values.map((value, index) => value.padEnd(widths[index])).join(' | ')} |`;
  console.log(line(columns.map((column) => column.title)));
  console.log(line(widths.map((width) => '-'.repeat(width))));
  for (const mismatch of mismatches) {
    console.log(line(columns.map((column) => cell(mismatch, column.key))));
  }
};

console.log();
printTable(analysis.mismatches);
console.log();
const plan = await planFixes(analysis);
printFixPlan(plan, 'Fix expectation');
console.log();
console.error(`${analysis.mismatches.length} version mismatches found.`);
process.exit(1);
