import { describe, expect, it } from 'vitest';
import {
  assertProjectsInferencePreviewAllowed,
  buildStrictSameClientPreviewSql,
  parseProjectsInferencePreviewArgs,
} from './projects-inference-backfill-preview-lib.js';

describe('projects inference backfill preview args', () => {
  it('accepts backend-test strict-same-client preview output outside repo_erp', () => {
    const args = parseProjectsInferencePreviewArgs([
      '--target-env',
      'backend-test',
      '--rule',
      'strict-same-client',
      '--output',
      '/home/ovhtest/projects/erp_dev/spec_erp/manifests/projects-inference-preview-2026-06-15.json',
    ]);

    expect(args).toEqual({
      targetEnv: 'backend-test',
      rule: 'strict-same-client',
      output: '/home/ovhtest/projects/erp_dev/spec_erp/manifests/projects-inference-preview-2026-06-15.json',
      limit: null,
    });
    expect(() => assertProjectsInferencePreviewAllowed(args)).not.toThrow();
  });

  it('rejects non-backend-test targets', () => {
    const args = parseProjectsInferencePreviewArgs([
      '--target-env',
      'production',
      '--rule',
      'strict-same-client',
      '--output',
      '/home/ovhtest/projects/erp_dev/spec_erp/manifests/out.json',
    ]);

    expect(() => assertProjectsInferencePreviewAllowed(args)).toThrow(/backend-test/);
  });

  it('rejects output inside repo_erp', () => {
    const args = parseProjectsInferencePreviewArgs([
      '--target-env',
      'backend-test',
      '--rule',
      'strict-same-client',
      '--output',
      '/home/ovhtest/projects/erp_dev/repo_erp/out.json',
    ]);

    expect(() => assertProjectsInferencePreviewAllowed(args)).toThrow(/outside repo_erp/);
  });

  it('rejects fuzzy rules', () => {
    const args = parseProjectsInferencePreviewArgs([
      '--target-env',
      'backend-test',
      '--rule',
      'fuzzy-name',
      '--output',
      '/home/ovhtest/projects/erp_dev/spec_erp/manifests/out.json',
    ]);

    expect(() => assertProjectsInferencePreviewAllowed(args)).toThrow(/strict-same-client/);
  });

  it('rejects invalid limit values', () => {
    expect(() => parseProjectsInferencePreviewArgs([
      '--target-env',
      'backend-test',
      '--rule',
      'strict-same-client',
      '--limit',
      '0',
      '--output',
      '/home/ovhtest/projects/erp_dev/spec_erp/manifests/out.json',
    ])).toThrow(/positive integer/);
  });
});

describe('strict same-client preview SQL', () => {
  it('builds read-only SQL with test-order and already-linked exclusions', () => {
    const sql = buildStrictSameClientPreviewSql({ limit: 25 });
    const normalized = sql.toLowerCase();

    expect(sql).toContain("o.order_name !~* '^(E2E|TEST|Тест|Check-deafline)'");
    expect(sql).toContain('not exists (');
    expect(sql).toContain("existing.entity_type_code='order'");
    expect(sql).toContain('limit 25');
    expect(normalized).not.toContain('insert ');
    expect(normalized).not.toContain('update ');
    expect(normalized).not.toContain('delete ');
  });
});
