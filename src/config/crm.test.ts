import { describe, expect, it, vi } from 'vitest';
import { getCrmMenuConfig, ensureCrmResourceHints } from './crm';

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
      const m = /data-crm-hint="([^"]+)"/.exec(sel);
      const rel = m?.[1];
      return links.find((l) => l['attr:data-crm-hint'] === rel) ?? null;
    },
  };
}

describe('getCrmMenuConfig', () => {
  it('defaults to the crm-test Orders deep link and "CRM" label when env is empty', () => {
    expect(getCrmMenuConfig({})).toEqual({
      url: 'https://crm-test.mebelkz.app/objects/erpOrders',
      label: 'CRM',
    });
  });

  it('honors VITE_CRM_URL override (origin) + default Orders path', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: 'https://crm.mebelkz.app' })).toEqual({
      url: 'https://crm.mebelkz.app/objects/erpOrders',
      label: 'CRM',
    });
  });

  it('honors VITE_CRM_PATH override', () => {
    expect(getCrmMenuConfig({ VITE_CRM_PATH: '/objects/companies' })?.url).toBe(
      'https://crm-test.mebelkz.app/objects/companies',
    );
  });

  it('opens the CRM root when VITE_CRM_PATH is empty', () => {
    expect(getCrmMenuConfig({ VITE_CRM_PATH: '' })?.url).toBe('https://crm-test.mebelkz.app');
  });

  it('honors VITE_CRM_LABEL override', () => {
    expect(getCrmMenuConfig({ VITE_CRM_LABEL: 'Twenty CRM' })?.label).toBe('Twenty CRM');
  });

  it('trims whitespace and avoids double slashes when joining base + path', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: '  https://crm.mebelkz.app/  ' })?.url).toBe(
      'https://crm.mebelkz.app/objects/erpOrders',
    );
  });

  it('returns null when VITE_CRM_URL is explicitly empty (link hidden)', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: '' })).toBeNull();
    expect(getCrmMenuConfig({ VITE_CRM_URL: '   ' })).toBeNull();
  });

  it('returns null for a non-http(s) value', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: 'javascript:alert(1)' })).toBeNull();
    expect(getCrmMenuConfig({ VITE_CRM_URL: 'crm.mebelkz.app' })).toBeNull();
  });
});

describe('ensureCrmResourceHints', () => {
  it('injects dns-prefetch, preconnect and prefetch hints for the CRM origin', () => {
    const doc = makeFakeDoc();
    ensureCrmResourceHints('https://crm-test.mebelkz.app', doc);
    const rels = doc.links.map((l) => l['attr:data-crm-hint']);
    expect(rels).toEqual(['dns-prefetch', 'preconnect', 'prefetch']);
    // preconnect/dns-prefetch target the origin; prefetch targets the full URL
    expect(doc.links[0].rel).toBe('dns-prefetch');
    expect(doc.links[0].href).toBe('https://crm-test.mebelkz.app');
    expect(doc.links[2].rel).toBe('prefetch');
  });

  it('is idempotent — re-calling does not duplicate hints', () => {
    const doc = makeFakeDoc();
    ensureCrmResourceHints('https://crm-test.mebelkz.app', doc);
    ensureCrmResourceHints('https://crm-test.mebelkz.app', doc);
    expect(doc.links).toHaveLength(3);
  });

  it('does nothing for an invalid URL or missing document', () => {
    const doc = makeFakeDoc();
    ensureCrmResourceHints('not a url', doc);
    expect(doc.links).toHaveLength(0);
    expect(() => ensureCrmResourceHints('https://x.test', undefined)).not.toThrow();
  });
});
