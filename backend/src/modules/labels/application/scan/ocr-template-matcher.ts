import type { LabelTextFields } from './label-text-extraction';
import {
  matchesMaterial,
  parseDate,
  parseDetailNumber,
  parseDimensions,
  parseOrderNumber,
  parseQuantity,
} from './label-text-extraction';
import type { OcrFieldCode } from './ocr-field-catalog';
import { DISCRIMINANT_FIELDS, OCR_FIELD_STRENGTH } from './ocr-field-catalog';

export interface OcrTemplateRule {
  field: OcrFieldCode;
  sampleText?: string;
  anchor?: string | null;
}

export interface OcrTemplateForMatch {
  id: number;
  name: string;
  rules: OcrTemplateRule[];
}

export interface OcrMatchResult {
  templateId: number;
  templateName: string;
  score: number;
  fields: LabelTextFields;
}

/** Cyrillic <-> Latin OCR look-alike glyphs, mapped to a canonical Latin form. */
const ANCHOR_GLYPH_MAP: Record<string, string> = {
  Р: 'P',
  О: 'O',
  Х: 'X',
  С: 'C',
  Е: 'E',
  А: 'A',
  К: 'K',
  М: 'M',
  Т: 'T',
  В: 'B',
  Н: 'H',
};

function normalizeLine(line: string): string {
  return line.trim().replace(/\s+/g, ' ');
}

/** Normalizes a string for anchor substring comparison: uppercase, map OCR-confusable
 * Cyrillic/Latin glyphs to a single canonical form, and strip whitespace. */
function normalizeForAnchor(s: string): string {
  return s
    .toUpperCase()
    .split('')
    .map((ch) => ANCHOR_GLYPH_MAP[ch] ?? ch)
    .join('')
    .replace(/\s+/g, '');
}

function strengthWeight(field: OcrFieldCode): number {
  const strength = OCR_FIELD_STRENGTH[field];
  if (strength === 'strong') return 2;
  if (strength === 'weak') return 1;
  return 0;
}

type ValidationResult = { ok: true; value: unknown } | { ok: false };

function validateField(field: OcrFieldCode, line: string): ValidationResult {
  switch (field) {
    case 'order_number': {
      const v = parseOrderNumber(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'detail_number': {
      const v = parseDetailNumber(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'dimensions': {
      const v = parseDimensions(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'material': {
      const v = matchesMaterial(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'quantity': {
      const v = parseQuantity(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'date': {
      const v = parseDate(line);
      return v !== null ? { ok: true, value: v } : { ok: false };
    }
    case 'order_name':
    case 'detail_name': {
      const trimmed = line.trim();
      return trimmed.length > 0 && trimmed.length <= 300 ? { ok: true, value: trimmed } : { ok: false };
    }
    case 'ignore':
      return { ok: true, value: null };
    default:
      return { ok: false };
  }
}

interface Candidate {
  template: OcrTemplateForMatch;
  score: number;
  strongMatched: number;
  fields: LabelTextFields;
}

/**
 * Matches OCR label lines against a set of configurable templates.
 * In-order greedy per-template scan: each rule consumes the first remaining
 * line (from the current pointer onward) whose shape validates and whose
 * anchor (if any) is present. Rules that find no line are simply skipped
 * (pointer does not advance, no score awarded) — this keeps templates
 * resilient to missing/garbled OCR lines.
 */
export function matchOcrTemplates(lines: string[], templates: OcrTemplateForMatch[]): OcrMatchResult | null {
  const normalizedLines = lines.map(normalizeLine);
  const candidates: Candidate[] = [];

  for (const template of templates) {
    let pointer = 0;
    let score = 0;
    let strongMatched = 0;
    let hasDiscriminant = false;
    let matchedOrderNumberValue: string | undefined;
    let matchedOrderNameValue: string | undefined;
    const fields: LabelTextFields = {};

    for (const rule of template.rules) {
      let foundIdx = -1;
      let foundValue: unknown;

      for (let i = pointer; i < normalizedLines.length; i++) {
        const line = normalizedLines[i];
        const res = validateField(rule.field, line);
        if (!res.ok) continue;

        if (rule.anchor) {
          const anchorNorm = normalizeForAnchor(rule.anchor);
          const lineNorm = normalizeForAnchor(line);
          if (anchorNorm.length > 0 && !lineNorm.includes(anchorNorm)) continue;
        }

        foundIdx = i;
        foundValue = res.value;
        break;
      }

      if (foundIdx === -1) continue;

      pointer = foundIdx + 1;
      score += strengthWeight(rule.field);
      if (OCR_FIELD_STRENGTH[rule.field] === 'strong') strongMatched++;

      const anchoredMatch = !!rule.anchor && rule.anchor.trim().length > 0;
      if (DISCRIMINANT_FIELDS.has(rule.field) || anchoredMatch) hasDiscriminant = true;

      switch (rule.field) {
        case 'order_number':
          matchedOrderNumberValue = foundValue as string;
          break;
        case 'order_name':
          matchedOrderNameValue = foundValue as string;
          break;
        case 'detail_number':
          fields.detailNumber = foundValue as number;
          break;
        case 'dimensions': {
          const d = foundValue as { width: number; height: number };
          fields.width = d.width;
          fields.height = d.height;
          break;
        }
        case 'material':
          fields.material = foundValue as string;
          break;
        case 'date':
          fields.date = foundValue as string;
          break;
        default:
          // quantity, detail_name, ignore: matched (score counted) but not stored in fields
          break;
      }
    }

    if (matchedOrderNumberValue !== undefined) {
      fields.orderName = matchedOrderNumberValue;
    } else if (matchedOrderNameValue !== undefined) {
      fields.orderName = matchedOrderNameValue;
    }

    const passes = score >= 4 && strongMatched >= 2 && hasDiscriminant;
    if (passes) {
      candidates.push({ template, score, strongMatched, fields });
    }
  }

  if (candidates.length === 0) return null;

  candidates.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (b.strongMatched !== a.strongMatched) return b.strongMatched - a.strongMatched;
    return a.template.id - b.template.id;
  });

  const winner = candidates[0];
  return {
    templateId: winner.template.id,
    templateName: winner.template.name,
    score: winner.score,
    fields: winner.fields,
  };
}
