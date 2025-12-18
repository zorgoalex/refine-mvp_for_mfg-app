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
      metadata.material = materialMatch[1].trim();
    }

    // Extract total count: "Общ. кол. 44"
    const totalMatch = text.match(TOTAL_COUNT_PATTERN);
    if (totalMatch) {
      metadata.totalCount = parseInt(totalMatch[1], 10);
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

  return metadata;
}

// ============================================================================
// DETAIL BLOCK PARSING (MULTI-LINE APPROACH)
// ============================================================================

interface DetailBlock {
  lines: PdfTextLine[];
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
  const match = line.text.match(/^\s*(\d{1,2})\s+(\d+(?:\.\d+)?)\s+/);
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

  const mainMatch = mainLine.text.match(/^\s*(\d{1,2})\s+(\d+(?:\.\d+)?)\s+(.+)$/);
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
  const allLines: PdfTextLine[] = [];
  for (const pageItems of allPageItems) {
    const lines = groupTextItemsIntoLines(pageItems);
    allLines.push(...lines);
  }

  // Extract metadata
  const metadata = extractMetadata(allLines);

  // Parse details using block-based approach
  const blocks = groupIntoDetailBlocks(allLines);
  const details: PdfDetailRaw[] = [];

  for (let i = 0; i < blocks.length; i++) {
    const detail = parseDetailBlock(blocks[i], i);
    if (detail) {
      details.push(detail);
    }
  }

  // Validate against expected count
  if (metadata.totalCount && details.length !== metadata.totalCount) {
    parseErrors.push(
      `Ожидалось ${metadata.totalCount} деталей, распознано ${details.length}`
    );
  }

  return {
    metadata,
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
  return result.details.map((detail, index) => ({
    sourceRowIndex: index,
    height: detail.length,
    width: detail.width,
    quantity: detail.quantity,
    millingTypeName: detail.milling || null,
    filmName: detail.film || null,
    note: detail.note || null,
    // Format: "position~~designation~~name" (e.g., "1~~11.02~~Бок L")
    detailName: `${detail.position}~~${detail.designation}~~${detail.name}`,
  }));
}
