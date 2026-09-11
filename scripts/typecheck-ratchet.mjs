import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const ROOT = process.cwd();
const CONFIG_PATH = path.join(ROOT, 'tsconfig.app.json');
const BASELINE_PATH = path.join(ROOT, 'scripts', 'typecheck-baseline.json');
export const BLOCKED_DIAGNOSTIC_CODES = new Set([2300, 2304, 2552]);

export function diagnosticKey(diagnostic, root = ROOT) {
  const file = diagnostic.file
    ? path.relative(root, diagnostic.file.fileName).split(path.sep).join('/')
    : '<global>';
  const normalizedRoot = root.split(path.sep).join('/');
  const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')
    .split(root).join('<root>')
    .split(normalizedRoot).join('<root>');
  return `${file}|TS${diagnostic.code}|${message}`;
}

export function countDiagnostics(diagnostics, root = ROOT) {
  const counts = {};
  for (const diagnostic of diagnostics) {
    const key = diagnosticKey(diagnostic, root);
    counts[key] = (counts[key] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([left], [right]) => left.localeCompare(right)));
}

export function compareDiagnosticCounts(current, baseline) {
  const added = [];
  const removed = [];
  const keys = new Set([...Object.keys(current), ...Object.keys(baseline)]);
  for (const key of [...keys].sort()) {
    const delta = (current[key] ?? 0) - (baseline[key] ?? 0);
    if (delta > 0) added.push({ key, count: delta });
    if (delta < 0) removed.push({ key, count: -delta });
  }
  return { added, removed };
}

export function groupDiagnosticCountsByFamily(counts) {
  const grouped = {};
  for (const [key, count] of Object.entries(counts)) {
    const [file, code] = key.split('|', 3);
    const family = `${file}|${code}`;
    grouped[family] = (grouped[family] ?? 0) + count;
  }
  return Object.fromEntries(Object.entries(grouped).sort(([left], [right]) => left.localeCompare(right)));
}

function loadDiagnostics() {
  const configFile = ts.readConfigFile(CONFIG_PATH, ts.sys.readFile);
  if (configFile.error) return [configFile.error];

  const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, ROOT, undefined, CONFIG_PATH);
  if (parsed.errors.length > 0) return parsed.errors;

  const program = ts.createProgram(parsed.fileNames, parsed.options);
  return ts.getPreEmitDiagnostics(program);
}

function total(counts) {
  return Object.values(counts).reduce((sum, count) => sum + count, 0);
}

function formatEntry({ key, count }) {
  return `  ${count}x ${key}`;
}

function parseBaseline(text, label) {
  let counts;
  try {
    counts = JSON.parse(text);
  } catch {
    throw new Error(`${label}: invalid JSON.`);
  }
  if (counts === null || typeof counts !== 'object' || Array.isArray(counts)) {
    throw new Error(`${label}: expected a diagnostic-count object.`);
  }
  let sum = 0;
  for (const [key, count] of Object.entries(counts)) {
    // Only the first two separators define the key; messages may contain |/LF.
    if (!/^[^|]+\|TS[1-9]\d*\|[\s\S]+$/.test(key)) {
      throw new Error(`${label}: invalid diagnostic key ${JSON.stringify(key)}.`);
    }
    if (!Number.isSafeInteger(count) || count <= 0) {
      throw new Error(`${label}: diagnostic counts must be positive safe integers.`);
    }
    sum += count;
    if (!Number.isSafeInteger(sum)) throw new Error(`${label}: diagnostic total exceeds the safe integer range.`);
  }
  return counts;
}

function main() {
  const update = process.argv.includes('--update');
  const baselineRefIndex = process.argv.indexOf('--verify-baseline-against');
  if (baselineRefIndex >= 0) {
    const baselineRef = process.argv[baselineRefIndex + 1];
    if (!baselineRef) {
      console.error('--verify-baseline-against requires a git ref.');
      process.exitCode = 1;
      return;
    }
    verifyBaselineAgainstGitRef(baselineRef, process.argv.includes('--allow-initial-baseline'));
    return;
  }
  if (process.argv.includes('--allow-initial-baseline')) {
    throw new Error('--allow-initial-baseline requires --verify-baseline-against <ref>.');
  }
  const diagnostics = loadDiagnostics();
  const current = countDiagnostics(diagnostics);
  const blocked = diagnostics.filter((diagnostic) => BLOCKED_DIAGNOSTIC_CODES.has(diagnostic.code));

  if (blocked.length > 0) {
    console.error('TypeScript ratchet blocked critical diagnostics:');
    for (const [key, count] of Object.entries(countDiagnostics(blocked))) {
      console.error(formatEntry({ key, count }));
    }
    process.exitCode = 1;
    return;
  }

  if (update) {
    fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(current, null, 2)}\n`);
    console.log(`TypeScript baseline updated: ${total(current)} diagnostics.`);
    return;
  }

  if (!fs.existsSync(BASELINE_PATH)) {
    console.error('TypeScript baseline is missing. Run npm run typecheck:baseline after fixing critical diagnostics.');
    process.exitCode = 1;
    return;
  }

  const baseline = parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'), 'TypeScript baseline');
  const { added, removed } = compareDiagnosticCounts(current, baseline);
  console.log(`TypeScript ratchet: current ${total(current)}, baseline ${total(baseline)}, removed ${removed.reduce((sum, item) => sum + item.count, 0)}.`);

  if (added.length > 0) {
    console.error('New TypeScript diagnostics:');
    added.forEach((entry) => console.error(formatEntry(entry)));
    process.exitCode = 1;
  }
}

function readGit(args, label) {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (error) {
    throw new Error(`${label}: ${error.stderr?.trim() || error.message}`);
  }
}

function verifyBaselineAgainstGitRef(gitRef, allowInitial) {
  const candidateBaseline = parseBaseline(fs.readFileSync(BASELINE_PATH, 'utf8'), 'Candidate baseline');
  const commit = readGit(['rev-parse', '--verify', '--end-of-options', `${gitRef}^{commit}`], 'Cannot resolve baseline ref').trim();
  const entries = readGit(['ls-tree', '-z', commit, '--', 'scripts/typecheck-baseline.json'], 'Cannot inspect baseline tree')
    .split('\0').filter(Boolean);
  if (entries.length === 0) {
    if (!allowInitial) throw new Error(`Baseline is absent at ${gitRef}. Initial creation requires explicit --allow-initial-baseline.`);
    console.log(`TypeScript baseline policy: verified absence at ${commit}; allowing explicitly requested initial baseline.`);
    return;
  }
  if (entries.length !== 1 || !/^(100644|100755) blob [0-9a-f]+\tscripts\/typecheck-baseline\.json$/.test(entries[0])) {
    throw new Error(`Baseline at ${gitRef} is not a regular file blob.`);
  }
  const targetBaseline = parseBaseline(
    readGit(['show', `${commit}:scripts/typecheck-baseline.json`], 'Cannot read target baseline'),
    'Target baseline',
  );
  // Dependency/type declaration changes can reorder or reword TypeScript's
  // message while preserving the same diagnostic debt. Promotion policy uses
  // stable file+code families; the branch-local ratchet above remains exact.
  const { added, removed } = compareDiagnosticCounts(
    groupDiagnosticCountsByFamily(candidateBaseline),
    groupDiagnosticCountsByFamily(targetBaseline),
  );
  console.log(`TypeScript baseline policy: candidate ${total(candidateBaseline)}, target ${total(targetBaseline)}, removed ${removed.reduce((sum, item) => sum + item.count, 0)}.`);
  if (added.length > 0) {
    console.error('The committed TypeScript baseline may only shrink:');
    added.forEach((entry) => console.error(formatEntry(entry)));
    process.exitCode = 1;
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (error) {
    console.error(`TypeScript check failed: ${error.message}`);
    process.exitCode = 1;
  }
}
