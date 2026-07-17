import { describe, expect, it } from 'vitest';
import {
  canonicalizePdfLayoutSignature,
  fingerprintPdfLayoutSignature,
  validatePdfLayoutMapping,
  type PdfLayoutSignature,
} from './pdfLayoutPattern';

function signature(): PdfLayoutSignature {
  return {
    fingerprintVersion: 1,
    parserMajor: 1,
    headerBandCount: 2,
    columns: [
      { header: ' № ', relativeStart: 0, relativeEnd: 0.1 },
      { header: 'Наименование', relativeStart: 0.1, relativeEnd: 0.6 },
      { header: 'Размер, мм', relativeStart: 0.6, relativeEnd: 1, children: ['Длина', 'Ширина'] },
    ],
  };
}

describe('PDF layout pattern fingerprint', () => {
  it('normalizes label spelling and harmless geometry jitter', async () => {
    const moved = signature();
    moved.columns[1] = { ...moved.columns[1], header: 'НАИМЕНОВАНИЕ!!!', relativeStart: 0.10004 };
    expect(await fingerprintPdfLayoutSignature(moved)).toBe(
      await fingerprintPdfLayoutSignature(signature()),
    );
  });

  it('changes for incompatible column order/topology', async () => {
    const changed = signature();
    changed.columns = [changed.columns[1], changed.columns[0], changed.columns[2]];
    expect(await fingerprintPdfLayoutSignature(changed)).not.toBe(
      await fingerprintPdfLayoutSignature(signature()),
    );
  });

  it('contains no row/document identity dimensions', () => {
    expect(canonicalizePdfLayoutSignature(signature())).toEqual({
      fingerprintVersion: 1,
      parserMajor: 1,
      headerBandCount: 2,
      columns: [
        { header: 'no', relativeStart: 0, relativeEnd: 0.1 },
        { header: 'наименование', relativeStart: 0.1, relativeEnd: 0.6 },
        {
          header: 'размер мм',
          relativeStart: 0.6,
          relativeEnd: 1,
          children: ['длина', 'ширина'],
        },
      ],
    });
  });
});

describe('PDF layout mapping validation', () => {
  it('requires name, quantity and dimensions without duplicate targets', () => {
    expect(validatePdfLayoutMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'quantity' },
        { columnIndex: 2, target: 'compound_size' },
      ],
    })).toEqual([]);
    expect(validatePdfLayoutMapping({
      schemaVersion: 1,
      columns: [
        { columnIndex: 0, target: 'name' },
        { columnIndex: 1, target: 'name' },
      ],
    })).toHaveLength(3);
  });
});
