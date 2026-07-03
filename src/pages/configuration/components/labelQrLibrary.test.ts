import { describe, expect, it } from 'vitest';
import { rowsToTemplate, templateToRows, sanitizeQrText, uniqueQrName, qrElementFromLibrary, collectDuplicateQrNames, collectEmptyQrNames, qrDraftFromElement } from './labelQrLibrary';
import { autoShiftForQr } from './labelQrHelpers';

describe('sanitizeQrText', () => {
  it('strips braces and newlines but keeps pipe', () => {
    expect(sanitizeQrText('a|b{c}\nd')).toBe('a|bcd');
  });
  it('keeps pipe as literal text', () => {
    expect(sanitizeQrText('x|y')).toBe('x|y');
  });
});

describe('rowsToTemplate / templateToRows', () => {
  it('single row: field-text-field converts to template', () => {
    const rows = [[
      { kind: 'field' as const, fieldId: 'a' },
      { kind: 'text' as const, text: '-' },
      { kind: 'field' as const, fieldId: 'b' },
    ]];
    expect(rowsToTemplate(rows)).toBe('{a}-{b}');
  });

  it('multi-row: concatenates with newline', () => {
    const rows = [
      [{ kind: 'field' as const, fieldId: 'a' }],
      [{ kind: 'field' as const, fieldId: 'b' }],
    ];
    expect(rowsToTemplate(rows)).toBe('{a}\n{b}');
  });

  it('text with pipe is preserved in template', () => {
    const rows = [[{ kind: 'text' as const, text: 'x|y' }]];
    expect(rowsToTemplate(rows)).toBe('x|y');
  });

  it('trailing empty rows are dropped', () => {
    const rows = [
      [{ kind: 'field' as const, fieldId: 'a' }],
      [],
      [],
    ];
    expect(rowsToTemplate(rows)).toBe('{a}');
  });

  it('interior empty rows are kept', () => {
    const rows = [
      [{ kind: 'field' as const, fieldId: 'a' }],
      [],
      [{ kind: 'field' as const, fieldId: 'b' }],
    ];
    expect(rowsToTemplate(rows)).toBe('{a}\n\n{b}');
  });

  it('leading empty rows are dropped (symmetric with trailing, matches backend .trim())', () => {
    const rows = [
      [],
      [{ kind: 'field' as const, fieldId: 'a' }],
    ];
    expect(rowsToTemplate(rows)).toBe('{a}');
  });

  it('round-trip is stable for rows with no leading/trailing empties', () => {
    const rows = [
      [{ kind: 'field' as const, fieldId: 'a' }],
      [],
      [{ kind: 'field' as const, fieldId: 'b' }],
    ];
    expect(templateToRows(rowsToTemplate(rows))).toEqual(rows);
  });

  it('templateToRows: single row field-text-field', () => {
    expect(templateToRows('{a}-{b}')).toEqual([
      [
        { kind: 'field', fieldId: 'a' },
        { kind: 'text', text: '-' },
        { kind: 'field', fieldId: 'b' },
      ],
    ]);
  });

  it('templateToRows: multi-row', () => {
    expect(templateToRows('{a}\n{b}')).toEqual([
      [{ kind: 'field', fieldId: 'a' }],
      [{ kind: 'field', fieldId: 'b' }],
    ]);
  });

  it('templateToRows: text with pipe kept', () => {
    expect(templateToRows('x|y')).toEqual([
      [{ kind: 'text', text: 'x|y' }],
    ]);
  });

  it('templateToRows: empty lines become empty rows', () => {
    expect(templateToRows('a\n\nb')).toEqual([
      [{ kind: 'text', text: 'a' }],
      [],
      [{ kind: 'text', text: 'b' }],
    ]);
  });

  it('round-trip: single row', () => {
    const t = '{a}-{b}';
    expect(rowsToTemplate(templateToRows(t))).toBe(t);
  });

  it('round-trip: multi-row', () => {
    const t = '{a}\n{b}';
    expect(rowsToTemplate(templateToRows(t))).toBe(t);
  });

  it('round-trip: text with pipe', () => {
    const t = 'x|y';
    expect(rowsToTemplate(templateToRows(t))).toBe(t);
  });

  it('round-trip: mixed content', () => {
    const t = '{a}-x|y\n{b}';
    expect(rowsToTemplate(templateToRows(t))).toBe(t);
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

describe('collectEmptyQrNames', () => {
  it('detects qr elements with an empty or whitespace-only qrName (1-based position among qr elements)', () => {
    const els = [
      { kind: 'qr', style: { qrName: '' } },
      { kind: 'qr', style: { qrName: 'A' } },
      { kind: 'qr', style: { qrName: '   ' } },
      { kind: 'text', style: {} },
    ] as any;
    expect(collectEmptyQrNames(els)).toEqual([1, 3]);
  });

  it('returns an empty array when every qr element is named', () => {
    const els = [
      { kind: 'qr', style: { qrName: 'A' } },
      { kind: 'qr', style: { qrName: 'B' } },
    ] as any;
    expect(collectEmptyQrNames(els)).toEqual([]);
  });

  it('treats a missing style/qrName as empty (pre-existing qr elements with no qrName column)', () => {
    const els = [{ kind: 'qr' }] as any;
    expect(collectEmptyQrNames(els)).toEqual([1]);
  });
});
