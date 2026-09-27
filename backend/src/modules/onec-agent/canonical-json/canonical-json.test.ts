import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CanonicalJsonError,
  canonicalizeValue,
  measureJson,
  parseStrictJson,
  parseStrictJsonBytes,
  canonicalize,
  sha256Base64,
} from './canonical-json';

const DIR = join(__dirname, '__fixtures__', 'vectors');
const cases = [...new Set(readdirSync(DIR).map((name) => name.replace(/-(input\.json|canonical\.txt|hash\.txt|rejected\.txt)$/, '')))].sort();

describe('canonical JSON agent-payload-sha256-base64-v1: agent vectors', () => {
  it('has all 35 agent vectors', () => {
    expect(cases).toHaveLength(35);
  });

  for (const name of cases) {
    const input = readFileSync(join(DIR, `${name}-input.json`));
    const rejected = readdirSync(DIR).includes(`${name}-rejected.txt`);
    it(`${name}: ${rejected ? 'rejected' : 'canonical form and hash match byte for byte'}`, () => {
      if (rejected) {
        expect(() => parseStrictJsonBytes(input)).toThrow(CanonicalJsonError);
        return;
      }
      const canonical = canonicalize(parseStrictJsonBytes(input));
      expect(Buffer.from(canonical, 'utf8').equals(readFileSync(join(DIR, `${name}-canonical.txt`)))).toBe(true);
      expect(sha256Base64(canonical)).toBe(readFileSync(join(DIR, `${name}-hash.txt`), 'utf8').trim());
    });
  }
});

describe('canonical JSON: ERP-side invariants', () => {
  it('is idempotent: canonical(canonical(x)) === canonical(x)', () => {
    for (const name of cases) {
      const path = join(DIR, `${name}-canonical.txt`);
      if (!readdirSync(DIR).includes(`${name}-canonical.txt`)) continue;
      const once = readFileSync(path, 'utf8');
      expect(canonicalize(parseStrictJson(once))).toBe(once);
    }
  });

  it('rejects a UTF-8 BOM and invalid UTF-8', () => {
    expect(() => parseStrictJsonBytes(Buffer.from([0xef, 0xbb, 0xbf, 0x7b, 0x7d]))).toThrow(CanonicalJsonError);
    expect(() => parseStrictJsonBytes(Buffer.from([0x22, 0xc3, 0x22]))).toThrow(CanonicalJsonError);
  });

  it('does not treat full-case-mapping expansions as duplicates (ß vs SS)', () => {
    expect(() => parseStrictJson('{"ß":1,"SS":2}')).not.toThrow();
    expect(() => parseStrictJson('{"Key":1,"kEY":2}')).toThrow(/Duplicate/);
  });

  it('serializes ERP values: safe integers only, undefined fields omitted', () => {
    expect(canonicalizeValue({ b: 2, a: 'Привет', c: undefined, d: [true, null] }).canonical)
      .toBe('{"a":"\\u041F\\u0440\\u0438\\u0432\\u0435\\u0442","b":2,"d":[true,null]}');
    expect(() => canonicalizeValue({ price: 1.5 })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeValue({ n: Number.MAX_SAFE_INTEGER + 1 })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeValue({ s: '\ud800' })).toThrow(CanonicalJsonError);
    expect(() => canonicalizeValue({ K: 1, k: 2 })).toThrow(CanonicalJsonError);
  });

  it('measures depth, node count and widest object', () => {
    expect(measureJson(parseStrictJson('1'))).toEqual({ depth: 0, nodes: 1, maxObjectFields: 0 });
    expect(measureJson(parseStrictJson('{"a":[1,{"b":2,"c":3}]}'))).toEqual({ depth: 3, nodes: 6, maxObjectFields: 2 });
  });

  it('rejects nesting beyond the parser guard', () => {
    expect(() => parseStrictJson(`${'['.repeat(70)}${']'.repeat(70)}`)).toThrow(CanonicalJsonError);
  });
});
