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

  it('fits a frozen cut sheet into a resizable cut-map box with print-safe detail contrast', () => {
    const base = template();
    base.rendererCapabilities = ['if_else_v1', 'typography_v1', 'cut_map_v1'];
    base.elements = [{
      labelTemplateElementId: 10,
      elementKey: 'cut-map',
      kind: 'cut_map',
      sourceField: null,
      staticText: null,
      xMm: 5,
      yMm: 7,
      widthMm: 42,
      heightMm: 18,
      rotationDeg: 0,
      zIndex: 0,
      style: {
        cutMap: {
          version: 1,
          fit: 'contain',
          highlightFill: '#ffd666',
          highlightStroke: '#d4380d',
        },
      },
      condition: {},
    }];
    const mapped: LabelRow = {
      ...row({}),
      cutMap: {
        cutResultPlacementId: 77,
        cutResultSheetMapId: 9,
        cutResultId: 4,
        cutJobId: 12,
        cutNumber: '12-3',
        cutJobName: 'Кухня',
        variant: 'auto',
        sheetIndex: 8,
        sheetNumber: 2,
        sheetWidthMm: 1000,
        sheetHeightMm: 500,
        xMm: 120,
        yMm: 80,
        widthMm: 200,
        heightMm: 50,
      },
    };

    const svg = renderSvgPages(base, [mapped], new Map([
      [9, {
        svg: [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500">',
          '<rect x="0" y="0" width="1000" height="500" fill="#fff" stroke="#9aa7b4" stroke-width="3"/>',
          '<rect x="10" y="20" width="300" height="100" fill="#eef3f8" stroke="#1f2d3d" stroke-width="2"/>',
          '</svg>',
        ].join(''),
        isVacuum: false,
      }],
    ])).pages[0];

    expect(svg).toContain('data-label-element-kind="cut_map"');
    expect(svg).toContain('width="42" height="18" viewBox="0 0 1000 500" preserveAspectRatio="xMidYMid meet"');
    expect(svg).toContain('fill="#fff" stroke="#9aa7b4" stroke-width="3"');
    expect(svg).toContain('fill="#eef3f8" stroke="#1f2d3d" stroke-width="4"');
    expect(svg).toContain('x="120" y="80" width="200" height="50" fill="#000000" stroke="#000000"');
    expect(svg).not.toContain('fill="#ffd666"');
    expect(svg).not.toContain('stroke="#d4380d"');

    expect(() => renderSvgPages(base, [mapped], new Map([
      [9, {
        svg: '<svg xmlns="http://www.w3.org/2000/svg"><rect x="0" y="0" width="1" height="1" onload="alert(1)"/></svg>',
        isVacuum: false,
      }],
    ]))).toThrow(/Invalid frozen cut-map asset/);
  });

  it('renders a parsed Telegram SVG as the full sheet with the selected detail highlighted', () => {
    const base = cutMapTemplate();
    const mapped: LabelRow = {
      ...row({}),
      cutMap: {
        source: 'telegram_svg',
        assetKey: 'telegram_svg:31',
        telegramLabelSheetMapId: 31,
        telegramLabelPlacementId: 44,
        packetId: '11111111-1111-4111-8111-111111111111',
        sourceVersion: 2,
        sourceMessageId: 901,
        sourceDigest: 'sha256:layout',
        cutNumber: 'TG-901',
        cutJobName: 'Telegram',
        variant: 'telegram',
        sheetIndex: 1,
        sheetNumber: 1,
        sheetWidthMm: 1000,
        sheetHeightMm: 500,
        xMm: 120,
        yMm: 80,
        widthMm: 200,
        heightMm: 50,
      },
    };
    const svg = renderSvgPages(base, [mapped], new Map([['telegram_svg:31', {
      svg: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1000 500"><rect x="0" y="0" width="1000" height="500"/><rect x="120" y="80" width="200" height="50"/></svg>',
      isVacuum: false,
    }]])).pages[0];

    expect(svg).toContain('viewBox="0 0 1000 500"');
    expect(svg).toContain('x="120" y="80" width="200" height="50" fill="#000000" stroke="#000000"');
  });

  it('renders Telegram screenshot fallback without a selected-detail overlay', () => {
    const base = cutMapTemplate();
    const mapped: LabelRow = {
      ...row({}),
      cutMap: {
        source: 'telegram_image',
        assetKey: 'telegram_image:packet:2',
        packetId: '11111111-1111-4111-8111-111111111111',
        sourceVersion: 2,
        sourceMessageId: 901,
        sourceDigest: 'sha256:image',
        rawSha256: 'sha256:raw',
        normalizedSha256: 'sha256:normalized',
        cutNumber: 'TG-901',
        cutJobName: 'Telegram',
        variant: 'telegram',
        sheetIndex: 1,
        sheetNumber: 1,
      },
    };
    const svg = renderSvgPages(base, [mapped], new Map([['telegram_image:packet:2', {
      kind: 'image',
      dataUri: 'data:image/png;base64,iVBORw0KGgo=',
    }]])).pages[0];

    expect(svg).toContain('data-cut-map-source="telegram_image"');
    expect(svg).toContain('preserveAspectRatio="xMidYMid meet"');
    expect(svg).not.toContain('fill="#000000" stroke="#000000"');
  });

  it('mirrors the final cut-map thumbnail horizontally, vertically, or on both axes', () => {
    const render = (
      flipHorizontal: boolean,
      flipVertical: boolean,
      options: { rotate?: boolean; isVacuum?: boolean } = {},
    ) => {
      const sheetWidthMm = options.rotate ? 500 : 1000;
      const sheetHeightMm = options.rotate ? 1000 : 500;
      const mapped: LabelRow = {
        ...row({}),
        cutMap: {
          cutResultPlacementId: 77,
          cutResultSheetMapId: 9,
          cutResultId: 4,
          cutJobId: 12,
          cutNumber: '12-3',
          cutJobName: 'Кухня',
          variant: 'auto',
          sheetIndex: 8,
          sheetNumber: 2,
          sheetWidthMm,
          sheetHeightMm,
          xMm: 120,
          yMm: 80,
          widthMm: 200,
          heightMm: 50,
        },
      };
      const assets = new Map([[9, {
        svg: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${sheetWidthMm} ${sheetHeightMm}"><rect x="10" y="20" width="300" height="100"/></svg>`,
        isVacuum: options.isVacuum ?? false,
      }]]);
      const base = template();
      base.rendererCapabilities = ['if_else_v1', 'typography_v1', 'cut_map_v1', 'cut_map_flip_v1'];
      base.elements = [{
        labelTemplateElementId: 10,
        elementKey: 'cut-map',
        kind: 'cut_map',
        sourceField: null,
        staticText: null,
        xMm: 5,
        yMm: 7,
        widthMm: 42,
        heightMm: 18,
        rotationDeg: 0,
        zIndex: 0,
        style: {
          cutMap: {
            version: 1,
            fit: 'contain',
            highlightFill: '#ffd666',
            highlightStroke: '#d4380d',
            flipHorizontal,
            flipVertical,
          },
        },
        condition: {},
      }];
      return renderSvgPages(base, [mapped], assets).pages[0];
    };

    expect(render(true, false)).toContain('transform="translate(1000 0) scale(-1 1)"');
    expect(render(false, true)).toContain('transform="translate(0 500) scale(1 -1)"');
    expect(render(true, true)).toContain('transform="translate(1000 500) scale(-1 -1)"');
    expect(render(false, false)).not.toContain('scale(-1');

    const flippedCases = [
      { horizontal: true, vertical: false, transform: 'translate(1000 0) scale(-1 1)' },
      { horizontal: false, vertical: true, transform: 'translate(0 500) scale(1 -1)' },
      { horizontal: true, vertical: true, transform: 'translate(1000 500) scale(-1 -1)' },
    ];
    for (const flip of flippedCases) {
      expect(render(flip.horizontal, flip.vertical, { rotate: true, isVacuum: false }))
        .toContain(`transform="${flip.transform}"><g transform="matrix(0 1 1 0 0 0)"`);
      expect(render(flip.horizontal, flip.vertical, { rotate: true, isVacuum: true }))
        .toContain(`transform="${flip.transform}"><g transform="translate(1000 0) rotate(90)"`);
    }
  });

  it('accepts frozen cut maps with safe piece groups and bath guide labels', () => {
    const base = template();
    base.rendererCapabilities = ['if_else_v1', 'typography_v1', 'cut_map_v1'];
    base.elements = [{
      labelTemplateElementId: 10,
      elementKey: 'cut-map',
      kind: 'cut_map',
      sourceField: null,
      staticText: null,
      xMm: 5,
      yMm: 7,
      widthMm: 42,
      heightMm: 18,
      rotationDeg: 0,
      zIndex: 0,
      style: {
        cutMap: {
          version: 1,
          fit: 'contain',
          highlightFill: '#ffd666',
          highlightStroke: '#d4380d',
        },
      },
      condition: {},
    }];
    const mapped: LabelRow = {
      ...row({}),
      cutMap: {
        cutResultPlacementId: 77,
        cutResultSheetMapId: 344,
        cutResultId: 4,
        cutJobId: 12,
        cutNumber: '12-3',
        cutJobName: 'Ванна',
        variant: 'auto',
        sheetIndex: 8,
        sheetNumber: 2,
        sheetWidthMm: 1050,
        sheetHeightMm: 2800,
        xMm: 0,
        yMm: 0,
        widthMm: 550,
        heightMm: 830,
      },
    };

    const svg = renderSvgPages(base, [mapped], new Map([
      [344, {
        svg: [
          '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1050 2800">',
          '<rect x="0" y="0" width="1050" height="2800" fill="#ffffff" stroke="#9aa7b4" stroke-width="3"/>',
          '<g class="cut-sheet-piece" data-item-id="det-62196" data-piece-instance="1" data-piece-cx="275" data-piece-cy="415" data-detail-id="62196">',
          '<rect x="0" y="0" width="550" height="830" fill="#d7e9ff" stroke="#1f2d3d" stroke-width="2"/>',
          '</g>',
          '<line class="cut-bath-meter-guide" data-offset-mm="800" x1="0" y1="800" x2="1050" y2="800" stroke="#536273" stroke-opacity="0.28" stroke-width="3" stroke-dasharray="18 14" pointer-events="none"/>',
          '<text class="cut-bath-meter-guide-label" data-offset-mm="800" x="14.7" y="785.3" fill="#ff6a00" font-family="Liberation Sans, sans-serif" font-size="21" font-weight="700" text-anchor="start" dominant-baseline="middle" stroke="#ffffff" stroke-width="3.36" paint-order="stroke" pointer-events="none" style="font-variant-numeric:tabular-nums">800мм</text>',
          '</svg>',
        ].join(''),
        isVacuum: true,
      }],
    ])).pages[0];

    expect(svg).toContain('stroke-dasharray="18 14"');
    expect(svg).toContain('font-family="DejaVu Sans, Arial, sans-serif">800мм</text>');
    expect(svg).toContain('fill="#d7e9ff" stroke="#1f2d3d" stroke-width="4"');
    expect(svg).not.toContain('class="cut-sheet-piece"');
    expect(svg).not.toContain('data-offset-mm');
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

  it('renders strict typography v1 as physical font size, bold, and italic SVG attributes', () => {
    const base = template();
    base.elements[0] = {
      ...base.elements[0],
      style: {
        typography: {
          version: 1,
          fontSizePt: 14,
          fontWeight: 'bold',
          italic: true,
        },
      },
    };

    const svg = renderSvgPages(base, [row({ 'bazis.name': 'Side' })]).pages[0];

    expect(svg).toContain('font-size="4.9392"');
    expect(svg).toContain('font-weight="700"');
    expect(svg).toContain('font-style="italic"');
  });

  it('renders persisted element rotations around the same top-left origin as the canvas', () => {
    const base = template();
    base.elements = base.elements.map((element, index) => ({
      ...element,
      rotationDeg: 15 + index * 15,
    }));

    const svg = renderSvgPages(base, [row({ 'bazis.name': 'Side' })]).pages[0];

    expect(svg).toContain('<g transform="rotate(15 1 1)"><text ');
    expect(svg).toContain('<g transform="rotate(30 1 10)"><line ');
    expect(svg).toContain('<g transform="rotate(45 1 12)"><rect ');
  });

  it('resolves if/else v1 branches to another field, fixed text, current value, or hidden output', () => {
    const base = template();
    const condition = (thenBranch: Record<string, unknown>, elseBranch: Record<string, unknown>) => ({
      type: 'if_else',
      version: 1,
      when: { field: 'detail.material_name', op: 'equals', value: 'МДФ' },
      then: thenBranch,
      else: elseBranch,
    });
    base.elements = [
      { ...base.elements[0], elementKey: 'field', condition: condition({ type: 'field', field: 'detail.detail_name' }, { type: 'text', value: 'Не МДФ' }) },
      { ...base.elements[0], elementKey: 'text', yMm: 7, zIndex: 1, condition: condition({ type: 'text', value: 'Фикс & <текст>' }, { type: 'current' }) },
      { ...base.elements[0], elementKey: 'hidden', yMm: 13, zIndex: 2, condition: condition({ type: 'hidden' }, { type: 'current' }) },
    ];

    const mdf = renderSvgPages(base, [row({
      'bazis.name': 'Исходное',
      'detail.material_name': 'МДФ',
      'detail.detail_name': 'Фасад',
    })]).pages[0];
    expect(mdf).toContain('Фасад');
    expect(mdf).toContain('Фикс &amp; &lt;текст&gt;');
    expect(mdf).not.toContain('Исходное');

    const other = renderSvgPages(base, [row({
      'bazis.name': 'Исходное',
      'detail.material_name': 'ЛДСП',
      'detail.detail_name': 'Боковина',
    })]).pages[0];
    expect(other).toContain('Не МДФ');
    expect(other).toContain('Исходное');
  });

  it('keeps legacy visibility conditions compatible', () => {
    const base = template();
    base.elements[0] = {
      ...base.elements[0],
      condition: { field: 'bazis.comment', op: 'not_empty' },
    };

    expect(renderSvgPages(base, [row({ 'bazis.name': 'Side', 'bazis.comment': '' })]).pages[0]).not.toContain('Side');
    expect(renderSvgPages(base, [row({ 'bazis.name': 'Side', 'bazis.comment': 'ok' })]).pages[0]).toContain('Side');
  });

  it('grandfathers unknown stored unversioned conditions as visible original content', () => {
    const base = template();
    base.elements[0] = { ...base.elements[0], condition: { legacyPluginRule: 'old' } };
    expect(renderSvgPages(base, [row({ 'bazis.name': 'Side' })]).pages[0]).toContain('Side');
  });

  it.each([
    { condition: { type: 'if_else', version: 2, when: {}, then: {}, else: {} } },
    { style: { typography: { version: 2, fontSizePt: 12, fontWeight: 'normal', italic: false } } },
    { style: { typography: { version: 1, fontSizePt: '12', fontWeight: 'normal', italic: false } } },
    { style: { futureStyle: { version: 2, payload: true } } },
  ])('fails closed on malformed stored versioned label metadata: %j', (patch) => {
    const base = template();
    base.elements[0] = { ...base.elements[0], ...patch };
    expect(() => renderSvgPages(base, [row({ 'bazis.name': 'Side' })])).toThrow(
      /if_else|label|typography|style/i,
    );
  });

  it('validates stored versioned metadata even when a render has no rows', () => {
    const base = template();
    base.elements[0] = {
      ...base.elements[0],
      style: { typography: { version: 1, fontSizePt: '12', fontWeight: 'normal', italic: false } },
    } as typeof base.elements[number];
    expect(() => renderSvgPages(base, [])).toThrow(/typography/i);
  });

  it('normalizes hostile legacy font sizes to finite safe renderer bounds', () => {
    const base = template();
    base.elements = [
      { ...base.elements[0], elementKey: 'infinite', style: { fontSize: '1e309' } },
      { ...base.elements[0], elementKey: 'huge', yMm: 10, style: { fontSize: 100000 } },
    ];
    const svg = renderSvgPages(base, [row({ 'bazis.name': 'Side' })]).pages[0];
    expect(svg).toContain('font-size="3.528"');
    expect(svg).toContain('font-size="33.8688"');
    expect(svg).not.toContain('Infinity');
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

  it('keeps rendering labels when a qr template resolves to an empty payload', () => {
    const base = template();
    base.elements = [
      {
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
        style: { qrTemplate: '{bazis.comment}', qrErrorCorrection: 'M' },
        condition: {},
      },
    ];

    const svg = renderSvgPages(base, [row({ 'bazis.comment': '' })]).pages[0];

    expect(svg).toContain('data-label-element-kind="qr"');
    expect(svg).toContain('data-qr-payload=""');
    expect(svg).toContain('<rect x="30" y="5" width="18" height="18" fill="white"/>');
    expect(svg).not.toContain('fill="black"');
  });

  it('renders multi-line qr payloads with newline characters preserved', () => {
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
      style: { qrTemplate: '{bazis.detail_id}-{bazis.name}\n{bazis.material}', qrErrorCorrection: 'M' },
      condition: {},
    });

    const svg = renderSvgPages(base, [row({ 'bazis.detail_id': '12345', 'bazis.name': 'Фасад', 'bazis.material': 'МДФ' })]).pages[0];

    expect(svg).toContain('data-label-element-kind="qr"');
    // The payload should contain the newline character within the data-qr-payload attribute
    expect(svg).toContain('data-qr-payload="12345-Фасад\nМДФ"');
    // Verify that QR code was rendered (contains black modules for non-empty payload)
    expect(svg).toContain('fill="black"');
  });

  it('renders content-bearing BMP/PNG and sample-compatible BMP-backed .emf entries in a ZIP', async () => {
    const input = {
      generationId: 7,
      orderId: 42,
      template: template(),
      rows: [row({ 'bazis.name': 'Side' })],
      formats: ['bmp', 'emf', 'png'] as Array<'bmp' | 'emf' | 'png'>,
      generatedAt: '2026-06-24T00:00:00.000Z',
    };
    const zip = await renderLabelsZip(input);
    const repeatedZip = await renderLabelsZip(input);

    expect(repeatedZip.equals(zip)).toBe(true);

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
    rendererCapabilities: ['if_else_v1', 'typography_v1'],
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

function cutMapTemplate(): LabelTemplateDto {
  const base = template();
  base.rendererCapabilities = ['if_else_v1', 'typography_v1', 'cut_map_v1'];
  base.elements = [{
    labelTemplateElementId: 10,
    elementKey: 'cut-map',
    kind: 'cut_map',
    sourceField: null,
    staticText: null,
    xMm: 5,
    yMm: 7,
    widthMm: 42,
    heightMm: 18,
    rotationDeg: 0,
    zIndex: 0,
    style: {
      cutMap: {
        version: 1,
        fit: 'contain',
        highlightFill: '#ffd666',
        highlightStroke: '#d4380d',
      },
    },
    condition: {},
  }];
  return base;
}

function row(values: Record<string, string>, rowIndex = 1): LabelRow {
  return { rowIndex, detailId: 1, orderId: 42, copyIndex: 1, copyCount: 1, values };
}
