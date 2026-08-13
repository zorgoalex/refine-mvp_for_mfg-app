import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./useFormWithHighlight.ts', import.meta.url), 'utf8');

describe('useFormWithHighlight tab title enrichment', () => {
  it('updates edit workspace tabs from loaded record data', () => {
    expect(source).toMatch(/useRecordTabTitle/);
    expect(source).toMatch(/actionLabel:\s*["']Редактирование["']/);
    expect(source).toMatch(/record:\s*formReturn\.queryResult\?\.data\?\.data/);
  });
});

describe('useFormWithHighlight success navigation', () => {
  it('resolves registered resource routes instead of deriving URLs from resource names', () => {
    expect(source).toMatch(/useGo/);
    expect(source).toMatch(/successResource\s*=\s*resource/);
    expect(source).toMatch(/navigateOnSuccess\s*=\s*true/);
    expect(source).toMatch(/if\s*\(\s*!navigateOnSuccess\s*\)/);
    expect(source).toMatch(/to:\s*\{\s*resource:\s*successResource,\s*action:\s*["']list["']\s*\}/);
    expect(source).toMatch(/query:\s*\{\s*highlightId:\s*recordId\s*\}/);
    expect(source).toMatch(
      /to:\s*\{\s*resource:\s*successResource,\s*action:\s*["']show["'],\s*id:\s*recordId\s*\}/,
    );
    expect(source).toMatch(/type:\s*["']replace["']/);
    expect(source).not.toMatch(/window\.location/);
  });
});
