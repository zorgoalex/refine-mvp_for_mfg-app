export const PDF_LAYOUT_FINGERPRINT_VERSION = 1 as const;
export const PDF_LAYOUT_PARSER_MAJOR = 1 as const;

export type PdfLayoutTarget =
  | 'position'
  | 'designation'
  | 'basis_project'
  | 'basis_product'
  | 'name'
  | 'quantity'
  | 'length'
  | 'width'
  | 'compound_size'
  | 'material'
  | 'film'
  | 'milling'
  | 'note'
  | 'ignore';

export interface PdfLayoutSignatureColumn {
  header: string;
  relativeStart: number;
  relativeEnd: number;
  children?: string[];
}

export interface PdfLayoutSignature {
  fingerprintVersion: typeof PDF_LAYOUT_FINGERPRINT_VERSION;
  parserMajor: typeof PDF_LAYOUT_PARSER_MAJOR;
  headerBandCount: number;
  columns: PdfLayoutSignatureColumn[];
}

export interface PdfLayoutMapping {
  schemaVersion: 1;
  columns: Array<{ columnIndex: number; target: PdfLayoutTarget }>;
  geometryCandidateRole?: 'header' | 'data';
}

export function normalizePdfHeader(value: string): string {
  return value
    .normalize('NFKC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

export function canonicalizePdfLayoutSignature(signature: PdfLayoutSignature): PdfLayoutSignature {
  return {
    fingerprintVersion: PDF_LAYOUT_FINGERPRINT_VERSION,
    parserMajor: PDF_LAYOUT_PARSER_MAJOR,
    headerBandCount: Math.max(1, Math.trunc(signature.headerBandCount)),
    columns: signature.columns.map(column => ({
      header: normalizePdfHeader(column.header),
      relativeStart: quantizeRatio(column.relativeStart),
      relativeEnd: quantizeRatio(column.relativeEnd),
      ...(column.children?.length
        ? { children: column.children.map(normalizePdfHeader) }
        : {}),
    })),
  };
}

export function serializePdfLayoutSignature(signature: PdfLayoutSignature): string {
  return JSON.stringify(canonicalizePdfLayoutSignature(signature));
}

export async function fingerprintPdfLayoutSignature(signature: PdfLayoutSignature): Promise<string> {
  const bytes = new TextEncoder().encode(serializePdfLayoutSignature(signature));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map(byte => byte.toString(16).padStart(2, '0')).join('');
}

export function validatePdfLayoutMapping(mapping: PdfLayoutMapping, columnCount?: number): string[] {
  const issues: string[] = [];
  const targets = mapping.columns.map(column => column.target);
  const indexes = mapping.columns.map(column => column.columnIndex);
  const duplicateTargets = targets.filter(
    (target, index) => target !== 'ignore' && targets.indexOf(target) !== index,
  );
  if (duplicateTargets.length) issues.push(`Повторяются поля: ${[...new Set(duplicateTargets)].join(', ')}`);
  if (!targets.includes('name')) issues.push('Не сопоставлено поле «Наименование»');
  if (!targets.includes('quantity')) issues.push('Не сопоставлено поле «Количество»');
  const hasDimensions = targets.includes('compound_size')
    || (targets.includes('length') && targets.includes('width'));
  if (!hasDimensions) issues.push('Не сопоставлены размеры');
  if (columnCount !== undefined) {
    const sortedIndexes = [...indexes].sort((a, b) => a - b);
    if (indexes.length !== columnCount
      || new Set(indexes).size !== indexes.length
      || !sortedIndexes.every((value, index) => value === index)) {
      issues.push('Сопоставление не покрывает все колонки layout');
    }
  }
  return issues;
}

function quantizeRatio(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.round(Math.min(1, Math.max(0, value)) * 1000) / 1000;
}
