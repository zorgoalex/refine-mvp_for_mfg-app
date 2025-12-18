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

/**
 * Checks if a string is a position number (1, 2, 3, ...)
 */
function isPositionNumber(text: string): boolean {
  const num = parseInt(text, 10);
  return /^\d+$/.test(text) && num > 0 && num < 1000;
}

/**
 * Checks if a line starts a new detail block.
 * A detail line typically starts with: position number (1-9), then designation (XX.XX or 2+ digits).
 * Example: "1 11.02 Бок L 779 97 1 1"
 */
function isBlockStart(line: PdfTextLine): boolean {
  // Method 1: Check first few items for designation pattern
  // First item is usually position (1, 2, 3...), second should be designation
  for (let i = 0; i < Math.min(5, line.items.length); i++) {
    const text = line.items[i]?.text?.trim() || '';
    if (isDesignation(text)) {
      return true;
    }
  }

  // Method 2: Check concatenated line text for pattern: position + designation at start
  // Pattern: single digit position, then space, then designation (XX.XX or 2+ digits)
  const lineText = line.text;
  const detailLinePattern = /^\s*\d{1,2}\s+(\d+\.\d+|\d{2,})\s/;
  if (detailLinePattern.test(lineText)) {
    return true;
  }

  return false;
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

  for (const line of contentLines) {
    if (isBlockStart(line)) {
      // Save previous block if not empty
      if (currentBlock.length > 0) {
        blocks.push({ lines: currentBlock });
      }
      // Start new block
      currentBlock = [line];
    } else if (currentBlock.length > 0) {
      // Continue current block
      currentBlock.push(line);
    }
    // Ignore lines before first block start
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

  // Collect ALL text items from ALL lines in the block
  const allItems: PdfTextItem[] = [];
  for (const line of lines) {
    allItems.push(...line.items);
  }

  // Sort items: first by Y (descending - top to bottom), then by X (ascending - left to right)
  allItems.sort((a, b) => {
    const yDiff = b.y - a.y;
    if (Math.abs(yDiff) > LINE_Y_TOLERANCE) return yDiff;
    return a.x - b.x;
  });

  const allTexts = allItems.map(item => item.text.trim()).filter(Boolean);

  if (allTexts.length < 4) return null;

  // Find designation
  let designationIdx = -1;
  for (let i = 0; i < Math.min(4, allTexts.length); i++) {
    if (isDesignation(allTexts[i])) {
      designationIdx = i;
      break;
    }
  }

  if (designationIdx === -1) return null;

  const designation = allTexts[designationIdx];

  // Check if there's a position number BEFORE designation
  let originalPosition: number | undefined;
  if (designationIdx > 0) {
    const possiblePosition = parseInt(allTexts[designationIdx - 1], 10);
    if (!isNaN(possiblePosition) && possiblePosition > 0 && possiblePosition < 1000) {
      originalPosition = possiblePosition;
    }
  }

  // Collect all numbers after designation
  const numbers: { index: number; value: number }[] = [];
  for (let i = designationIdx + 1; i < allTexts.length; i++) {
    const text = allTexts[i];
    const num = parseInt(text, 10);
    if (!isNaN(num) && /^\d+$/.test(text)) {
      numbers.push({ index: i, value: num });
    }
  }

  // We need at least 4 numbers: length, width, position_in_pdf, quantity
  // Or 3 numbers if position is not present
  if (numbers.length < 3) return null;

  // Name is between designation and first number
  const nameEndIndex = numbers[0].index;
  const nameParts = allTexts.slice(designationIdx + 1, nameEndIndex);
  const name = nameParts.join(' ').trim();

  // First two large numbers are sizes (length, width)
  // They should be > 50 typically (sizes in mm)
  let length = 0;
  let width = 0;
  let sizeCount = 0;

  for (const num of numbers) {
    if (num.value >= 50 && sizeCount < 2) {
      if (sizeCount === 0) {
        length = num.value;
      } else {
        width = num.value;
      }
      sizeCount++;
    }
  }

  // If we couldn't find sizes >= 50, use first two numbers
  if (length === 0 || width === 0) {
    length = numbers[0]?.value || 0;
    width = numbers[1]?.value || 0;
  }

  // Find quantity - it's a small number (1-100) after sizes
  // Usually the 4th number (after length, width, position)
  let quantity = 1;
  for (let i = 2; i < numbers.length; i++) {
    const num = numbers[i].value;
    if (num >= 1 && num <= 100) {
      quantity = num;
      break;
    }
  }

  // Collect remaining text for milling, film, note
  // Start from after the last number
  const lastNumberIdx = numbers.length > 0 ? numbers[numbers.length - 1].index : designationIdx;
  const remainingTexts = allTexts.slice(lastNumberIdx + 1);

  // Also check all texts for keywords (they might be before numbers due to PDF structure)
  const allRemainingTexts = [...remainingTexts];

  // Add texts that are not numbers and not part of name
  for (let i = nameEndIndex; i < allTexts.length; i++) {
    const text = allTexts[i];
    if (!/^\d+$/.test(text) && !allRemainingTexts.includes(text)) {
      allRemainingTexts.push(text);
    }
  }

  let milling: string | undefined;
  let film: string | undefined;
  let note: string | undefined;

  const filmParts: string[] = [];

  for (const text of allRemainingTexts) {
    if (!text || text === ':' || text === '.' || /^\d+$/.test(text)) continue;

    const lowerText = text.toLowerCase();

    // Check for milling keywords
    if (lowerText.includes('модерн') || lowerText.includes('лапша') || lowerText.includes('средняя')) {
      milling = text;
    }
    // Check for note keywords
    else if (lowerText.includes('присадка')) {
      note = text.endsWith(':') ? text : text + ':';
    }
    // Everything else goes to film
    else if (text.length > 1) {
      filmParts.push(text);
    }
  }

  // Build film string
  if (filmParts.length > 0) {
    film = filmParts.join(' ').trim();
  }

  // Validate we have essential data
  if (length === 0 || width === 0) {
    return null;
  }

  return {
    designation,
    name: name || 'Деталь',
    position: originalPosition || blockIndex + 1,
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
