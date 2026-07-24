import { normalizeReferenceName, resolveImportRow } from '../hooks/useImportValidation';
import type {
  ImportRow,
  SheetMaterialReferenceItem,
} from '../types/importTypes';
import type { PdfGenericTable } from './pdfGenericTable';

export type PdfSectionMaterialOverrides = Record<string, number>;

export interface PdfSectionMaterialSummary {
  sourceName: string;
  pageNumbers: number[];
  rowCount: number;
}

export const pdfSectionMaterialKey = (sourceName: string): string =>
  normalizeReferenceName(sourceName);

export function collectPdfSectionMaterials(
  tables: PdfGenericTable[],
): PdfSectionMaterialSummary[] {
  const materials = new Map<string, PdfSectionMaterialSummary>();
  tables.forEach(table => {
    const sourceName = table.sectionMaterialName?.trim();
    if (!sourceName) return;
    const key = pdfSectionMaterialKey(sourceName);
    const current = materials.get(key);
    if (current) {
      if (!current.pageNumbers.includes(table.pageNumber)) {
        current.pageNumbers.push(table.pageNumber);
      }
      current.rowCount += table.rows.length;
      return;
    }
    materials.set(key, {
      sourceName,
      pageNumbers: [table.pageNumber],
      rowCount: table.rows.length,
    });
  });
  return Array.from(materials.values());
}

export function resolvePdfSectionMaterialId(
  sourceName: string,
  overrides: PdfSectionMaterialOverrides,
  sheetMaterialTypes: SheetMaterialReferenceItem[],
): number | null {
  const overrideId = overrides[pdfSectionMaterialKey(sourceName)];
  if (overrideId && sheetMaterialTypes.some(item =>
    item.id === overrideId && item.isCuttable !== false)) {
    return overrideId;
  }
  return resolveImportRow(
    { materialName: sourceName },
    { sheetMaterialTypes },
  ).sheet_material_type_id;
}

export function applyPdfSectionMaterialOverrides(
  rows: ImportRow[],
  overrides: PdfSectionMaterialOverrides,
  sheetMaterialTypes: SheetMaterialReferenceItem[],
): ImportRow[] {
  return rows.map(row => {
    const sourceName = row.materialName?.trim();
    if (!sourceName) return row;
    const overrideId = overrides[pdfSectionMaterialKey(sourceName)];
    if (!overrideId) return row;
    const target = sheetMaterialTypes.find(item =>
      item.id === overrideId && item.isCuttable !== false);
    if (!target || target.name === row.materialName) return row;
    return { ...row, materialName: target.name };
  });
}
