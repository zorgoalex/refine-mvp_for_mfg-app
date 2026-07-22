import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { generateProductionStatusCode } from './productionStatusCode';

describe('production status code generation', () => {
  const suffix = '0123456789abcdef0123456789abcdef';

  it('creates a stable code from English, Russian and Kazakh names', () => {
    expect(generateProductionStatusCode('Done', suffix)).toBe(`done_${suffix}`);
    expect(generateProductionStatusCode('Закрыто', suffix)).toBe(`zakryto_${suffix}`);
    expect(generateProductionStatusCode('Өндіріс аяқталды', suffix)).toBe(`ondiris_ayaqtaldy_${suffix}`);
    expect(generateProductionStatusCode('Йод, ёж и їжа', suffix)).toBe(`yod_yozh_i_yizha_${suffix}`);
  });

  it('always satisfies the database code format and length limit', () => {
    const codes = [
      generateProductionStatusCode('123 Ready', suffix),
      generateProductionStatusCode('✅', suffix),
      generateProductionStatusCode('Очень длинное название '.repeat(10), suffix),
    ];

    for (const code of codes) {
      expect(code).toMatch(/^[a-z][a-z0-9_]*$/);
      expect(code.length).toBeLessThanOrEqual(64);
    }
    expect(codes[0]).toBe(`status_123_ready_${suffix}`);
  });

  it('keeps colliding readable names unique without user input', () => {
    const first = generateProductionStatusCode('Готово', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa');
    const second = generateProductionStatusCode('gotovo', 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb');

    expect(first).toMatch(/^gotovo_/);
    expect(second).toMatch(/^gotovo_/);
    expect(first).not.toBe(second);
  });

  it('keeps the technical code hidden from both forms', () => {
    const createForm = readFileSync('src/pages/production_statuses/create.tsx', 'utf8');
    const editForm = readFileSync('src/pages/production_statuses/edit.tsx', 'utf8');

    expect(createForm).toContain('production_status_code: generateProductionStatusCode(name)');
    expect(createForm).not.toMatch(/name=["']production_status_code["']/);
    expect(editForm).toContain('production_status_code: _productionStatusCode');
    expect(editForm).not.toMatch(/name=["']production_status_code["']/);
  });
});
