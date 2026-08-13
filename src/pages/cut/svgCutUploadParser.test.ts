import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { applySvgMatrixToPoint, parseSvgTransformList } from './svgCutUploadParser';

const parserSource = readFileSync('src/pages/cut/svgCutUploadParser.ts', 'utf8');

function roundedPoint(value: [number, number]): [number, number] {
  return [
    Math.round(value[0] * 1000) / 1000,
    Math.round(value[1] * 1000) / 1000,
  ];
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
      .toBe('unsupported SVG transform: unknown');
    expect(parseSvgTransformList('translate 10 20').error)
      .toBe('unsupported SVG transform syntax');
    expect(parseSvgTransformList('matrix(1 0 0 1 10 20 garbage)').error)
      .toBe('unsupported SVG transform: matrix');
    expect(parseSvgTransformList('translate(10 20px)').error)
      .toBe('unsupported SVG transform: translate');
  });
});

describe('svgCutUploadParser visual labels', () => {
  it('treats top-layer visual labels as the primary detail identity source', () => {
    expect(parserSource).toContain('extractVisualDetailLabels');
    expect(parserSource).toContain('matchVisualLabelsToPartContours');
    expect(parserSource).toContain('visualLabels.length > 0');
    expect(parserSource).toContain('PartContour detail outline has no matching visual label');
    expect(parserSource.indexOf('if (visualLabels.length > 0)'))
      .toBeLessThan(parserSource.indexOf('} else {\n    for (const contour of partContours)'));
  });
});
