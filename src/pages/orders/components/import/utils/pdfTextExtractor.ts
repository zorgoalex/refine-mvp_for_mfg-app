// PDF Text Extraction and Parsing Utilities

import type {
  PdfTextItem,
  PdfTextLine,
  PdfOrderMetadata,
  PdfDetailRaw,
  PdfParsedResult,
} from '../types/pdfTypes';

import {
  LINE_Y_TOLERANCE,
  HEADER_FOOTER_PATTERNS,
  DESIGNATION_PATTERN,
  ORDER_HEADER_PATTERN,
  MATERIAL_PATTERN,
  TOTAL_COUNT_PATTERN,
  MAX_PART_LONG_SIDE_MM,
  MAX_PART_SHORT_SIDE_MM,
} from '../types/pdfTypes';

// ============================================================================
// TEXT GROUPING BY LINES
// ============================================================================

/**
 * Groups text items by Y coordinate (with tolerance) to form lines
 */
export function groupTextItemsIntoLines(items: PdfTextItem[]): PdfTextLine[] {
  if (items.length === 0) return [];

  // Sort by Y descending (PDF coordinates: Y=0 at bottom)
  const sorted = [...items].sort((a, b) => b.y - a.y);

  const lines: PdfTextLine[] = [];
  let currentLine: PdfTextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];

    // Check if item belongs to current line (within Y tolerance)
    if (Math.abs(item.y - currentY) <= LINE_Y_TOLERANCE) {
      currentLine.push(item);
    } else {
      // Finalize current line and start new one
      lines.push(finalizeLine(currentLine, currentY));
      currentLine = [item];
      currentY = item.y;
    }
  }

  // Don't forget the last line
  if (currentLine.length > 0) {
    lines.push(finalizeLine(currentLine, currentY));
  }

  return lines;
}

/**
 * Finalizes a line by sorting items by X and concatenating text
 */
function finalizeLine(items: PdfTextItem[], y: number): PdfTextLine {
  // Sort by X ascending (left to right)
  const sorted = [...items].sort((a, b) => a.x - b.x);

  // Concatenate text with space detection
  let text = '';
  for (let i = 0; i < sorted.length; i++) {
    const item = sorted[i];
    if (i > 0) {
      // Add space if there's a gap between items
      const prevItem = sorted[i - 1];
      const gap = item.x - (prevItem.x + prevItem.width);
      if (gap > 2) {
        text += ' ';
      }
    }
    text += item.text;
  }

  return {
    y,
    items: sorted,
    text: text.trim(),
  };
}

// ============================================================================
// HEADER/FOOTER FILTERING
// ============================================================================

/**
 * Checks if a line is a header or footer (should be skipped)
 */
export function isHeaderOrFooter(line: PdfTextLine): boolean {
  const text = line.text;
  return HEADER_FOOTER_PATTERNS.some(pattern => pattern.test(text));
}

// ============================================================================
// METADATA EXTRACTION
// ============================================================================

/**
 * Extracts order metadata from all lines
 */
export function extractMetadata(allLines: PdfTextLine[]): PdfOrderMetadata {
  const metadata: PdfOrderMetadata = {
    orderNumber: '',
    orderName: '',
    material: '',
  };
  const totalCounts: number[] = [];
  const materialNames: string[] = [];

  for (const line of allLines) {
    const text = line.text;

    // Extract order number and name: "Заказ: № 1057 / Кухня"
    if (text.includes('Заказ:') || text.includes('№')) {
      const match = text.match(ORDER_HEADER_PATTERN);
      if (match) {
        metadata.orderNumber = match[1];
        metadata.orderName = match[2].trim();
      }
    }

    // Extract material: "Материал: МДФ 16 мм"
    const materialMatch = text.match(MATERIAL_PATTERN);
    if (materialMatch) {
      const material = normalizeWhitespace(materialMatch[1]);
      if (material && !materialNames.includes(material)) {
        materialNames.push(material);
      }
      metadata.material = materialNames.join(', ');
    }

    // Extract total count: "Общ. кол. 44"
    const totalMatch = text.match(TOTAL_COUNT_PATTERN);
    if (totalMatch) {
      totalCounts.push(parseInt(totalMatch[1], 10));
    }

    // Extract company
    if (text.includes('Компания:')) {
      const parts = text.split('Компания:');
      if (parts[1]) {
        metadata.company = parts[1].trim();
      }
    }

    // Extract print date
    if (text.includes('Дата печати:')) {
      const dateMatch = text.match(/(\d{2}\.\d{2}\.\d{4})/);
      if (dateMatch) {
        metadata.printDate = dateMatch[1];
      }
    }
  }

  if (totalCounts.length > 0) {
    metadata.totalCount = totalCounts.reduce((sum, count) => sum + count, 0);
  }

  return metadata;
}

// ============================================================================
// DETAIL BLOCK PARSING (MULTI-LINE APPROACH)
// ============================================================================

interface DetailBlock {
  lines: PdfTextLine[];
}

type PdfTableColumnKey =
  | 'position'
  | 'designation'
  | 'name'
  | 'quantity'
  | 'length'
  | 'width'
  | 'milling'
  | 'film'
  | 'note';

type PdfTableRowCells = Record<PdfTableColumnKey, string>;

type PdfTableColumn = {
  key: PdfTableColumnKey;
  minX: number;
  maxX: number;
};

type RowAnchor = {
  item: PdfTextItem;
  value: number;
};

// Basis specification PDFs use a stable landscape table layout. The values are
// deliberately ranges, not exact coordinates, so minor font/renderer shifts are tolerated.
const BASIS_TABLE_COLUMNS: PdfTableColumn[] = [
  { key: 'position', minX: 42, maxX: 72 },
  { key: 'designation', minX: 72, maxX: 150 },
  { key: 'name', minX: 150, maxX: 240 },
  { key: 'quantity', minX: 240, maxX: 285 },
  { key: 'length', minX: 285, maxX: 322 },
  { key: 'width', minX: 322, maxX: 385 },
  { key: 'milling', minX: 385, maxX: 515 },
  { key: 'film', minX: 515, maxX: 710 },
  { key: 'note', minX: 710, maxX: Number.POSITIVE_INFINITY },
];

const TABLE_CELL_LINE_Y_TOLERANCE = 3;
const TABLE_FOOTER_MIN_Y = 65;

function normalizeWhitespace(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function isTableHeaderLine(line: PdfTextLine): boolean {
  return (
    line.text.includes('№') &&
    line.text.includes('Обозн.') &&
    line.text.includes('Наименование') &&
    line.text.includes('Кол-во') &&
    line.text.includes('Размер')
  );
}

function getMaterialFromLine(line: PdfTextLine): string | null {
  const materialMatch = line.text.match(MATERIAL_PATTERN);
  if (!materialMatch) return null;
  return normalizeWhitespace(materialMatch[1]) || null;
}

function findMaterialForTable(lines: PdfTextLine[], headerLine: PdfTextLine): string | undefined {
  const materialLine = lines
    .filter(line => line.y > headerLine.y && getMaterialFromLine(line))
    .sort((a, b) => a.y - b.y)[0];

  return materialLine ? getMaterialFromLine(materialLine) || undefined : undefined;
}

function midpoint(a: number, b: number): number {
  return (a + b) / 2;
}

function findHeaderX(line: PdfTextLine, pattern: RegExp): number | null {
  const item = line.items.find(headerItem => pattern.test(headerItem.text));
  return item ? item.x : null;
}

function getTableColumns(headerLine: PdfTextLine): PdfTableColumn[] {
  const positionX = findHeaderX(headerLine, /^№$/);
  const designationX = findHeaderX(headerLine, /^Обозн\./);
  const nameX = findHeaderX(headerLine, /^Наименование/);
  const quantityX = findHeaderX(headerLine, /^Кол-во/);
  const sizeX = findHeaderX(headerLine, /^Размер/);
  const millingX = findHeaderX(headerLine, /^Фрезировка/);
  const filmX = findHeaderX(headerLine, /^Пленка/);
  const noteX = findHeaderX(headerLine, /^Примечание/);

  if (
    positionX === null ||
    designationX === null ||
    nameX === null ||
    quantityX === null ||
    sizeX === null ||
    millingX === null ||
    filmX === null ||
    noteX === null
  ) {
    return BASIS_TABLE_COLUMNS;
  }

  const sizeWidthSplit = sizeX + Math.max(25, (millingX - sizeX) * 0.28);
  const sizeEnd = midpoint(sizeX, millingX);

  return [
    { key: 'position', minX: Math.max(0, positionX - 12), maxX: midpoint(positionX, designationX) },
    { key: 'designation', minX: midpoint(positionX, designationX), maxX: midpoint(designationX, nameX) },
    { key: 'name', minX: midpoint(designationX, nameX), maxX: midpoint(nameX, quantityX) },
    { key: 'quantity', minX: midpoint(nameX, quantityX), maxX: midpoint(quantityX, sizeX) },
    { key: 'length', minX: midpoint(quantityX, sizeX), maxX: sizeWidthSplit },
    { key: 'width', minX: sizeWidthSplit, maxX: sizeEnd },
    { key: 'milling', minX: sizeEnd, maxX: midpoint(millingX, filmX) },
    { key: 'film', minX: midpoint(millingX, filmX), maxX: midpoint(filmX, noteX) },
    { key: 'note', minX: midpoint(filmX, noteX), maxX: Number.POSITIVE_INFINITY },
  ];
}

function getColumnForItem(item: PdfTextItem, columns: PdfTableColumn[]): PdfTableColumn | null {
  return columns.find(column => item.x >= column.minX && item.x < column.maxX) || null;
}

function getEmptyTableCells(): PdfTableRowCells {
  return {
    position: '',
    designation: '',
    name: '',
    quantity: '',
    length: '',
    width: '',
    milling: '',
    film: '',
    note: '',
  };
}

function normalizeTableCell(items: PdfTextItem[]): string {
  if (items.length === 0) return '';

  const sorted = [...items].sort((a, b) => b.y - a.y || a.x - b.x);
  const lines: PdfTextItem[][] = [];

  for (const item of sorted) {
    const line = lines.find(existing => Math.abs(existing[0].y - item.y) <= TABLE_CELL_LINE_Y_TOLERANCE);
    if (line) {
      line.push(item);
    } else {
      lines.push([item]);
    }
  }

  return normalizeWhitespace(
    lines
      .map(line =>
        [...line]
          .sort((a, b) => a.x - b.x)
          .map(item => item.text)
          .join(' ')
      )
      .join(' ')
  );
}

function parsePositiveIntCell(text: string): number | null {
  const normalized = normalizeWhitespace(text);
  if (!/^\d+$/.test(normalized)) return null;
  const value = parseInt(normalized, 10);
  return value > 0 ? value : null;
}

function findTableRowAnchors(
  pageItems: PdfTextItem[],
  headerY: number,
  columns: PdfTableColumn[],
  minY = TABLE_FOOTER_MIN_Y
): RowAnchor[] {
  const positionColumn = columns.find(column => column.key === 'position') || BASIS_TABLE_COLUMNS[0];

  return pageItems
    .filter(item => {
      const text = item.text.trim();
      return (
        /^\d{1,3}$/.test(text) &&
        item.x >= positionColumn.minX &&
        item.x < positionColumn.maxX &&
        item.y < headerY - 4 &&
        item.y > minY
      );
    })
    .map(item => ({ item, value: parseInt(item.text.trim(), 10) }))
    .filter(anchor => anchor.value > 0 && anchor.value < 1000)
    .sort((a, b) => b.item.y - a.item.y || a.value - b.value);
}

function estimateRowStep(anchors: RowAnchor[]): number {
  const gaps: number[] = [];
  for (let i = 0; i < anchors.length - 1; i++) {
    const gap = anchors[i].item.y - anchors[i + 1].item.y;
    if (gap > 0) gaps.push(gap);
  }
  if (gaps.length === 0) return 24;
  const sorted = [...gaps].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] || 24;
}

function extractTableRowsForHeader(
  lines: PdfTextLine[],
  pageItems: PdfTextItem[],
  headerLine: PdfTextLine,
  tableBottomY: number
): PdfDetailRaw[] {
  const columns = getTableColumns(headerLine);
  const sectionItems = pageItems.filter(item => item.y < headerLine.y - 4 && item.y > tableBottomY);
  const anchors = findTableRowAnchors(sectionItems, headerLine.y, columns, tableBottomY);
  if (anchors.length === 0) return [];

  const rowStep = estimateRowStep(anchors);
  const totalLine = lines.find(line =>
    TOTAL_COUNT_PATTERN.test(line.text) &&
    line.y < headerLine.y &&
    line.y > tableBottomY
  );
  const material = findMaterialForTable(lines, headerLine);
  const details: PdfDetailRaw[] = [];

  for (let i = 0; i < anchors.length; i++) {
    const current = anchors[i];
    const previousY = i === 0 ? headerLine.y : anchors[i - 1].item.y;
    const nextY =
      i === anchors.length - 1
        ? totalLine && totalLine.y < current.item.y
          ? totalLine.y
          : current.item.y - rowStep
        : anchors[i + 1].item.y;

    const upperY = (previousY + current.item.y) / 2;
    const lowerY = (current.item.y + nextY) / 2;
    const rowItems = sectionItems.filter(item => item.y <= upperY && item.y > lowerY);
    const cells = getEmptyTableCells();

    for (const column of columns) {
      cells[column.key] = normalizeTableCell(rowItems.filter(item => getColumnForItem(item, columns)?.key === column.key));
    }

    const position = parsePositiveIntCell(cells.position);
    const quantity = parsePositiveIntCell(cells.quantity);
    const length = parsePositiveIntCell(cells.length);
    const width = parsePositiveIntCell(cells.width);
    const designation = normalizeWhitespace(cells.designation);

    if (!position || !quantity || !length || !width || !isDesignation(designation)) {
      continue;
    }

    details.push({
      position,
      designation,
      name: normalizeWhitespace(cells.name) || 'Деталь',
      quantity,
      length,
      width,
      material,
      milling: cells.milling || undefined,
      film: cells.film || undefined,
      note: cells.note || undefined,
    });
  }

  return details;
}

function extractTableRowsFromPage(lines: PdfTextLine[]): PdfDetailRaw[] {
  const headerLines = lines.filter(isTableHeaderLine).sort((a, b) => b.y - a.y);
  if (headerLines.length === 0) return [];

  const pageItems = lines.flatMap(line => line.items);
  const details: PdfDetailRaw[] = [];

  for (let i = 0; i < headerLines.length; i++) {
    const headerLine = headerLines[i];
    const nextHeaderLine = headerLines[i + 1];
    const tableBottomY = Math.max(TABLE_FOOTER_MIN_Y, nextHeaderLine?.y ?? TABLE_FOOTER_MIN_Y);
    details.push(...extractTableRowsForHeader(lines, pageItems, headerLine, tableBottomY));
  }

  return details;
}

function parseDetailsFromTableGeometry(pageLines: PdfTextLine[][]): PdfDetailRaw[] {
  return pageLines.flatMap(lines => extractTableRowsFromPage(lines));
}

/**
 * Checks if a string is a designation (11.02, 36, 01.04, etc)
 */
function isDesignation(text: string): boolean {
  return DESIGNATION_PATTERN.test(text.trim());
}

function isPlausiblePartSizePair(a: number, b: number): boolean {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (a <= 0 || b <= 0) return false;
  if (a > MAX_PART_LONG_SIDE_MM || b > MAX_PART_LONG_SIDE_MM) return false;
  // At least one side must fit the typical short side of the sheet.
  return a <= MAX_PART_SHORT_SIDE_MM || b <= MAX_PART_SHORT_SIDE_MM;
}

/**
 * Checks if a string is a position number (1, 2, 3, ...)
 */
function isPositionNumber(text: string): boolean {
  const num = parseInt(text, 10);
  return /^\d+$/.test(text) && num > 0 && num < 1000;
}

type ParsedSizeFromLine = {
  length: number;
  width: number;
  firstIndex: number;
  secondIndex: number;
  tokens: string[];
};

function parsePlausibleSizeFromLineText(text: string): ParsedSizeFromLine | null {
  const tokens = text.trim().split(/\s+/).filter(Boolean);
  if (tokens.length < 2) return null;

  for (let i = 0; i < tokens.length - 1; i++) {
    const aToken = tokens[i];
    const bToken = tokens[i + 1];
    if (!/^\d{2,4}$/.test(aToken) || !/^\d{2,4}$/.test(bToken)) continue;

    const a = parseInt(aToken, 10);
    const b = parseInt(bToken, 10);
    // Require dimensions to be realistically sized (mm)
    if (a < 50 || b < 50) continue;
    if (!isPlausiblePartSizePair(a, b)) continue;

    return { length: a, width: b, firstIndex: i, secondIndex: i + 1, tokens };
  }

  return null;
}

function extractFilmCandidateFromSizeLine(parsed: ParsedSizeFromLine): string | null {
  const after = parsed.tokens.slice(parsed.secondIndex + 1).join(' ').trim();
  return after ? after : null;
}

/**
 * Checks if a line starts a new detail block.
 * A detail line typically starts with: position number (1-9), then designation (XX.XX or 2+ digits).
 * Example: "1 11.02 Бок L 779 97 1 1"
 */
function isBlockStart(line: PdfTextLine): boolean {
  // Use concatenated line text only; item-based checks are too unstable for PDFs where sizes/film are on separate lines.
  const match = line.text.match(/^\s*(\d{1,3})\s+(\d+(?:\.\d+)*)\s+/);
  if (!match) return false;

  const position = match[1];
  const designation = match[2];

  return isPositionNumber(position) && isDesignation(designation);
}

/**
 * Groups content lines into detail blocks.
 * A block starts when we see a designation pattern and continues until the next one.
 */
export function groupIntoDetailBlocks(lines: PdfTextLine[]): DetailBlock[] {
  // Filter out headers/footers and empty lines
  const contentLines = lines.filter(line =>
    !isHeaderOrFooter(line) &&
    line.text.trim() &&
    !line.text.includes('Общ. кол.')
  );

  const blocks: DetailBlock[] = [];
  let currentBlock: PdfTextLine[] = [];
  let pendingPrefix: PdfTextLine[] = [];

  for (const line of contentLines) {
    // Many PDFs put sizes and/or film on a separate line BEFORE the actual detail line.
    // Treat any non-detail line that contains a plausible size pair as a prefix for the next detail.
    const hasPlausibleSizes = !isBlockStart(line) && !!parsePlausibleSizeFromLineText(line.text);
    if (hasPlausibleSizes) {
      if (currentBlock.length > 0) {
        blocks.push({ lines: currentBlock });
        currentBlock = [];
      }
      pendingPrefix.push(line);
      continue;
    }

    if (isBlockStart(line)) {
      // Save previous block if not empty
      if (currentBlock.length > 0) {
        blocks.push({ lines: currentBlock });
      }
      // Start new block
      currentBlock = [...pendingPrefix, line];
      pendingPrefix = [];
    } else if (currentBlock.length > 0) {
      // Continue current block
      currentBlock.push(line);
    } else {
      // Keep lines before the first block; if they contain sizes/film they will be used as prefix.
      pendingPrefix.push(line);
    }
  }

  // Don't forget the last block
  if (currentBlock.length > 0) {
    blocks.push({ lines: currentBlock });
  }

  return blocks;
}

/**
 * Parses a detail block (potentially multi-line) into a structured detail object
 */
export function parseDetailBlock(block: DetailBlock, blockIndex: number): PdfDetailRaw | null {
  const { lines } = block;
  if (lines.length === 0) return null;

  const mainLine = lines.find(isBlockStart);
  if (!mainLine) return null;

  const mainMatch = mainLine.text.match(/^\s*(\d{1,3})\s+(\d+(?:\.\d+)*)\s+(.+)$/);
  if (!mainMatch) return null;

  const position = parseInt(mainMatch[1], 10);
  const designation = mainMatch[2];
  const remainder = mainMatch[3].trim();

  if (!isPositionNumber(String(position)) || !isDesignation(designation)) return null;

  // Extract sizes from any prefix/auxiliary line in the block.
  let length = 0;
  let width = 0;
  for (const line of lines) {
    const parsed = parsePlausibleSizeFromLineText(line.text);
    if (!parsed) continue;
    length = parsed.length;
    width = parsed.width;
    break;
  }
  if (length === 0 || width === 0) return null;

  // Parse name + quantity from the main detail line.
  const remainderTokens = remainder.split(/\s+/).filter(Boolean);
  let quantity = 1;
  let quantityIndex = -1;
  for (let i = 0; i < remainderTokens.length; i++) {
    const token = remainderTokens[i];
    if (!/^\d{1,2}$/.test(token)) continue;
    const value = parseInt(token, 10);
    if (value >= 1 && value <= 100) {
      quantity = value;
      quantityIndex = i;
      break;
    }
  }
  if (quantityIndex === -1) return null;

  const name = remainderTokens.slice(0, quantityIndex).join(' ').trim();
  const tailTokens = remainderTokens.slice(quantityIndex + 1);
  const tailText = tailTokens.join(' ').trim();

  let milling: string | undefined;
  let film: string | undefined;
  let note: string | undefined;

  const filmParts: string[] = [];

  const tailLower = tailText.toLowerCase();
  if (tailLower.includes('модерн')) milling = 'Модерн';
  else if (tailLower.includes('средняя') && tailLower.includes('лапша')) milling = 'Средняя лапша';
  else if (tailLower.includes('лапша')) milling = 'Лапша';

  if (tailLower.includes('присадка')) note = 'Присадка:';

  // Prefer extracting film/material from lines that contain sizes (they often have trailing material text).
  for (const line of lines) {
    const parsed = parsePlausibleSizeFromLineText(line.text);
    if (!parsed) continue;
    const candidate = extractFilmCandidateFromSizeLine(parsed);
    if (candidate) {
      filmParts.push(candidate);
      break;
    }
  }

  // Also include remaining tail tokens that are not milling/note markers.
  for (const token of tailTokens) {
    const lower = token.toLowerCase();
    if (!token || token === ':' || token === '.') continue;
    if (/^\d+$/.test(token)) continue;
    if (lower.includes('присадка')) continue;
    if (lower.includes('модерн') || lower.includes('лапша') || lower.includes('средняя')) continue;
    filmParts.push(token);
  }

  // Build film string
  if (filmParts.length > 0) {
    film = filmParts.join(' ').trim();
  }

  return {
    designation,
    name: name || 'Деталь',
    position: position || blockIndex + 1,
    quantity,
    length,
    width,
    milling,
    film: film || undefined,
    note: note || undefined,
  };
}

// ============================================================================
// MAIN PARSING FUNCTION
// ============================================================================

/**
 * Main function to parse extracted PDF text into structured data
 */
export function parsePdfContent(allPageItems: PdfTextItem[][]): PdfParsedResult {
  const parseErrors: string[] = [];

  // Group items into lines for all pages
  const pageLines = allPageItems.map(pageItems => groupTextItemsIntoLines(pageItems));
  const allLines: PdfTextLine[] = [];
  for (const lines of pageLines) {
    allLines.push(...lines);
  }

  // Extract metadata
  const metadata = extractMetadata(allLines);

  // Prefer table geometry: Basis PDFs contain stable column/row coordinates and multi-line cells.
  // Keep the older block parser as a fallback for PDFs without a recognizable table header.
  let details = parseDetailsFromTableGeometry(pageLines);

  if (details.length === 0) {
    const blocks = groupIntoDetailBlocks(allLines);
    details = [];

    for (let i = 0; i < blocks.length; i++) {
      const detail = parseDetailBlock(blocks[i], i);
      if (detail) {
        details.push(detail);
      }
    }
  }

  const totalQuantity = details.reduce((sum, detail) => sum + (detail.quantity || 0), 0);

  // Validate against expected count
  // NOTE: "Общ. кол." в PDF обычно соответствует сумме по колонке "Кол-во", а не количеству позиций (строк таблицы).
  if (metadata.totalCount && totalQuantity !== metadata.totalCount) {
    parseErrors.push(
      `Ожидалось ${metadata.totalCount} деталей (сумма кол-ва), распознано ${totalQuantity} (позиций: ${details.length})`
    );
  }

  return {
    metadata,
    stats: {
      positionsCount: details.length,
      totalQuantity,
    },
    details,
    pages: allPageItems.length,
    parseErrors,
  };
}

// ============================================================================
// CONVERSION TO IMPORT FORMAT
// ============================================================================

/**
 * Converts parsed PDF details to import row format (compatible with validation step)
 */
export function convertToImportRows(result: PdfParsedResult): import('../types/importTypes').ImportRow[] {
  const metadataMaterials = result.metadata.material
    ? result.metadata.material.split(',').map(material => material.trim()).filter(Boolean)
    : [];
  const fallbackMaterial = metadataMaterials.length === 1 ? metadataMaterials[0] : null;

  return result.details.map((detail, index) => ({
    sourceRowIndex: index,
    height: detail.length,
    width: detail.width,
    quantity: detail.quantity,
    materialName: detail.material || fallbackMaterial,
    millingTypeName: detail.milling || null,
    filmName: detail.film || null,
    note: detail.note || null,
    // Format: "position~~designation~~name" (e.g., "1~~11.02~~Бок L")
    detailName: `${detail.position}~~${detail.designation}~~${detail.name}`,
  }));
}
