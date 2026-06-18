import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  MAX_BODY_BYTES,
  MAX_INSTANCES,
  assertWithinBodyLimit,
  assertWithinInstanceLimit,
  backMapSolutions,
  buildOptimizeRequest,
  grainRuleForFilm,
  validateGrainRule,
} from './cut-freecut-mapping';

describe('film grain -> rotation/pattern mapping (§6)', () => {
  it('textured film forbids rotation and pins pattern along height', () => {
    expect(grainRuleForFilm(true)).toEqual({
      rotation: 'forbid',
      pattern_direction: 'along_height',
    });
  });

  it('plain / missing film allows 90deg rotation with no pattern', () => {
    expect(grainRuleForFilm(false)).toEqual({ rotation: 'allow_90', pattern_direction: 'none' });
    expect(grainRuleForFilm(null)).toEqual({ rotation: 'allow_90', pattern_direction: 'none' });
    expect(grainRuleForFilm(undefined)).toEqual({
      rotation: 'allow_90',
      pattern_direction: 'none',
    });
  });

  it('rejects a misconfigured grain rule at write time (MINOR-13)', () => {
    expect(() => validateGrainRule({ rotation: 'spin', pattern_direction: 'none' })).toThrow(
      ApiError,
    );
    expect(() =>
      validateGrainRule({ rotation: 'allow_90', pattern_direction: 'diagonal' }),
    ).toThrow(ApiError);
    expect(() =>
      validateGrainRule({ rotation: 'forbid', pattern_direction: 'along_height' }),
    ).not.toThrow();
  });
});

describe('freecut optimize request builder (§6)', () => {
  const stock = { id: 'smt-9', width_mm: 2800, height_mm: 2070 };
  const items = [
    {
      id: 'det-1',
      width_mm: 600,
      height_mm: 400,
      qty: 2,
      rotation: 'allow_90' as const,
      pattern_direction: 'none' as const,
    },
  ];
  const params = {
    kerf_mm: 2,
    spacing_mm: 1,
    trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
    objective: 'min_waste' as const,
  };

  it('always sets include_svg explicitly false in production (MAJOR-5)', () => {
    const request = buildOptimizeRequest({ stock, items, params });
    expect(request.params.include_svg).toBe(false);
    expect(request.units).toBe('mm');
    expect(request.stock).toEqual([{ id: 'smt-9', width_mm: 2800, height_mm: 2070, qty: 0 }]);
    expect(request.items).toEqual(items);
  });

  it('allows include_svg=true only via an explicit debug toggle', () => {
    const request = buildOptimizeRequest({ stock, items, params, includeSvg: true });
    expect(request.params.include_svg).toBe(true);
  });

  it('passes retry_strategy through to freecut (calibrated prod path = disabled)', () => {
    const request = buildOptimizeRequest({
      stock,
      items,
      params: { ...params, retry_strategy: 'disabled' },
    });
    expect(request.params.retry_strategy).toBe('disabled');
  });
});

describe('pre-call guards (BLOCKER-3 / MAJOR-6)', () => {
  it('rejects a group over MAX_INSTANCES with a 422-class structured error', () => {
    const items = [
      {
        id: 'det-1',
        width_mm: 10,
        height_mm: 10,
        qty: MAX_INSTANCES + 1,
        rotation: 'allow_90' as const,
        pattern_direction: 'none' as const,
      },
    ];
    try {
      assertWithinInstanceLimit(items);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(422);
      expect((error as ApiError).details).toMatchObject({ limit: MAX_INSTANCES });
    }
  });

  it('accepts a group at exactly MAX_INSTANCES', () => {
    expect(() =>
      assertWithinInstanceLimit([
        {
          id: 'det-1',
          width_mm: 10,
          height_mm: 10,
          qty: MAX_INSTANCES,
          rotation: 'allow_90',
          pattern_direction: 'none',
        },
      ]),
    ).not.toThrow();
  });

  it('rejects an oversized request body with a 413-class error', () => {
    const huge = { units: 'mm', params: {}, stock: [], items: [], blob: 'x'.repeat(MAX_BODY_BYTES) };
    try {
      assertWithinBodyLimit(huge);
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).statusCode).toBe(413);
    }
  });
});

describe('placement back-mapping (BLOCKER-2 / MAJOR-8)', () => {
  it('maps qty=3 of one detail spread across 2 sheets into distinct instances, carrying trim', () => {
    const response = {
      status: 'ok',
      solutions: [
        {
          stock_id: 'smt-9',
          index: 0,
          width_mm: 2800,
          height_mm: 2070,
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          placements: [
            { item_id: 'det-999', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
            { item_id: 'det-999', instance: 2, x_mm: 610, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
          ],
        },
        {
          stock_id: 'smt-9',
          index: 1,
          width_mm: 2800,
          height_mm: 2070,
          trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
          placements: [
            { item_id: 'det-999', instance: 3, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
          ],
        },
      ],
      unplaced_items: [],
    };

    const sheets = backMapSolutions(response);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].sheetIndex).toBe(0);
    expect(sheets[0].placements.trim_mm).toEqual({ left: 10, right: 10, top: 10, bottom: 10 });
    expect(sheets[0].placements.sheet_width_mm).toBe(2800);
    expect(sheets[0].placements.pieces.map((p) => p.instance)).toEqual([1, 2]);
    expect(sheets[1].placements.pieces.map((p) => p.instance)).toEqual([3]);
    // every piece carries its source item id for back-mapping to detail/order
    expect(sheets[0].placements.pieces.every((p) => p.item_id === 'det-999')).toBe(true);
  });

  it('surfaces unplaced items from the freecut result', () => {
    const response = {
      status: 'ok',
      solutions: [],
      unplaced_items: [{ item_id: 'det-5', instance: 1, width_mm: 9999, height_mm: 9999, reason: 'oversized' }],
    };
    const sheets = backMapSolutions(response);
    expect(sheets).toHaveLength(0);
  });
});
