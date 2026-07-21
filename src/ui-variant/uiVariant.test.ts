import { describe, expect, it } from 'vitest';
import { resolveUiVariant, setDocumentUiVariant } from './uiVariant';

describe('ui variant resolver', () => {
  it('fails closed for missing and disabled runtime config', () => {
    expect(resolveUiVariant(undefined)).toBe('legacy');
    expect(resolveUiVariant(null)).toBe('legacy');
    expect(resolveUiVariant({ evolutionEnabled: false })).toBe('legacy');
  });

  it('enables evolution only from an explicit runtime value', () => {
    expect(resolveUiVariant({ evolutionEnabled: true })).toBe('evolution');
  });

  it('gives emergency force-legacy highest priority', () => {
    expect(resolveUiVariant({ evolutionEnabled: true, forceLegacy: true })).toBe('legacy');
  });

  it('sets the document marker synchronously before React renders', () => {
    const documentRef = { documentElement: { dataset: {} } } as unknown as Document;
    setDocumentUiVariant('evolution', documentRef);
    expect(documentRef.documentElement.dataset.uiVariant).toBe('evolution');
  });
});
