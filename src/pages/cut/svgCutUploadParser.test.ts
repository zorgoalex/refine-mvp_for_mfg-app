import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applySvgMatrixToPoint,
  buildSvgUploadLayoutItemsFromContours,
  matchVisualLabelsToPartContours,
  parseSvgPathPointsForUpload,
  parseSvgTransformList,
  svgUploadGeometryIsInformationalDetailContour,
  type PartContourGeometry,
  type VisualDetailLabel,
} from './svgCutUploadParser';

const parserSource = readFileSync('src/pages/cut/svgCutUploadParser.ts', 'utf8');

function roundedPoint(value: [number, number]): [number, number] {
  return [
    Math.round(value[0] * 1000) / 1000,
    Math.round(value[1] * 1000) / 1000,
  ];
}

function contour(values: Partial<PartContourGeometry> = {}): PartContourGeometry {
  return {
    elementId: 'PartContour',
    xMm: 0,
    yMm: 0,
    placedWidthMm: 100,
    placedHeightMm: 100,
    ...values,
  };
}

function visualLabel(values: Partial<VisualDetailLabel> = {}): VisualDetailLabel {
  return {
    key: '2776:1',
    orderName: '2776',
    detailNumber: 1,
    widthMm: 100,
    heightMm: 100,
    hasExplicitSize: true,
    cxMm: 50,
    cyMm: 50,
    linePointsMm: [[50, 50]],
    rawLines: ['2776', '# 1', '100*100'],
    ...values,
  };
}

describe('svgCutUploadParser transforms', () => {
  it('applies SVG transform lists in declared order', () => {
    const parsed = parseSvgTransformList('translate(10, 20) scale(2)');

    expect(parsed.error).toBeNull();
    expect(roundedPoint(applySvgMatrixToPoint([5, 5], parsed.matrix))).toEqual([30, 50]);
  });

  it('rotates around an explicit SVG transform center', () => {
    const parsed = parseSvgTransformList('rotate(90 50 50)');

    expect(parsed.error).toBeNull();
    expect(roundedPoint(applySvgMatrixToPoint([60, 50], parsed.matrix))).toEqual([50, 60]);
  });

  it('rejects malformed or unknown SVG transforms instead of treating them as identity', () => {
    expect(parseSvgTransformList('translate(10, 20) unknown(1)').error)
      .toBe('Неподдерживаемый SVG transform: unknown');
    expect(parseSvgTransformList('translate 10 20').error)
      .toBe('Неподдерживаемый синтаксис SVG transform');
    expect(parseSvgTransformList('matrix(1 0 0 1 10 20 garbage)').error)
      .toBe('Неподдерживаемый SVG transform: matrix');
    expect(parseSvgTransformList('translate(10 20px)').error)
      .toBe('Неподдерживаемый SVG transform: translate');
  });

  it('keeps relative cubic path control points relative to the segment start', () => {
    const points = parseSvgPathPointsForUpload('M100 100c10 0 20 0 30 0c10 0 20 0 30 0');

    expect(points).toEqual([
      [100, 100],
      [110, 100],
      [120, 100],
      [130, 100],
      [140, 100],
      [150, 100],
      [160, 100],
    ]);
  });
});

describe('svgCutUploadParser visual labels', () => {
  it('treats top-layer visual labels as the primary detail identity source', () => {
    expect(parserSource).toContain('extractVisualDetailLabels');
    expect(parserSource).toContain('matchVisualLabelsToPartContours');
    expect(parserSource).toContain('visualLabels.length > 0');
    expect(parserSource).toContain('Для контура детали PartContour не найдена верхняя подпись');
    expect(parserSource).toContain('Не найдены читаемые верхние подписи деталей');
    expect(parserSource).not.toContain('PartContour detail outline has no matching visual label');
    expect(parserSource).not.toContain('no readable top-layer detail labels');
    expect(parserSource).not.toContain('parseDetailComment');
    expect(parserSource).not.toContain('DETAIL_HEADER_RE');
    expect(parserSource).not.toContain('odm');
  });

  it('keeps a geometry fallback path for informative non-MDF uploads only', () => {
    expect(parserSource).toContain('allowGeometryFallbackItems');
    expect(parserSource).toContain('fallbackLayoutItemFromContour');
    expect(parserSource).toContain('fallbackOrderName');
    expect(parserSource).toContain('confidence: 0.72');
    expect(parserSource).toContain('options.allowGeometryFallbackItems !== true');
    expect(parserSource).toContain('svgUploadGeometryIsInformationalDetailContour');
  });

  it('accepts non-PartContour HDF rectangles as informational detail geometry', () => {
    const sheetBorder = contour({
      elementId: 'rect-1',
      xMm: 0.1,
      yMm: 0.1,
      placedWidthMm: 2069.9,
      placedHeightMm: 2799.9,
    });
    const hdfPiece = contour({
      elementId: '__x007e__x007e_vyborka',
      xMm: 368.09,
      yMm: 325.08,
      placedWidthMm: 344.98,
      placedHeightMm: 475.97,
    });

    expect(svgUploadGeometryIsInformationalDetailContour(sheetBorder, 2070.2, 2800.2, '', 'fil0 str0'))
      .toBe(false);
    expect(svgUploadGeometryIsInformationalDetailContour(hdfPiece, 2070.2, 2800.2, hdfPiece.elementId, 'fil0 str1'))
      .toBe(true);
  });

  it('builds informational items from generic HDF rectangles and two-line labels', () => {
    const hdfPieces = [
      contour({
        elementId: '__x007e__x007e_vyborka',
        xMm: 368.09,
        yMm: 325.08,
        placedWidthMm: 344.98,
        placedHeightMm: 475.97,
      }),
      contour({
        elementId: '__x007e__x007e_vyborka_5',
        xMm: 726.07,
        yMm: 1371.03,
        placedWidthMm: 281.99,
        placedHeightMm: 213.99,
      }),
    ];
    const result = buildSvgUploadLayoutItemsFromContours(
      hdfPieces,
      [
        visualLabel({
          key: '2777:3:no-size',
          orderName: '2777',
          detailNumber: 3,
          widthMm: null,
          heightMm: null,
          hasExplicitSize: false,
          cxMm: 450.98,
          cyMm: 572.11,
          linePointsMm: [[404.42, 542.98], [497.53, 601.23]],
          rawLines: ['2777', '# 3'],
        }),
        visualLabel({
          key: '2723:1:no-size',
          orderName: '2723',
          detailNumber: 1,
          widthMm: null,
          heightMm: null,
          hasExplicitSize: false,
          cxMm: 779.33,
          cyMm: 1522.09,
          linePointsMm: [[730.85, 1492.55], [827.82, 1551.63]],
          rawLines: ['2723', '# 1'],
        }),
      ],
      { allowGeometryFallbackItems: true, fallbackOrderName: '2777+2723' },
    );

    expect(result.rejected).toEqual([]);
    expect(result.layoutItems).toHaveLength(2);
    expect(result.layoutItems).toEqual(expect.arrayContaining([
      expect.objectContaining({
        orderName: '2723',
        detailNumber: 1,
        widthMm: 281.99,
        heightMm: 213.99,
      }),
      expect.objectContaining({
        orderName: '2777',
        detailNumber: 3,
        widthMm: 475.97,
        heightMm: 344.98,
      }),
    ]));
  });

  it('keeps label-only details for lenient upload when the visual label has explicit size', () => {
    const result = buildSvgUploadLayoutItemsFromContours(
      [],
      [
        visualLabel({
          key: '2790:1:720:600',
          orderName: '2790',
          detailNumber: 1,
          widthMm: 720,
          heightMm: 600,
          hasExplicitSize: true,
          cxMm: 460,
          cyMm: 640,
          rawLines: ['2790', '# 1', '720*600'],
        }),
      ],
      {
        includeVisualLabelOnlyItems: true,
        sheetWidthMm: 2070,
        sheetHeightMm: 2800,
      },
    );

    expect(result.layoutItems).toEqual([
      expect.objectContaining({
        orderName: '2790',
        detailNumber: 1,
        widthMm: 720,
        heightMm: 600,
        xMm: 100,
        yMm: 340,
      }),
    ]);
    expect(result.rejected.join('; ')).toContain('деталь создана по подписи');
  });

  it('passes parsed SVG sheet dimensions into label-only item creation', () => {
    expect(parserSource).toContain('sheetWidthMm: sheetWidth');
    expect(parserSource).toContain('sheetHeightMm: sheetHeight');
    expect(parserSource).not.toContain('sheetWidthMm,\n    sheetHeightMm,');
  });

  it('does not create MDF details from unlabeled geometry unless informational fallback is enabled', () => {
    const genericPiece = contour({
      elementId: 'rect-raw-geometry',
      xMm: 100,
      yMm: 200,
      placedWidthMm: 300,
      placedHeightMm: 400,
    });

    const strictLike = buildSvgUploadLayoutItemsFromContours([genericPiece], [], {
      includeVisualLabelOnlyItems: true,
      fallbackOrderName: '2777',
    });
    const informational = buildSvgUploadLayoutItemsFromContours([genericPiece], [], {
      allowGeometryFallbackItems: true,
      includeVisualLabelOnlyItems: true,
      fallbackOrderName: '2777',
    });

    expect(strictLike.layoutItems).toHaveLength(0);
    expect(informational.layoutItems).toEqual([
      expect.objectContaining({
        orderName: '2777',
        detailNumber: 1,
        widthMm: 300,
        heightMm: 400,
      }),
    ]);
  });

  it('matches visual labels by position when contour bbox size is slightly noisy', () => {
    const target = contour({
      elementId: '_2756_PartContour',
      xMm: 230,
      yMm: 480,
      placedWidthMm: 1365,
      placedHeightMm: 525,
    });
    const matches = matchVisualLabelsToPartContours(
      [target],
      [
        visualLabel({
          key: '2756:8:1342:502',
          orderName: '2756',
          detailNumber: 8,
          widthMm: 1342,
          heightMm: 502,
          cxMm: 680,
          cyMm: 640,
          linePointsMm: [[650, 570], [720, 615], [640, 665]],
          rawLines: ['2756', '# 8', '1342*502'],
        }),
      ],
    );

    expect(matches.get(target)?.orderName).toBe('2756');
    expect(matches.get(target)?.detailNumber).toBe(8);
  });

  it('can match small two-line labels and infer size from the nearby contour', () => {
    const small = contour({
      elementId: '_2776_PartContour_5',
      xMm: 228,
      yMm: 22,
      placedWidthMm: 150,
      placedHeightMm: 148,
    });
    const matches = matchVisualLabelsToPartContours(
      [small],
      [
        visualLabel({
          key: '2776:5:no-size',
          orderName: '2776',
          detailNumber: 5,
          widthMm: null,
          heightMm: null,
          hasExplicitSize: false,
          cxMm: 260,
          cyMm: 106,
          linePointsMm: [[228, 72], [255, 102]],
          rawLines: ['2776', '# 5'],
        }),
      ],
    );

    expect(matches.get(small)?.orderName).toBe('2776');
    expect(matches.get(small)?.detailNumber).toBe(5);
  });

  it('reuses one visual label for same-size PartContour siblings in one SVG part group', () => {
    const groupKey = '_2792_x007e__x007e_Part';
    const left = contour({
      elementId: '_2792_PartContour',
      groupKey,
      xMm: 923.55,
      yMm: 589.11,
      placedWidthMm: 446.98,
      placedHeightMm: 2197.89,
    });
    const right = contour({
      elementId: '_2792_PartContour_0',
      groupKey,
      xMm: 1377.03,
      yMm: 589.11,
      placedWidthMm: 446.98,
      placedHeightMm: 2197.89,
    });
    const label = visualLabel({
      key: '2792:1:2198:447',
      orderName: '2792',
      detailNumber: 1,
      widthMm: 2198,
      heightMm: 447,
      cxMm: 1600,
      cyMm: 1688,
      linePointsMm: [[1588, 1660], [1600, 1688], [1590, 1720]],
      rawLines: ['2792', '# 1', '2198*447'],
    });

    const matches = matchVisualLabelsToPartContours([left, right], [label]);

    expect(matches.get(left)).toBe(label);
    expect(matches.get(right)).toBe(label);
  });

  it('keeps sanitized source SVG geometry on parsed layout items for cut previews', () => {
    const sourceSvg = {
      viewBox: { xMm: 10, yMm: 20, widthMm: 40, heightMm: 30 },
      body: '<line x1="2" y1="2" x2="38" y2="28" fill="none" stroke="#111827" stroke-width="1.5"/>',
    };
    const result = buildSvgUploadLayoutItemsFromContours(
      [
        contour({
          elementId: '_2777_PartContour',
          xMm: 10,
          yMm: 20,
          placedWidthMm: 40,
          placedHeightMm: 30,
          sourceSvg,
        }),
      ],
      [
        visualLabel({
          key: '2777:3:40:30',
          orderName: '2777',
          detailNumber: 3,
          widthMm: 40,
          heightMm: 30,
          cxMm: 30,
          cyMm: 35,
          linePointsMm: [[30, 31], [30, 39], [30, 47]],
          rawLines: ['2777', '# 3', '40*30'],
        }),
      ],
    );

    expect(result.layoutItems).toHaveLength(1);
    expect(result.layoutItems[0]?.sourceSvg).toEqual(sourceSvg);
    expect(parserSource).toContain('buildSourceSvgFragmentForContour');
    expect(parserSource).toContain('SOURCE_SVG_FRAGMENT_TAGS');
  });
});
