import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

// Vitest is node-only (no jsdom) — guard the risky modal/list invariants via source text.
// Precedent: src/pages/orders/cut-detail-column.guard.test.ts
const modal = readFileSync(resolve(__dirname, 'QuickCreateDowelingModal.tsx'), 'utf8');
const list = readFileSync(resolve(__dirname, 'list.tsx'), 'utf8');

describe('QuickCreateDowelingModal source guards', () => {
  it('regenerates the idempotency key on OPEN, not inside onOk/submit', () => {
    expect(modal).toMatch(
      /useEffect\(\s*\(\)\s*=>\s*\{[\s\S]*?if \(open\)[\s\S]*?createDowelingIdempotencyKey\(\)/,
    );
    const handleOk = modal.slice(modal.indexOf('const handleOk'));
    expect(handleOk).not.toContain('createDowelingIdempotencyKey(');
    expect(handleOk).toContain('idempotencyKeyRef.current');
  });

  it('binds confirmLoading to busy and guards double-submit', () => {
    expect(modal).toContain('confirmLoading={busy}');
    expect(modal).toMatch(/if \(busy\) \{\s*return;/);
  });

  it('calls onCreated/onClose only on success; error branch keeps the modal open', () => {
    // Anchor relative to message.success so the EARLIER validation `} catch {` is not matched.
    const afterSuccess = modal.slice(modal.indexOf('message.success'));
    const successBranch = afterSuccess.slice(0, afterSuccess.indexOf('} catch'));
    expect(successBranch).toContain('onCreated()');
    expect(successBranch).toContain('onClose()');

    const errorBranch = afterSuccess.slice(
      afterSuccess.indexOf('} catch'),
      afterSuccess.indexOf('} finally'),
    );
    expect(errorBranch).toContain('message.error');
    expect(errorBranch).not.toContain('onClose(');
    expect(errorBranch).not.toContain('onCreated(');
  });

  it('name field carries whitespace + trim-edge validation (not only helper trim)', () => {
    expect(modal).toContain('whitespace: true');
    expect(modal).toMatch(/startsWith\(' '\)/);
    expect(modal).toMatch(/endsWith\(' '\)/);
  });

  it('posts through the backend command client (no page-level Hasura write)', () => {
    expect(modal).toContain("from '../../api/dowelingApi'");
    expect(modal).toContain('dowelingApi.create(');
  });
});

describe('doweling list source guards', () => {
  it('gates the quick-create button behind can(doweling.create)', () => {
    expect(list).toMatch(/can\(["']doweling\.create["']\)/);
    expect(list).toContain('Быстрое создание присадки');
  });

  it('refetches the table after a successful create', () => {
    expect(list).toContain('tableQueryResult.refetch()');
  });
});
