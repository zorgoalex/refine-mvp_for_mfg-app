import { describe, expect, it } from 'vitest';
import { isEvolutionAvailable, isUiVariant, resolveUiVariant, setDocumentUiVariant } from './uiVariant';

describe('ui variant resolver', () => {
  it('fails closed for missing and disabled runtime config', () => {
    expect(resolveUiVariant(undefined)).toBe('legacy');
    expect(resolveUiVariant(null)).toBe('legacy');
    expect(resolveUiVariant({ evolutionEnabled: false })).toBe('legacy');
  });

  it('defaults to evolution when runtime allows it and respects confirmed user preference', () => {
    expect(resolveUiVariant({ evolutionEnabled: true })).toBe('evolution');
    expect(resolveUiVariant({ evolutionEnabled: true }, 'evolution')).toBe('evolution');
    expect(resolveUiVariant({ evolutionEnabled: true }, 'legacy')).toBe('legacy');
    expect(resolveUiVariant({ evolutionEnabled: true }, 'future')).toBe('evolution');
  });

  it('gives emergency force-legacy highest priority', () => {
    expect(resolveUiVariant(
      { evolutionEnabled: true, forceLegacy: true },
      'evolution',
    )).toBe('legacy');
    expect(isEvolutionAvailable({ evolutionEnabled: true, forceLegacy: true })).toBe(false);
  });

  it('validates preference values without coercion', () => {
    expect(isUiVariant('legacy')).toBe(true);
    expect(isUiVariant('evolution')).toBe(true);
    expect(isUiVariant('EVOLUTION')).toBe(false);
    expect(isUiVariant(null)).toBe(false);
  });

  it('sets the document marker synchronously before React renders', () => {
    const documentRef = { documentElement: { dataset: {} } } as unknown as Document;
    setDocumentUiVariant('evolution', documentRef);
    expect(documentRef.documentElement.dataset.uiVariant).toBe('evolution');
  });
});
