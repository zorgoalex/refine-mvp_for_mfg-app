import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const sql = readFileSync(new URL('./093_packer_role.sql', import.meta.url), 'utf8');

describe('093 packer role migration', () => {
  it('adds the packer role with the canonical static RBAC id', () => {
    expect(sql).toMatch(/INSERT INTO public\.roles/i);
    expect(sql).toContain('30');
    expect(sql).toContain("'packer'");
    expect(sql).toContain("'Упаковщик'");
    expect(sql).toMatch(/ON CONFLICT \(role_id\) DO UPDATE/i);
  });
});
