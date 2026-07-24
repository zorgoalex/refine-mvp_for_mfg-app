import { describe, expect, it, vi } from 'vitest';
import { ensureBitrix24ResourceHints, getBitrix24MenuConfig } from './bitrix24';

// Minimal fake document for resource-hint injection (Vitest runs in node, no DOM).
function makeFakeDoc() {
  const links: Array<Record<string, unknown>> = [];
  const head = {
    appendChild: (el: Record<string, unknown>) => {
      links.push(el);
      return el;
    },
  };
  return {
    links,
    head: head as unknown as HTMLHeadElement,
    createElement: () => {
      const el: Record<string, unknown> = {
        setAttribute(this: Record<string, unknown>, k: string, v: string) {
          this[`attr:${k}`] = v;
        },
      };
      return el as unknown as HTMLElement;
    },
    querySelector: (sel: string) => {
      const m = /data-bitrix24-hint="([^"]+)"/.exec(sel);
      const rel = m?.[1];
      return links.find((l) => l['attr:data-bitrix24-hint'] === rel) ?? null;
    },
  };
}

describe('getBitrix24MenuConfig', () => {
  it('defaults to the organization Bitrix24 portal', () => {
    expect(getBitrix24MenuConfig({})).toEqual({
      url: 'https://mebelkz.bitrix24.kz/',
      label: 'Битрикс24',
    });
  });

  it('honors a full VITE_BITRIX24_URL override', () => {
    expect(
      getBitrix24MenuConfig({
        VITE_BITRIX24_URL: 'https://example.bitrix24.kz/crm/deal/',
      }),
    ).toEqual({
      url: 'https://example.bitrix24.kz/crm/deal/',
      label: 'Битрикс24',
    });
  });

  it('does not reuse the retired CRM environment variables', () => {
    expect(
      getBitrix24MenuConfig({
        VITE_CRM_URL: 'https://crm-test.mebelkz.app',
        VITE_CRM_PATH: '/objects/erpOrders',
        VITE_CRM_LABEL: 'CRM',
      }),
    ).toEqual({
      url: 'https://mebelkz.bitrix24.kz/',
      label: 'Битрикс24',
    });
  });

  it('honors VITE_BITRIX24_LABEL override', () => {
    expect(
      getBitrix24MenuConfig({ VITE_BITRIX24_LABEL: 'CRM Битрикс24' })?.label,
    ).toBe('CRM Битрикс24');
  });

  it('returns null when VITE_BITRIX24_URL is explicitly empty (link hidden)', () => {
    expect(getBitrix24MenuConfig({ VITE_BITRIX24_URL: '' })).toBeNull();
    expect(getBitrix24MenuConfig({ VITE_BITRIX24_URL: '   ' })).toBeNull();
  });

  it('returns null for a non-http(s) value', () => {
    expect(getBitrix24MenuConfig({ VITE_BITRIX24_URL: 'javascript:alert(1)' })).toBeNull();
    expect(getBitrix24MenuConfig({ VITE_BITRIX24_URL: 'mebelkz.bitrix24.kz' })).toBeNull();
  });
});

describe('ensureBitrix24ResourceHints', () => {
  it('injects only dns-prefetch + preconnect (NO document prefetch — CSP-safe)', () => {
    const doc = makeFakeDoc();
    ensureBitrix24ResourceHints('https://mebelkz.bitrix24.kz/', doc);
    const rels = doc.links.map((l) => l['attr:data-bitrix24-hint']);
    // The cross-origin `rel=prefetch as=document` was removed: it violated the
    // app CSP default-src 'self' and logged an error on every CRM-menu page.
    expect(rels).toEqual(['dns-prefetch', 'preconnect']);
    expect(rels).not.toContain('prefetch');
    expect(doc.links[0].rel).toBe('dns-prefetch');
    expect(doc.links[0].href).toBe('https://mebelkz.bitrix24.kz');
    expect(doc.links[1].rel).toBe('preconnect');
  });

  it('is idempotent — re-calling does not duplicate hints', () => {
    const doc = makeFakeDoc();
    ensureBitrix24ResourceHints('https://mebelkz.bitrix24.kz/', doc);
    ensureBitrix24ResourceHints('https://mebelkz.bitrix24.kz/', doc);
    expect(doc.links).toHaveLength(2);
  });

  it('does nothing for an invalid URL or missing document', () => {
    const doc = makeFakeDoc();
    ensureBitrix24ResourceHints('not a url', doc);
    expect(doc.links).toHaveLength(0);
    expect(() => ensureBitrix24ResourceHints('https://x.test', undefined)).not.toThrow();
  });
});
