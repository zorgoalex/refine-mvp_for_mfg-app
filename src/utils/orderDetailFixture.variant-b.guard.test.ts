import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

/**
 * Variant B fixture guard — no order-detail fixture may set a numeric material_id.
 *
 * Post-034, order_details.material_id IS NULL for every row.  Fixtures that
 * seed order details with a numeric material_id would silently produce incorrect
 * mocked state and mask real regressions.
 *
 * Scanning strategy: for each file, split on `db.XXX.push(` call boundaries.
 * Within each push segment, a numeric `material_id: <N>` is a violation UNLESS
 * the segment is clearly a materials-catalog row (contains `material_name:`) or
 * an order_resource_requirements row (contains `requirement_id:`).
 *
 * This is a source-text guard (no runtime required); it runs in the vitest
 * node environment.
 */

// Paths are relative to this file (src/utils/), going two dirs up to project root.
const ROOT = resolve(__dirname, '../..');

const SCANNED_FILES = [
  resolve(ROOT, 'tests/helpers/mockWorkflowApi.ts'),
  resolve(ROOT, 'tests/order-workflows.spec.ts'),
  resolve(ROOT, 'tests/order-save-backend-command-boundary.spec.ts'),
  resolve(ROOT, 'tests/frontend-pages-smoke.spec.ts'),
  resolve(ROOT, 'tests/production-actions-backend-cutover.spec.ts'),
  resolve(ROOT, 'tests/regression/order-finance-buttons.regression.spec.ts'),
];

interface Violation {
  file: string;
  line: number;
  text: string;
}

/**
 * Extract the body of the first push call from a post-split segment.
 * Segments arrive AFTER the `db.XXX.push(` split, so they start with `{`.
 * We walk until we find the matching `)` at brace-depth 0.
 */
function extractPushBody(segment: string): string | null {
  let depth = 0;
  let i = 0;
  let started = false;

  for (; i < segment.length; i++) {
    const ch = segment[i];
    if (ch === '{') { depth++; started = true; }
    if (ch === '}') { depth--; }
    if (ch === ')' && started && depth === 0) break;
  }

  return started ? segment.slice(0, i) : null;
}

/**
 * Returns violations in the given file: numeric material_id inside push segments
 * that are NOT materials-catalog or order_resource_requirements rows.
 */
function findViolations(filePath: string): Violation[] {
  const src = readFileSync(filePath, 'utf8');
  const violations: Violation[] = [];

  const segments = src.split(/db\.\w+\.push\(/);

  for (const segment of segments) {
    const pushBody = extractPushBody(segment);
    if (!pushBody) continue;

    if (!/\bmaterial_id\s*:\s*\d+/.test(pushBody)) continue;

    // Exclusion 1: materials catalog row — has material_name: as a separate column.
    if (/\bmaterial_name\s*:/.test(pushBody)) continue;

    // Exclusion 2: order_resource_requirements row — has requirement_id:.
    if (/\brequirement_id\s*:/.test(pushBody)) continue;

    const match = pushBody.match(/\bmaterial_id\s*:\s*(\d+)/);
    if (!match) continue;

    const idx = src.indexOf(match[0]);
    const lineNo = src.substring(0, idx).split('\n').length;
    violations.push({ file: filePath.replace(ROOT + '/', ''), line: lineNo, text: match[0] });
  }

  return violations;
}

describe('Variant B guard: no order-detail fixture sets a numeric material_id', () => {
  for (const filePath of SCANNED_FILES) {
    const label = filePath.replace(ROOT + '/', '');
    it(`${label} — no numeric material_id on order details`, () => {
      const violations = findViolations(filePath);
      expect(
        violations,
        `Found numeric material_id on order details in ${label}:\n${JSON.stringify(violations, null, 2)}`,
      ).toHaveLength(0);
    });
  }
});
