import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  applySvgMatrixToPoint,
  matchVisualLabelsToPartContours,
  parseSvgTransformList,
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
});
