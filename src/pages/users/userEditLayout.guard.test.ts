import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const editSource = readFileSync(new URL('./edit.tsx', import.meta.url), 'utf8');
const ssoCardSource = readFileSync(
  new URL('./WorkosAdminLinksCard.tsx', import.meta.url),
  'utf8',
);

describe('user edit responsive layout', () => {
  it('uses two columns for regular fields and compact columns for short fields', () => {
    expect(editSource).toContain('<Row gutter={[16, 0]}>');
    expect(editSource).toContain('<Col xs={24} md={12}>');
    expect(editSource).toContain('<Col xs={24} sm={12} md={8}>');
    expect(editSource).toContain('<Col xs={24} sm={12} md={4}>');
  });

  it('keeps the password action inline and compacts SSO settings responsively', () => {
    expect(editSource).toContain('<Row gutter={[16, 0]} align="bottom">');
    expect(editSource).toContain('<Col xs={24} md={16} xl={8}>');
    expect(editSource).toContain('<Col xs={24} md={8} xl={4}>');
    expect(ssoCardSource).toContain('<Row gutter={[16, 16]} align="middle">');
    expect(ssoCardSource).toContain('<Col xs={24} xl={12} xxl={8}>');
    expect(ssoCardSource).toContain('<Col xs={24} md={12} xl={6} xxl={8}>');
  });
});
