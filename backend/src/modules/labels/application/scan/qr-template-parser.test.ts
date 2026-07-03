import { describe, expect, it } from 'vitest';
import { compileQrTemplate, parseQrPayload, parseQrPayloadRight } from './qr-template-parser';

const TPL = '{order.order_name}|{bazis.col_005}|{bazis.position_in_product}';

describe('compileQrTemplate', () => {
  it('compiles pipe-separated template', () => {
    const c = compileQrTemplate(TPL);
    expect(c).not.toBeNull();
    expect(c!.fieldIds).toEqual(['order.order_name', 'bazis.col_005', 'bazis.position_in_product']);
    expect(c!.prefix).toBe('');
    expect(c!.separators).toEqual(['|', '|']);
    expect(c!.suffix).toBe('');
  });
  it('keeps literal prefix/suffix', () => {
    const c = compileQrTemplate('ERP:{detail.detail_id};v1');
    expect(c!.prefix).toBe('ERP:');
    expect(c!.suffix).toBe(';v1');
    expect(c!.fieldIds).toEqual(['detail.detail_id']);
  });
  it('rejects adjacent placeholders, empty and field-less templates', () => {
    expect(compileQrTemplate('{a}{b}')).toBeNull();
    expect(compileQrTemplate('')).toBeNull();
    expect(compileQrTemplate('   ')).toBeNull();
    expect(compileQrTemplate('no fields here')).toBeNull();
  });
});

describe('parseQrPayload', () => {
  const c = compileQrTemplate(TPL)!;
  it('parses the sample label payload', () => {
    expect(parseQrPayload('импорт 68|60084|1', c)).toEqual({
      'order.order_name': 'импорт 68',
      'bazis.col_005': '60084',
      'bazis.position_in_product': '1',
    });
  });
  it('trims values and drops empty ones', () => {
    expect(parseQrPayload(' импорт 68 || 1 ', c)).toEqual({
      'order.order_name': 'импорт 68',
      'bazis.position_in_product': '1',
    });
  });
  it('returns null when separator count mismatches', () => {
    expect(parseQrPayload('только-имя', c)).toBeNull();
  });
  it('returns null when prefix/suffix mismatch', () => {
    const p = compileQrTemplate('ERP:{detail.detail_id}')!;
    expect(parseQrPayload('XXX:123', p)).toBeNull();
    expect(parseQrPayload('ERP:123', p)).toEqual({ 'detail.detail_id': '123' });
  });
});

describe('parseQrPayloadRight', () => {
  const c = compileQrTemplate(TPL)!;
  it('recovers order name containing the separator (right-anchored split)', () => {
    // Имя заказа «A|B»: лево-якорный парс режет неверно, право-якорный — верно.
    expect(parseQrPayload('A|B|60084|1', c)).toEqual({
      'order.order_name': 'A',
      'bazis.col_005': 'B',
      'bazis.position_in_product': '60084|1',
    });
    expect(parseQrPayloadRight('A|B|60084|1', c)).toEqual({
      'order.order_name': 'A|B',
      'bazis.col_005': '60084',
      'bazis.position_in_product': '1',
    });
  });
  it('matches left parse on clean payloads', () => {
    expect(parseQrPayloadRight('импорт 68|60084|1', c)).toEqual(parseQrPayload('импорт 68|60084|1', c));
  });
  it('returns null when separators missing', () => {
    expect(parseQrPayloadRight('без-разделителей', c)).toBeNull();
  });
});
