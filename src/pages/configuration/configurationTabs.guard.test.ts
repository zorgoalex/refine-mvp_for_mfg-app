import { describe, expect, it } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';

describe('configuration tabs layout', () => {
  it('uses a wrapping tab bar so configuration tabs do not require horizontal scrolling', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');

    expect(source).toContain('configuration-tabs-wrap');
    expect(source).toContain("tabBarGutter={8}");
  });

  it('registers the table visibility tab in the configuration screen', () => {
    const source = fs.readFileSync(path.resolve(__dirname, 'index.tsx'), 'utf8');

    expect(source).toContain("key: 'table-visibility'");
    expect(source).toContain('Видимость таблиц для юзеров');
    expect(source).toContain('<TableVisibilityByRoleTab />');
  });
});
