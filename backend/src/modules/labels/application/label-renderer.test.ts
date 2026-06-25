import { describe, expect, it } from 'vitest';
import JSZip from 'jszip';
import { PNG } from 'pngjs';
import { renderLabelsZip, renderSvgPages } from './label-renderer';
import type { LabelRow } from './label-row-builder';
import type { LabelTemplateDto } from './labels.types';

describe('label renderer', () => {
  it('renders escaped SVG text, line, and rect elements', () => {
    const svg = renderSvgPages(template(), [row({ 'bazis.name': '<Side & back>' })]).pages[0];

    expect(svg).toContain('&lt;Side &amp; back&gt;');
    expect(svg).toContain('fill="white"');
    expect(svg).toContain('<line ');
    expect(svg).toContain('<rect ');
  });

  it('renders content-bearing BMP/PNG and sample-compatible BMP-backed .emf entries in a ZIP', async () => {
    const zip = await renderLabelsZip({
      generationId: 7,
      orderId: 42,
      template: template(),
      rows: [row({ 'bazis.name': 'Side' })],
      formats: ['bmp', 'emf', 'png'],
      generatedAt: '2026-06-24T00:00:00.000Z',
    });

    const parsed = await JSZip.loadAsync(zip);
    const bmp = await parsed.file('labels/label1.bmp')?.async('nodebuffer');
    const emf = await parsed.file('labels/label1.emf')?.async('nodebuffer');
    const png = await parsed.file('labels/label1.png')?.async('nodebuffer');
    expect(bmp?.subarray(0, 2).toString('ascii')).toBe('BM');
    // Bazis samples store BMP bytes under .emf filenames; this is an intentional MVP compatibility mode.
    expect(emf?.subarray(0, 2).toString('ascii')).toBe('BM');
    expect(png).toBeTruthy();
    const image = PNG.sync.read(png!);
    expect(countBlackPixels(image.data)).toBeGreaterThan(0);
    expect(countWhitePixels(image.data)).toBeGreaterThan(countBlackPixels(image.data));
  });
});

function countBlackPixels(rgba: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] === 0 && rgba[i + 1] === 0 && rgba[i + 2] === 0) count += 1;
  }
  return count;
}

function countWhitePixels(rgba: Uint8Array): number {
  let count = 0;
  for (let i = 0; i < rgba.length; i += 4) {
    if (rgba[i] === 255 && rgba[i + 1] === 255 && rgba[i + 2] === 255) count += 1;
  }
  return count;
}

function template(): LabelTemplateDto {
  return {
    labelTemplateId: 1,
    name: 'Default',
    description: null,
    version: 1,
    isActive: true,
    canvasWidthMm: 84,
    canvasHeightMm: 55,
    dpi: 203,
    defaultExportFormats: ['bmp'],
    customFieldSchema: {},
    elements: [
      {
        labelTemplateElementId: 1,
        elementKey: 'name',
        kind: 'text',
        sourceField: 'bazis.name',
        staticText: null,
        xMm: 1,
        yMm: 1,
        widthMm: 20,
        heightMm: 5,
        rotationDeg: 0,
        zIndex: 0,
        style: {},
        condition: {},
      },
      {
        labelTemplateElementId: 2,
        elementKey: 'line',
        kind: 'line',
        sourceField: null,
        staticText: null,
        xMm: 1,
        yMm: 10,
        widthMm: 20,
        heightMm: 0,
        rotationDeg: 0,
        zIndex: 1,
        style: {},
        condition: {},
      },
      {
        labelTemplateElementId: 3,
        elementKey: 'rect',
        kind: 'rect',
        sourceField: null,
        staticText: null,
        xMm: 1,
        yMm: 12,
        widthMm: 20,
        heightMm: 5,
        rotationDeg: 0,
        zIndex: 2,
        style: {},
        condition: {},
      },
    ],
  };
}

function row(values: Record<string, string>): LabelRow {
  return { rowIndex: 1, detailId: 1, orderId: 42, copyIndex: 1, copyCount: 1, values };
}
