import { describe, expect, it } from 'vitest';
import type { LabelTemplateElement } from '../../../api/types/labelsApi.types';
import {
  autoShiftForQr,
  collectQrConflicts,
  elementRect,
  extractQrTemplateFieldIds,
  qrProtectedRect,
  qrSideOf,
  renderQrTemplate,
} from './labelQrHelpers';

const canvas = { widthMm: 100, heightMm: 60 };

describe('label QR helpers', () => {
  it('extracts unique fields and renders custom QR template strings', () => {
    expect(extractQrTemplateFieldIds('D={ bazis.detail_id }; O={order.id}; D2={bazis.detail_id}')).toEqual([
      'bazis.detail_id',
      'order.id',
    ]);
    expect(renderQrTemplate('D={ bazis.detail_id };M={material};X={missing}', {
      'bazis.detail_id': 2590,
      material: 'MDF',
    })).toBe('D=2590;M=MDF;X=');
  });

  it('keeps at least 10 percent quiet zone around the QR code', () => {
    const qr = element({ kind: 'qr', xMm: 10, yMm: 20, widthMm: 30, heightMm: 30 });
    expect(qrSideOf(qr)).toBe(30);
    expect(qrProtectedRect(qr)).toEqual({ x: 7, y: 17, width: 36, height: 36 });
  });

  it('moves an unlocked overlapping element and keeps QR in the returned elements array', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 20, yMm: 10, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 18, yMm: 12, widthMm: 10, heightMm: 5 });
    const result = autoShiftForQr({ qr, elements: [text], canvas });

    expect(result.conflicts).toEqual([]);
    expect(result.elements.find((item) => item.elementKey === 'qr-1')).toMatchObject({
      kind: 'qr',
      widthMm: 20,
      heightMm: 20,
    });
    expect(result.elements.find((item) => item.elementKey === 'text-1')).toMatchObject({
      xMm: 18,
      yMm: 3,
    });
  });

  it('chooses the shortest valid shift instead of a fixed direction', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 40, yMm: 20, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 44, yMm: 18, widthMm: 5, heightMm: 5 });
    const result = autoShiftForQr({ qr, elements: [qr, text], canvas });

    expect(result.conflicts).toEqual([]);
    expect(result.elements.find((item) => item.elementKey === 'text-1')).toMatchObject({
      xMm: 44,
      yMm: 13,
    });
  });

  it('falls through to the next shortest valid shift when the shortest shift is blocked', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 40, yMm: 20, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 44, yMm: 18, widthMm: 5, heightMm: 5 });
    const topBlocker = element({ elementKey: 'top-blocker', xMm: 44, yMm: 13, widthMm: 5, heightMm: 5 });
    const result = autoShiftForQr({ qr, elements: [qr, text, topBlocker], canvas });

    expect(result.conflicts).toEqual([]);
    expect(result.elements.find((item) => item.elementKey === 'text-1')).toMatchObject({
      xMm: 33,
      yMm: 18,
    });
  });

  it('reports a conflict instead of creating a new element-element overlap', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 20, yMm: 10, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 18, yMm: 12, widthMm: 10, heightMm: 5 });
    const blockers = [
      element({ elementKey: 'left', xMm: 7.9, yMm: 12, widthMm: 10, heightMm: 5 }),
      element({ elementKey: 'right', xMm: 42, yMm: 12, widthMm: 10, heightMm: 5 }),
      element({ elementKey: 'top', xMm: 18, yMm: 0, widthMm: 10, heightMm: 5 }),
      element({ elementKey: 'bottom', xMm: 18, yMm: 32, widthMm: 10, heightMm: 5 }),
    ];
    const result = autoShiftForQr({ qr, elements: [qr, text, ...blockers], canvas });

    expect(result.conflicts).toEqual([
      { elementKey: 'qr-1', conflictKey: 'blocked:text-1', reason: 'blocked', otherElementKey: 'text-1' },
    ]);
    expect(result.elements.find((item) => item.elementKey === 'qr-1')).toMatchObject({ xMm: 20, yMm: 10 });
    expect(result.elements.find((item) => item.elementKey === 'text-1')).toMatchObject({ xMm: 18, yMm: 12 });
  });

  it('reports locked element conflicts', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 20, yMm: 10, widthMm: 20, heightMm: 20 });
    const locked = element({ elementKey: 'locked', xMm: 18, yMm: 12, widthMm: 10, heightMm: 5, style: { locked: true } });
    const result = autoShiftForQr({ qr, elements: [qr, locked], canvas });

    expect(result.conflicts).toEqual([
      { elementKey: 'qr-1', conflictKey: 'locked:locked', reason: 'locked', otherElementKey: 'locked' },
    ]);
    expect(result.elements.find((item) => item.elementKey === 'locked')).toMatchObject({ xMm: 18, yMm: 12 });
  });

  it('reports an edge conflict when the quiet zone leaves the canvas', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 1, yMm: 1, widthMm: 20, heightMm: 20 });
    const result = autoShiftForQr({ qr, elements: [qr], canvas });

    expect(result.conflicts).toEqual([
      { elementKey: 'qr-1', conflictKey: 'edge:qr-1', reason: 'edge' },
    ]);
    expect(result.elements).toEqual([qr]);
  });

  it('does not insert a new QR element when its requested placement conflicts', () => {
    const qr = element({ elementKey: 'qr-1', kind: 'qr', xMm: 1, yMm: 1, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 30, yMm: 10, widthMm: 10, heightMm: 5 });
    const result = autoShiftForQr({ qr, elements: [text], canvas });

    expect(result.conflicts).toEqual([
      { elementKey: 'qr-1', conflictKey: 'edge:qr-1', reason: 'edge' },
    ]);
    expect(result.elements).toEqual([text]);
  });

  it('collects multiple QR table and canvas conflicts', () => {
    const qrA = element({ elementKey: 'qr-a', kind: 'qr', xMm: 1, yMm: 1, widthMm: 20, heightMm: 20 });
    const qrB = element({ elementKey: 'qr-b', kind: 'qr', xMm: 50, yMm: 20, widthMm: 20, heightMm: 20 });
    const text = element({ elementKey: 'text-1', xMm: 52, yMm: 22, widthMm: 5, heightMm: 5 });
    const conflicts = collectQrConflicts([qrA, qrB, text], canvas);

    expect(conflicts).toEqual([
      { elementKey: 'qr-a', conflictKey: 'edge:qr-a', reason: 'edge' },
      { elementKey: 'qr-b', conflictKey: 'overlap:qr-b:text-1', reason: 'overlap', otherElementKey: 'text-1' },
    ]);
  });

  it('uses a practical hit rectangle for non-QR elements', () => {
    expect(elementRect(element({ kind: 'line', xMm: 2, yMm: 3, widthMm: 12, heightMm: 0 }))).toEqual({
      x: 2,
      y: 3,
      width: 12,
      height: 1,
    });
  });
});

function element(patch: Partial<LabelTemplateElement>): LabelTemplateElement {
  return {
    elementKey: 'element-1',
    kind: 'text',
    sourceField: null,
    staticText: null,
    xMm: 0,
    yMm: 0,
    widthMm: 10,
    heightMm: 5,
    rotationDeg: 0,
    zIndex: 0,
    style: {},
    condition: {},
    ...patch,
  };
}
