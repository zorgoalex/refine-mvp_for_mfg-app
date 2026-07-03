import { describe, expect, it } from 'vitest';
import { chipsToTemplate, templateToChips, uniqueQrName, qrElementFromLibrary, collectDuplicateQrNames, qrDraftFromElement } from './labelQrLibrary';
import { autoShiftForQr } from './labelQrHelpers';

describe('chips <-> template', () => {
  it('compiles chips to a {field}|text string', () => {
    expect(chipsToTemplate([{ kind: 'field', fieldId: 'bazis.detail_id' }, { kind: 'text', text: '-' }, { kind: 'field', fieldId: 'bazis.name' }], '|'))
      .toBe('{bazis.detail_id}|-|{bazis.name}');
  });
  it('round-trips', () => {
    const t = '{bazis.detail_id}|-|{bazis.name}';
    expect(chipsToTemplate(templateToChips(t), '|')).toBe(t);
  });
  it('strips separator/brace chars from static text so round-trip is safe', () => {
    expect(chipsToTemplate([{ kind: 'text', text: 'a|b{c}' }], '|')).toBe('abc');
  });
});

describe('uniqueQrName', () => {
  it('returns base when free', () => {
    expect(uniqueQrName('QR', [])).toBe('QR');
  });
  it('suffixes on collision', () => {
    expect(uniqueQrName('QR', ['QR'])).toBe('QR 2');
    expect(uniqueQrName('QR', ['QR', 'QR 2'])).toBe('QR 3');
  });
  it('collides case-insensitively (matches backend)', () => {
    expect(uniqueQrName('qr', ['QR'])).toBe('qr 2');
  });
});

describe('qrElementFromLibrary', () => {
  it('builds a qr element with snapshot style + unique name at drop point', () => {
    const el = qrElementFromLibrary(
      { name: 'Деталь', contentTemplate: '{bazis.detail_id}', errorCorrection: 'Q', defaultSizeMm: 18, sourceTemplateId: 7 },
      10, 12,
      [{ elementKey: 'e1', kind: 'qr', style: { qrName: 'Деталь' } } as any],
    );
    expect(el.kind).toBe('qr');
    expect(el.xMm).toBe(10);
    expect(el.yMm).toBe(12);
    expect(el.widthMm).toBe(18);
    expect(el.heightMm).toBe(18);
    expect(el.style).toMatchObject({ qrName: 'Деталь 2', qrTemplate: '{bazis.detail_id}', qrErrorCorrection: 'Q', qrSourceTemplateId: 7 });
  });

  it('dropping a library qr yields an element that autoShift keeps conflict-free', () => {
    const existing = [{ elementKey: 't1', kind: 'text', xMm: 5, yMm: 5, widthMm: 20, heightMm: 6, style: {} } as any];
    const el = qrElementFromLibrary({ name: 'QR', contentTemplate: '{bazis.detail_id}', errorCorrection: 'M', defaultSizeMm: 20 }, 4, 4, existing);
    const result = autoShiftForQr({ qr: el, elements: [...existing, el], canvas: { widthMm: 85, heightMm: 88 } });
    expect(result.conflicts).toHaveLength(0);
  });
});

describe('qrDraftFromElement', () => {
  it('derives a library draft from a placed qr element', () => {
    const draft = qrDraftFromElement({
      kind: 'qr', widthMm: 22, heightMm: 22,
      style: { qrName: 'Деталь 2', qrTemplate: '{bazis.detail_id}', qrErrorCorrection: 'Q' },
    } as any);
    expect(draft).toEqual({ name: 'Деталь 2', contentTemplate: '{bazis.detail_id}', errorCorrection: 'Q', defaultSizeMm: 22 });
  });
});

describe('collectDuplicateQrNames', () => {
  it('detects duplicate qr names within a label (case-insensitive)', () => {
    const els = [
      { kind: 'qr', style: { qrName: 'A' } },
      { kind: 'qr', style: { qrName: 'a' } },
      { kind: 'qr', style: { qrName: 'B' } },
      { kind: 'text', style: {} },
    ] as any;
    expect(collectDuplicateQrNames(els)).toEqual(['A']);
  });
});
