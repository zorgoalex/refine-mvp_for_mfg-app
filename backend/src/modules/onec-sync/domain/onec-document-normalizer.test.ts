import { describe, expect, it } from 'vitest';
import { buildTarget, decimalLexeme, DOCUMENT_ENTITIES, effectiveDocKinds, entityDocKinds, parseDocument, type ReferenceData } from './onec-document-normalizer';

const REF = '11111111-1111-1111-1111-111111111111';
const CUR = '22222222-2222-2222-2222-222222222222';
const CP = '33333333-3333-3333-3333-333333333333';
const ITEM = '44444444-4444-4444-4444-444444444444';
const UNIT = '55555555-5555-5555-5555-555555555555';
const ZERO = '00000000-0000-0000-0000-000000000000';

const receipt = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
  Ref_Key: REF.toUpperCase(), Number: ' 0000000123 ', Date: '2024-03-05T10:15:00', Posted: true, DeletionMark: false,
  Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: 1234.567, Комментарий: '  ', Запасы: lines, ...extra,
});
const line = (extra: Record<string, unknown> = {}) => ({
  LineNumber: '1', Номенклатура_Key: ITEM, Количество: 2.5, ЕдиницаИзмерения: UNIT, Цена: 100, Всего: 250.004, ЗаказПокупателя_Key: ZERO, ...extra,
});
const refs = (overrides: Partial<ReferenceData> = {}): ReferenceData => ({
  units: new Map([[UNIT, { code: '055', name: 'м2' }]]),
  itemNames: new Map([[ITEM, 'Плита']]),
  counterpartyNames: new Map([[CP, 'Поставщик']]),
  suppliers: new Map(),
  sheetMaterials: new Map([[ITEM, [7]]]),
  films: new Map(),
  currencies: new Map([[CUR, 'KZT']]),
  timeZone: 'Asia/Almaty',
  ...overrides,
});

describe('1C document normalizer', () => {
  it('parses a receipt: trimmed number, date part, lower-case keys, zero GUID → null, lexemes at column scale', () => {
    const parsed = parseDocument(DOCUMENT_ENTITIES.doc_purchase_receipts, receipt([line(), line({ LineNumber: '2', Количество: 1 })]));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.header).toMatchObject({ refKey: REF, number: '0000000123', docDate: '2024-03-05', amount: '1234.57', comment: null, counterpartyRefKey: CP });
    expect(parsed.lines.map((l) => [l.lineNo, l.quantity, l.amount, l.onecOrderRefKey])).toEqual([[1, '2.500', '250.00', null], [2, '1.000', '250.00', null]]);
  });

  it('turns a payment into one document-total line with the document amount', () => {
    const parsed = parseDocument(DOCUMENT_ENTITIES.doc_cash_outflows, { Ref_Key: REF, Number: 'К-1', Date: '2024-01-02T00:00:00', Posted: true,
      DeletionMark: false, ВалютаДенежныхСредств_Key: CUR, СуммаДокумента: 50 });
    expect(parsed.ok && parsed.lines).toEqual([{ lineNo: 1, nomenclatureRefKey: null, quantity: '0.000', unitRefKey: null, price: null,
      amount: '50.00', onecOrderRefKey: null, isDocumentTotal: true, warehouseRefKey: null, isStockItem: true, unitIsPackage: false }]);
  });

  it('refuses malformed documents with a code', () => {
    const config = DOCUMENT_ENTITIES.doc_purchase_receipts;
    expect(parseDocument(config, receipt([line()], { Ref_Key: 'x' }))).toEqual({ ok: false, code: 'INVALID_REF_KEY' });
    expect(parseDocument(config, receipt([line()], { Date: 'yesterday' }))).toEqual({ ok: false, code: 'INVALID_DATE' });
    expect(parseDocument(config, receipt([line(), line()]))).toEqual({ ok: false, code: 'INVALID_LINE_NUMBER' });
    expect(parseDocument(config, receipt([line({ Количество: -1 })]))).toEqual({ ok: false, code: 'INVALID_QUANTITY' });
    expect(parseDocument(config, receipt('nope' as never))).toEqual({ ok: false, code: 'INVALID_LINES' });
  });

  it('maps units by OKEI code, material only for a single candidate, supplier only for a single key', () => {
    const parsed = parseDocument(DOCUMENT_ENTITIES.doc_purchase_receipts, receipt([line()]));
    if (!parsed.ok) throw new Error('parse');
    const mapped = buildTarget(parsed, refs({ suppliers: new Map([[CP, [3]]]) }), false);
    expect(mapped.ok && mapped.lines[0]).toMatchObject({ unitCode: 'm2', unitName: 'м2', sheetMaterialTypeId: 7, filmId: null, mappingIssue: null, nomenclatureName: 'Плита' });
    expect(mapped.ok && mapped.header).toMatchObject({ supplierId: 3, counterpartyName: 'Поставщик', currency: 'KZT', mappingIssue: null });

    const ambiguous = buildTarget(parsed, refs({ films: new Map([[ITEM, [9]]]), suppliers: new Map([[CP, [3, 4]]]) }), false);
    expect(ambiguous.ok && ambiguous.lines[0]).toMatchObject({ sheetMaterialTypeId: null, filmId: null, mappingIssue: 'ambiguous_material' });
    expect(ambiguous.ok && ambiguous.header).toMatchObject({ supplierId: null, mappingIssue: 'ambiguous_supplier' });

    const unknownUnit = buildTarget(parsed, refs({ units: new Map([[UNIT, { code: '356', name: 'ч' }]]) }), false);
    expect(unknownUnit.ok && unknownUnit.lines[0].unitCode).toBeNull();
  });

  it('fails on an unmapped currency and changes the fingerprint on every input that changes the result', () => {
    const parsed = parseDocument(DOCUMENT_ENTITIES.doc_purchase_receipts, receipt([line()]));
    if (!parsed.ok) throw new Error('parse');
    expect(buildTarget(parsed, refs({ currencies: new Map() }), false)).toEqual({ ok: false, code: 'UNKNOWN_CURRENCY' });
    const base = buildTarget(parsed, refs(), false);
    const again = buildTarget(parsed, refs(), false);
    const missing = buildTarget(parsed, refs(), true);
    const renamed = buildTarget(parsed, refs({ itemNames: new Map([[ITEM, 'Плита 2']]) }), false);
    const remapped = buildTarget(parsed, refs({ sheetMaterials: new Map([[ITEM, [8]]]) }), false);
    const fp = (result: ReturnType<typeof buildTarget>) => (result.ok ? result.fingerprint : null);
    expect(fp(base)).toBe(fp(again));
    expect(new Set([fp(base), fp(missing), fp(renamed), fp(remapped)]).size).toBe(4);
  });

  it('rounds decimals half up at the column scale', () => {
    expect(decimalLexeme(1.005, 2)).toBe('1.01');
    expect(decimalLexeme('2.0004', 3)).toBe('2.000');
    expect(decimalLexeme(null, 2)).toBeNull();
    expect(decimalLexeme('abc', 2)).toBeNull();
  });

  describe('consumption documents (plan §3.2)', () => {
    const WH = '66666666-6666-6666-6666-666666666666';
    const WH2 = '77777777-7777-7777-7777-777777777777';
    const shipment = (lines: unknown[], extra: Record<string, unknown> = {}) => ({
      Ref_Key: REF, Number: 'НФНФ-1', Date: '2026-06-02T14:36:52', Posted: true, DeletionMark: false, ВидОперации: 'ПродажаПокупателю',
      Контрагент_Key: CP, ВалютаДокумента_Key: CUR, СуммаДокумента: 100, СтруктурнаяЕдиница_Key: WH, Запасы: lines, ...extra,
    });
    const sline = (extra: Record<string, unknown> = {}) => ({
      LineNumber: 1, Номенклатура_Key: ITEM, Количество: 12.5, ЕдиницаИзмерения: UNIT,
      ЕдиницаИзмерения_Type: 'StandardODATA.Catalog_КлассификаторЕдиницИзмерения', ТипНоменклатурыЗапас: true, Цена: 8, Всего: 100, ...extra,
    });

    it('takes the kind from ВидОперации, the line warehouse (header as fallback), the stock flag and a package unit', () => {
      const parsed = parseDocument(DOCUMENT_ENTITIES.doc_sales_shipments, shipment([
        sline({ СтруктурнаяЕдиница_Key: WH2 }),
        sline({ LineNumber: 2, СтруктурнаяЕдиница_Key: ZERO, ТипНоменклатурыЗапас: false }),
        sline({ LineNumber: 3, ЕдиницаИзмерения_Type: 'UnavailableEntities.UnavailableEntity_8e3bc82d-8e1f-4c4b-80be-7cfff345e705' }),
      ]));
      if (!parsed.ok) throw new Error(parsed.code);
      expect(parsed.header).toMatchObject({ docKind: 'sales_shipment', operationKind: 'ПродажаПокупателю', docAtLocal: '2026-06-02T14:36:52',
        warehouseRefKey: WH, destinationWarehouseRefKey: null });
      expect(parsed.lines.map((l) => [l.warehouseRefKey, l.isStockItem, l.unitIsPackage])).toEqual([[WH2, true, false], [WH, false, false], [WH, true, true]]);
      const back = parseDocument(DOCUMENT_ENTITIES.doc_sales_shipments, shipment([sline()], { ВидОперации: 'ВозвратПоставщику' }));
      expect(back.ok && back.header.docKind).toBe('supplier_return');
      expect(parseDocument(DOCUMENT_ENTITIES.doc_sales_shipments, shipment([sline()], { ВидОперации: 'ПередачаНаКомиссию' })))
        .toEqual({ ok: false, code: 'UNKNOWN_OPERATION_KIND' });
      expect(entityDocKinds(DOCUMENT_ENTITIES.doc_sales_shipments)).toEqual(['sales_shipment', 'supplier_return']);
    });

    it('write-offs and transfers have no currency; a transfer keeps source (lines) and destination (header)', () => {
      const writeoff = parseDocument(DOCUMENT_ENTITIES.doc_inventory_writeoffs, {
        Ref_Key: REF, Number: 'С-1', Date: '2026-03-09T12:00:00', Posted: true, DeletionMark: false, СтруктурнаяЕдиница_Key: WH,
        Запасы: [{ LineNumber: 1, Номенклатура_Key: ITEM, Количество: 2, ЕдиницаИзмерения: UNIT }],
      });
      if (!writeoff.ok) throw new Error(writeoff.code);
      const target = buildTarget(writeoff, refs({ currencies: new Map() }), false);
      expect(target.ok && target.header).toMatchObject({ docKind: 'inventory_writeoff', currency: null, warehouseRefKey: WH });
      expect(target.ok && target.lines[0]).toMatchObject({ warehouseRefKey: WH, amount: null, price: null, isStockItem: true });
      const transfer = parseDocument(DOCUMENT_ENTITIES.doc_inventory_transfers, {
        Ref_Key: REF, Number: 'П-1', Date: '2026-03-11T14:03:28', Posted: true, DeletionMark: false, ВидОперации: 'Перемещение',
        СтруктурнаяЕдиница_Key: WH, СтруктурнаяЕдиницаПолучатель_Key: WH2, Запасы: [{ LineNumber: 1, Номенклатура_Key: ITEM, Количество: 5 }],
      });
      expect(transfer.ok && transfer.header).toMatchObject({ docKind: 'inventory_transfer', warehouseRefKey: WH, destinationWarehouseRefKey: WH2 });
      expect(transfer.ok && transfer.lines[0].warehouseRefKey).toBe(WH);
      // У расходной накладной валюта обязательна.
      const shipped = parseDocument(DOCUMENT_ENTITIES.doc_sales_shipments, shipment([sline()]));
      if (!shipped.ok) throw new Error('parse');
      expect(buildTarget(shipped, refs({ currencies: new Map() }), false)).toEqual({ ok: false, code: 'UNKNOWN_CURRENCY' });
    });

    it('fingerprint changes with kind, moment, time zone, warehouses and line flags', () => {
      const fp = (data: Record<string, unknown>, overrides: Partial<ReferenceData> = {}) => {
        const parsed = parseDocument(DOCUMENT_ENTITIES.doc_sales_shipments, data);
        if (!parsed.ok) throw new Error(parsed.code);
        const target = buildTarget(parsed, refs(overrides), false);
        return target.ok ? target.fingerprint : null;
      };
      const base = fp(shipment([sline()]));
      const variants = [
        fp(shipment([sline()], { ВидОперации: 'ВозвратПоставщику' })),
        fp(shipment([sline()], { Date: '2026-06-02T14:36:53' })),
        fp(shipment([sline()]), { timeZone: 'Asia/Qostanay' }),
        fp(shipment([sline()], { СтруктурнаяЕдиница_Key: WH2 })),
        fp(shipment([sline({ СтруктурнаяЕдиница_Key: WH2 })])),
        fp(shipment([sline({ ТипНоменклатурыЗапас: false })])),
        fp(shipment([sline({ ЕдиницаИзмерения_Type: 'UnavailableEntities.X' })])),
      ];
      expect(new Set([base, ...variants]).size).toBe(variants.length + 1);
      expect(fp(shipment([sline()]))).toBe(base);
    });

    it('effective kinds: procurement kinds need procurement, consumption kinds do not; unknown names are rejected', () => {
      const all = 'purchase_receipt,cash_outflow,bank_outflow,sales_shipment,supplier_return,inventory_writeoff,inventory_transfer';
      expect([...effectiveDocKinds('purchase_receipt,cash_outflow,bank_outflow', true)]).toEqual(['purchase_receipt', 'cash_outflow', 'bank_outflow']);
      expect([...effectiveDocKinds('purchase_receipt,cash_outflow,bank_outflow', false)]).toEqual([]);
      expect([...effectiveDocKinds(all, false)]).toEqual(['sales_shipment', 'supplier_return', 'inventory_writeoff', 'inventory_transfer']);
      expect(effectiveDocKinds(all, true).size).toBe(7);
      expect(() => effectiveDocKinds('purchase_receipt, shipments', true)).toThrow('shipments');
    });
  });
});
