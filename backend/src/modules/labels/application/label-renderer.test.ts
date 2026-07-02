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

  it('aligns text values inside their template box with center as the default', () => {
    const base = template();
    base.elements = [
      { ...base.elements[0], elementKey: 'center', xMm: 10, widthMm: 30, style: {} },
      { ...base.elements[0], elementKey: 'left', xMm: 10, widthMm: 30, style: { textAlign: 'left' }, zIndex: 1 },
      { ...base.elements[0], elementKey: 'right', xMm: 10, widthMm: 30, style: { textAlign: 'right' }, zIndex: 2 },
    ];

    const svg = renderSvgPages(base, [row({ 'bazis.name': 'Side' })]).pages[0];

    expect(svg).toContain('<text x="25"');
    expect(svg).toContain('text-anchor="middle"');
    expect(svg).toContain('<text x="10"');
    expect(svg).toContain('text-anchor="start"');
    expect(svg).toContain('<text x="40"');
    expect(svg).toContain('text-anchor="end"');
  });

  it('renders qr elements with payload metadata and module geometry', () => {
    const base = template();
    base.elements.push({
      labelTemplateElementId: 4,
      elementKey: 'qr',
      kind: 'qr',
      sourceField: null,
      staticText: null,
      xMm: 30,
      yMm: 5,
      widthMm: 18,
      heightMm: 18,
      rotationDeg: 0,
      zIndex: 3,
      style: { qrTemplate: '{order.order_name}|{detail.erp_id}', qrErrorCorrection: 'M' },
      condition: {},
    });

    const svg = renderSvgPages(base, [row({ 'order.order_name': 'ORDER-42', 'detail.erp_id': '60044' })]).pages[0];

    expect(svg).toContain('data-label-element-kind="qr"');
    expect(svg).toContain('data-qr-payload="ORDER-42|60044"');
    expect(svg).toContain('<rect x="30" y="5" width="18" height="18" fill="white"/>');
    expect(svg).toMatch(/<rect x="[^"]+" y="[^"]+" width="[^"]+" height="[^"]+" fill="black"\/>/);
    const firstBlackModule = svg.match(/<rect x="([^"]+)" y="([^"]+)" width="([^"]+)" height="[^"]+" fill="black"\/>/);
    expect(firstBlackModule).toBeTruthy();
    const firstBlackX = Number(firstBlackModule?.[1]);
    const moduleSide = Number(firstBlackModule?.[3]);
    expect(firstBlackX).toBeGreaterThanOrEqual(30 + moduleSide * 4);
  });

  it('renders distinct qr payloads for distinct rows', () => {
    const base = template();
    base.elements.push({
      labelTemplateElementId: 4,
      elementKey: 'qr',
      kind: 'qr',
      sourceField: null,
      staticText: null,
      xMm: 30,
      yMm: 5,
      widthMm: 18,
      heightMm: 18,
      rotationDeg: 0,
      zIndex: 3,
      style: { qrTemplate: '{order.order_name}|{detail.erp_id}|{label.counter}', qrErrorCorrection: 'Q' },
      condition: {},
    });

    const pages = renderSvgPages(base, [
      row({ 'order.order_name': 'ORDER-42', 'detail.erp_id': '60044', 'label.counter': '1' }, 1),
      row({ 'order.order_name': 'ORDER-77', 'detail.erp_id': '60055', 'label.counter': '2' }, 2),
    ]).pages;

    expect(pages[0]).toContain('data-qr-payload="ORDER-42|60044|1"');
    expect(pages[1]).toContain('data-qr-payload="ORDER-77|60055|2"');
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

function row(values: Record<string, string>, rowIndex = 1): LabelRow {
  return { rowIndex, detailId: 1, orderId: 42, copyIndex: 1, copyCount: 1, values };
}
