// Строки каталога номенклатуры 1С (формат «Пленка_ПВХ_1С.xlsx» и зеркало ETL 1С).
// Общий код frontend (разбор файла в браузере) и backend (повторная проверка и
// вычисление производных полей — клиентским значениям backend не доверяет).

export const CATALOG_MAX_ROWS = 5000;
export const CATALOG_TARGET_NAME_MAX = 200;
export const CATALOG_FIELD_MAX = 500;

export type CatalogColumn =
  | 'nameOriginal'
  | 'nameFull'
  | 'supplier'
  | 'nomenclatureType'
  | 'unit'
  | 'nomenclatureCategory';

/** Заголовки файла → колонки. Сравнение без регистра, пробелов и «ё». */
const HEADER_ALIASES: Record<CatalogColumn, readonly string[]> = {
  nameOriginal: ['наименованиематериалаоригинал'],
  nameFull: ['наименованиематериалаипоставщик'],
  supplier: ['поставщик'],
  nomenclatureType: ['типноменклатуры'],
  unit: ['единицаизмерения'],
  nomenclatureCategory: ['категорияноменклатуры'],
};

const REQUIRED_COLUMNS: readonly CatalogColumn[] = ['nameOriginal', 'nameFull', 'supplier'];

export interface CatalogRowInput {
  rowNo: number;
  nameOriginal: string;
  nameFull: string;
  supplier: string;
  nomenclatureType: string | null;
  unit: string | null;
  nomenclatureCategory: string | null;
}

export type CatalogRowStatus = 'ok' | 'invalid';

export interface CatalogRow extends CatalogRowInput {
  targetName: string;
  catalogKey: string;
  rowStatus: CatalogRowStatus;
  issue: string | null;
}

export function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

export function normalizeHeader(value: unknown): string {
  return String(value ?? '').toLowerCase().replace(/ё/g, 'е').replace(/[\s_.\-]+/g, '');
}

/** Ключ строки каталога — нормализованное «Наименование материала и Поставщик» (как `Description` в 1С). */
export function catalogKeyOf(nameFull: string): string {
  return collapseWhitespace(nameFull).toLowerCase();
}

/** Название справочника в формате пользователя: «Наименование материала; Поставщик». */
export function buildTargetName(nameOriginal: string, supplier: string): string {
  return `${collapseWhitespace(nameOriginal)}; ${collapseWhitespace(supplier)}`;
}

/**
 * Разбор `Description` номенклатуры 1С: наименование — до последнего `;`,
 * поставщик — после него без служебного завершающего слова «Текстурная».
 * Нет `;` или пустая часть → `null`.
 */
export function parseCatalogDescription(description: string): { nameOriginal: string; supplier: string } | null {
  const index = description.lastIndexOf(';');
  if (index < 0) return null;
  const nameOriginal = collapseWhitespace(description.slice(0, index));
  const supplier = collapseWhitespace(description.slice(index + 1)).replace(/\s*текстурная$/i, '').trim();
  if (!nameOriginal || !supplier) return null;
  return { nameOriginal, supplier };
}

export interface CatalogHeaderMatch {
  headerRowIndex: number;
  columns: Partial<Record<CatalogColumn, number>>;
}

/** Поиск строки заголовка в первых 20 строках листа. `null` — лист не является каталогом. */
export function detectCatalogHeader(rows: ReadonlyArray<ReadonlyArray<unknown>>): CatalogHeaderMatch | null {
  const limit = Math.min(rows.length, 20);
  for (let rowIndex = 0; rowIndex < limit; rowIndex += 1) {
    const columns: Partial<Record<CatalogColumn, number>> = {};
    (rows[rowIndex] ?? []).forEach((cell, columnIndex) => {
      const header = normalizeHeader(cell);
      for (const [column, aliases] of Object.entries(HEADER_ALIASES) as Array<[CatalogColumn, readonly string[]]>) {
        if (columns[column] === undefined && aliases.includes(header)) columns[column] = columnIndex;
      }
    });
    if (REQUIRED_COLUMNS.every((column) => columns[column] !== undefined)) {
      return { headerRowIndex: rowIndex, columns };
    }
  }
  return null;
}

function cellText(value: unknown): string {
  if (value === null || value === undefined) return '';
  return collapseWhitespace(String(value));
}

function optionalText(value: unknown): string | null {
  const text = cellText(value);
  return text ? text : null;
}

/** Строки листа (двумерный массив значений ячеек) → входные строки каталога. Пустые строки пропускаются. */
export function extractCatalogRows(rows: ReadonlyArray<ReadonlyArray<unknown>>, header: CatalogHeaderMatch): CatalogRowInput[] {
  const result: CatalogRowInput[] = [];
  const at = (row: ReadonlyArray<unknown>, column: CatalogColumn) => {
    const index = header.columns[column];
    return index === undefined ? null : row[index];
  };
  for (let index = header.headerRowIndex + 1; index < rows.length; index += 1) {
    const row = rows[index] ?? [];
    const nameOriginal = cellText(at(row, 'nameOriginal'));
    const nameFull = cellText(at(row, 'nameFull'));
    const supplier = cellText(at(row, 'supplier'));
    if (!nameOriginal && !nameFull && !supplier) continue;
    result.push({
      rowNo: index + 1,
      nameOriginal,
      nameFull,
      supplier,
      nomenclatureType: optionalText(at(row, 'nomenclatureType')),
      unit: optionalText(at(row, 'unit')),
      nomenclatureCategory: optionalText(at(row, 'nomenclatureCategory')),
    });
  }
  return result;
}

/**
 * Проверка и вычисление производных полей. Ошибочные строки сохраняются со
 * статусом `invalid` и причиной; повтор ключа — `invalid` у второй и следующих.
 */
export function validateCatalogRows(inputs: ReadonlyArray<CatalogRowInput>): CatalogRow[] {
  const seen = new Set<string>();
  return inputs.map((input) => {
    const nameOriginal = collapseWhitespace(input.nameOriginal ?? '');
    const nameFull = collapseWhitespace(input.nameFull ?? '');
    const supplier = collapseWhitespace(input.supplier ?? '');
    const targetName = nameOriginal && supplier ? buildTargetName(nameOriginal, supplier) : '';
    const catalogKey = nameFull ? catalogKeyOf(nameFull) : '';
    let issue: string | null = null;
    if (!nameOriginal) issue = 'Пустое наименование материала';
    else if (!supplier) issue = 'Не указан поставщик';
    else if (!nameFull) issue = 'Пустое «Наименование материала и Поставщик»';
    else if (targetName.length > CATALOG_TARGET_NAME_MAX) issue = `Название длиннее ${CATALOG_TARGET_NAME_MAX} символов`;
    else if ([nameOriginal, nameFull, supplier, input.nomenclatureType ?? '', input.unit ?? '', input.nomenclatureCategory ?? '']
      .some((value) => value.length > CATALOG_FIELD_MAX)) issue = `Поле длиннее ${CATALOG_FIELD_MAX} символов`;
    else if (seen.has(catalogKey)) issue = 'Повтор строки каталога';
    if (!issue) seen.add(catalogKey);
    return {
      rowNo: input.rowNo,
      nameOriginal,
      nameFull,
      supplier,
      nomenclatureType: input.nomenclatureType ? collapseWhitespace(input.nomenclatureType) : null,
      unit: input.unit ? collapseWhitespace(input.unit) : null,
      nomenclatureCategory: input.nomenclatureCategory ? collapseWhitespace(input.nomenclatureCategory) : null,
      targetName,
      catalogKey,
      rowStatus: issue ? 'invalid' : 'ok',
      issue,
    };
  });
}

/** Нормализация единицы измерения для сравнения («пог. м», «пог.м», «ПОГ М» → «пог м»). */
export function normalizeUnit(unit: string | null): string {
  return (unit ?? '').toLowerCase().replace(/[.\s]+/g, ' ').trim();
}
