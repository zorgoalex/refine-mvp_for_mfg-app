export type OcrFieldCode =
  | 'order_number'
  | 'order_name'
  | 'detail_number'
  | 'dimensions'
  | 'material'
  | 'quantity'
  | 'date'
  | 'detail_name'
  | 'ignore';

export const OCR_FIELD_STRENGTH: Record<OcrFieldCode, 'strong' | 'weak' | 'zero'> = {
  order_number: 'strong',
  detail_number: 'strong',
  dimensions: 'strong',
  material: 'strong',
  quantity: 'strong',
  date: 'strong',
  order_name: 'weak',
  detail_name: 'weak',
  ignore: 'zero',
};

export const DISCRIMINANT_FIELDS: ReadonlySet<OcrFieldCode> = new Set(['dimensions', 'material']);

export function isStrongField(f: OcrFieldCode): boolean {
  return OCR_FIELD_STRENGTH[f] === 'strong';
}

export const OCR_FIELD_CODES: OcrFieldCode[] = [...Object.keys(OCR_FIELD_STRENGTH)] as OcrFieldCode[];
