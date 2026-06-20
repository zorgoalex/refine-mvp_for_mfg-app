import { describe, expect, it } from 'vitest';
import { getCrmMenuConfig } from './crm';

describe('getCrmMenuConfig', () => {
  it('defaults to the crm-test URL and "CRM" label when env is empty', () => {
    expect(getCrmMenuConfig({})).toEqual({
      url: 'https://crm-test.mebelkz.app',
      label: 'CRM',
    });
  });

  it('honors VITE_CRM_URL override', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: 'https://crm.mebelkz.app' })).toEqual({
      url: 'https://crm.mebelkz.app',
      label: 'CRM',
    });
  });

  it('honors VITE_CRM_LABEL override', () => {
    expect(getCrmMenuConfig({ VITE_CRM_LABEL: 'Twenty CRM' })?.label).toBe('Twenty CRM');
  });

  it('trims surrounding whitespace from the URL', () => {
    expect(getCrmMenuConfig({ VITE_CRM_URL: '  https://crm.mebelkz.app  ' })?.url).toBe(
      'https://crm.mebelkz.app',
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
