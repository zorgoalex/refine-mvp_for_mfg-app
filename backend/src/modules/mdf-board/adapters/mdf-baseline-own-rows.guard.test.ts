import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// countMdfOwnRows (baseline dry-run gate) counts only outbox/audit rows created no earlier than the dry-run transaction
// started. That holds while every writer leaves created_at to its default (transaction start) or sets clock_timestamp();
// a writer that back-dates created_at would let a dry-run side effect slip past the gate.
const root = join(__dirname, '../../../../');
function files(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) { if (name !== 'node_modules') files(path, out); }
    else if (/\.(ts|sql)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(path);
  }
  return out;
}

describe('MDF baseline dry-run own-row gate assumption', () => {
  it('no outbox/audit writer back-dates created_at', () => {
    const offenders: string[] = [];
    for (const file of [...files(join(root, 'src')), ...files(join(root, 'db/migrations'))]) {
      const text = readFileSync(file, 'utf8');
      for (const m of text.matchAll(/INSERT\s+INTO\s+(?:public\.)?(outbox_events|audit_log)\s*\(([^)]*)\)\s*(VALUES\s*\(|SELECT)([\s\S]{0,400})/gi)) {
        const columns = m[2].split(',').map(c => c.trim());
        const at = columns.indexOf('created_at');
        if (at < 0) continue;
        const values = m[4].split(',').map(v => v.trim());
        if (!/^(clock_timestamp\(\)|now\(\)|transaction_timestamp\(\)|DEFAULT)$/i.test(values[at] ?? '')) offenders.push(`${file}: ${values[at]}`);
      }
    }
    expect(offenders).toEqual([]);
  }, 30000); // reads every backend source file: slow on a loaded host
});
