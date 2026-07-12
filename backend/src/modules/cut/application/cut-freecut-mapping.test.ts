import { describe, expect, it } from 'vitest';
import { ApiError } from '../../../common/errors/api-error';
import {
  type FreecutRotation,
  MAX_BODY_BYTES,
  MAX_INSTANCES,
  assertWithinBodyLimit,
  assertWithinInstanceLimit,
  backMapSolutions,
  buildOptimizeRequest,
  grainRuleForFilm,
  orientItemsForVacuumDirection,
  resolveVacuumDirection,
  validateGrainRule,
  validateFreecutResponseContract,
} from './cut-freecut-mapping';

describe('Freecut response runtime contract', () => {
  const request = buildOptimizeRequest({
    stock: { id: 'stock-1', width_mm: 1000, height_mm: 500 },
    items: [{ id: 'det-1', width_mm: 100, height_mm: 50, qty: 2, rotation: 'allow_90', pattern_direction: 'none' }],
    params: { kerf_mm: 6.5, spacing_mm: 0, trim_mm: { left: 10, right: 10, top: 10, bottom: 10 }, objective: 'min_waste' },
  });
  const valid = () => ({
    status: 'ok',
    solutions: [{
      stock_id: 'stock-1', index: 0, width_mm: 1000, height_mm: 500,
      trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
      placements: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 100, height_mm: 50, rotated: false }],
    }],
    unplaced_items: [{ item_id: 'det-1', instance: 2, reason: 'not_fit' }],
  });

  it('accepts an exact placed/unplaced partition', () => {
    expect(validateFreecutResponseContract(request, valid())).toEqual([]);
  });

  it.each([
    ['unknown instance', (r: ReturnType<typeof valid>) => { r.solutions[0].placements[0].item_id = 'det-999'; }, 'unknown_instance'],
    ['duplicate instance', (r: ReturnType<typeof valid>) => { r.unplaced_items[0].instance = 1; }, 'duplicate_instance'],
    ['missing instance', (r: ReturnType<typeof valid>) => { r.unplaced_items = []; }, 'missing_instance'],
    ['wrong rotated dimensions', (r: ReturnType<typeof valid>) => { r.solutions[0].placements[0].rotated = true; }, 'piece_width_mismatch'],
    ['non-finite number', (r: ReturnType<typeof valid>) => { r.solutions[0].placements[0].x_mm = Number.NaN; }, 'invalid_number'],
    ['wrong sheet dimensions', (r: ReturnType<typeof valid>) => { r.solutions[0].width_mm = 999; }, 'sheet_width_mismatch'],
    ['wrong trim', (r: ReturnType<typeof valid>) => { r.solutions[0].trim_mm.left = 9; }, 'trim_mismatch'],
    ['duplicate sheet index', (r: ReturnType<typeof valid>) => { r.solutions.push({ ...r.solutions[0], placements: [], trim_mm: { ...r.solutions[0].trim_mm } }); }, 'duplicate_sheet_index'],
    ['non-ok status', (r: ReturnType<typeof valid>) => { r.status = 'error'; }, 'invalid_status'],
    ['string instance', (r: ReturnType<typeof valid>) => { (r.solutions[0].placements[0] as unknown as { instance: string }).instance = '1'; }, 'invalid_instance'],
  ])('rejects %s', (_name, mutate, code) => {
    const response = valid();
    mutate(response);
    expect(validateFreecutResponseContract(request, response).map((v) => v.code)).toContain(code);
  });
});

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

  it('forwards vacuum layout mode and direction from params to optimize request', () => {
    const request = buildOptimizeRequest({
      stock,
      items,
      params: {
        ...params,
        layout_mode: 'vacuum_table',
        vacuum: { direction: 'optimal' },
      },
    });
    expect(request.params.layout_mode).toBe('vacuum_table');
    expect(request.params.vacuum?.direction).toBe('optimal');
  });

  it('normalizes landscape stock, items, grain and asymmetric trim to portrait axes', () => {
    const request = buildOptimizeRequest({
      stock,
      items: [{ ...items[0], pattern_direction: 'along_width' }],
      params: { ...params, trim_mm: { left: 1, right: 2, top: 3, bottom: 4 } },
      nativePortrait: true,
    });
    expect(request.stock[0]).toMatchObject({ width_mm: 2070, height_mm: 2800 });
    expect(request.items[0]).toMatchObject({ width_mm: 400, height_mm: 600, pattern_direction: 'along_height' });
    expect(request.params.trim_mm).toEqual({ left: 3, right: 4, top: 1, bottom: 2 });
    expect(stock).toEqual({ id: 'smt-9', width_mm: 2800, height_mm: 2070 });
  });

  it('leaves already portrait stock byte-equivalent apart from include_svg', () => {
    const portraitStock = { ...stock, width_mm: 2070, height_mm: 2800 };
    expect(buildOptimizeRequest({ stock: portraitStock, items, params, nativePortrait: true }))
      .toEqual(buildOptimizeRequest({ stock: portraitStock, items, params }));
  });

  it.each([
    ['width', 'height', 400, 600],
    ['height', 'width', 600, 400],
    ['optimal', 'optimal', 400, 600],
  ] as const)('preserves vacuum %s physical intent after portrait transpose', (intent, expectedAxis, expectedW, expectedH) => {
    const request = buildOptimizeRequest({
      stock,
      items,
      params: { ...params, layout_mode: 'vacuum_table', vacuum: { direction: intent } },
      nativePortrait: true,
    });
    expect(request.params.vacuum?.direction).toBe(expectedAxis);
    expect(request.items[0]).toMatchObject({ width_mm: expectedW, height_mm: expectedH });
  });

  it('keeps transposed textured grain authoritative over vacuum orientation', () => {
    const request = buildOptimizeRequest({
      stock,
      items: [{ ...items[0], rotation: 'forbid', pattern_direction: 'along_height' }],
      params: { ...params, layout_mode: 'vacuum_table', vacuum: { direction: 'height' } },
      nativePortrait: true,
    });
    expect(request.items[0]).toMatchObject({ width_mm: 400, height_mm: 600, rotation: 'forbid', pattern_direction: 'along_width' });
  });
});

describe('native portrait persistence metadata', () => {
  const response = {
    status: 'ok',
    solutions: [{ stock_id: 's', index: 0, width_mm: 2070, height_mm: 2800,
      trim_mm: { left: 3, right: 4, top: 1, bottom: 2 },
      placements: [{ item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 400, height_mm: 600, rotated: false }] }],
  };
  const requestItems = [{ id: 'det-1', width_mm: 400, height_mm: 600, qty: 1, rotation: 'forbid' as const, pattern_direction: 'along_width' as const }];

  it('writes marker and frozen rotation rule only when explicitly requested', () => {
    const native = backMapSolutions(response, { coordinateContract: 'native_portrait_v1', requestItems })[0].placements;
    expect(native.coordinate_contract).toBe('native_portrait_v1');
    expect(native.pieces[0].rotation_forbidden).toBe(true);
    const legacy = backMapSolutions(response)[0].placements;
    expect(legacy.coordinate_contract).toBeUndefined();
    expect(legacy.pieces[0].rotation_forbidden).toBeUndefined();
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

describe('resolveVacuumDirection — orientation-aware long/short-side mapping', () => {
  it('portrait stock (w=1050,h=2080): width→height (long axis is height), height→width', () => {
    expect(resolveVacuumDirection('width', 1050, 2080)).toBe('height');
    expect(resolveVacuumDirection('height', 1050, 2080)).toBe('width');
  });

  it('landscape stock (w=2800,h=2070): width→width, height→height (no change — no regression)', () => {
    expect(resolveVacuumDirection('width', 2800, 2070)).toBe('width');
    expect(resolveVacuumDirection('height', 2800, 2070)).toBe('height');
  });

  it('optimal passes through unchanged regardless of dims', () => {
    expect(resolveVacuumDirection('optimal', 1050, 2080)).toBe('optimal');
    expect(resolveVacuumDirection('optimal', 2800, 2070)).toBe('optimal');
  });

  it('undefined passes through unchanged regardless of dims', () => {
    expect(resolveVacuumDirection(undefined, 1050, 2080)).toBeUndefined();
    expect(resolveVacuumDirection(undefined, 2800, 2070)).toBeUndefined();
  });

  it('square stock (w==h): longIsWidth=true → width→width, height→height', () => {
    expect(resolveVacuumDirection('width', 1500, 1500)).toBe('width');
    expect(resolveVacuumDirection('height', 1500, 1500)).toBe('height');
  });
});

describe('orientItemsForVacuumDirection — force plain-detail orientation for vacuum profiles', () => {
  const plainItem = (w: number, h: number, rot: FreecutRotation = 'allow_90') => ({
    id: 'det-1', width_mm: w, height_mm: h, qty: 2, rotation: rot,
    pattern_direction: 'none' as const,
  });
  const texturedItem = (w: number, h: number) => ({
    id: 'det-2', width_mm: w, height_mm: h, qty: 1, rotation: 'forbid' as const,
    pattern_direction: 'along_height' as const,
  });

  it('portrait stock (w1050,h2080), width (по длине): plain 707×407 → 407×707 forbid (long edge along Y=long)', () => {
    const result = orientItemsForVacuumDirection([plainItem(707, 407)], 1050, 2080, 'width');
    expect(result[0]).toMatchObject({ width_mm: 407, height_mm: 707, rotation: 'forbid' });
  });

  it('portrait stock (w1050,h2080), height (по ширине): plain 707×407 → 707×407 forbid (long edge along X=short)', () => {
    const result = orientItemsForVacuumDirection([plainItem(707, 407)], 1050, 2080, 'height');
    expect(result[0]).toMatchObject({ width_mm: 707, height_mm: 407, rotation: 'forbid' });
  });

  it('landscape stock (w2800,h2070), width (по длине): plain 707×407 → 707×407 forbid (long edge along X=long)', () => {
    const result = orientItemsForVacuumDirection([plainItem(707, 407)], 2800, 2070, 'width');
    expect(result[0]).toMatchObject({ width_mm: 707, height_mm: 407, rotation: 'forbid' });
  });

  it('landscape stock (w2800,h2070), height (по ширине): plain 707×407 → 407×707 forbid (long edge along Y=short)', () => {
    const result = orientItemsForVacuumDirection([plainItem(707, 407)], 2800, 2070, 'height');
    expect(result[0]).toMatchObject({ width_mm: 407, height_mm: 707, rotation: 'forbid' });
  });

  it('textured item (along_height) with directional vacuum → returned UNCHANGED (grain wins)', () => {
    const item = texturedItem(707, 407);
    const result = orientItemsForVacuumDirection([item], 1050, 2080, 'width');
    expect(result[0]).toEqual(item);
  });

  it('optimal direction → items unchanged (rotation stays as input)', () => {
    const item = plainItem(707, 407, 'allow_90');
    const result = orientItemsForVacuumDirection([item], 1050, 2080, 'optimal');
    expect(result[0]).toEqual(item);
  });

  it('undefined direction → items unchanged', () => {
    const item = plainItem(707, 407, 'allow_90');
    const result = orientItemsForVacuumDirection([item], 1050, 2080, undefined);
    expect(result[0]).toEqual(item);
  });

  it('square plain item (500×500), width → forbid, dims 500×500', () => {
    const result = orientItemsForVacuumDirection([plainItem(500, 500)], 2800, 2070, 'width');
    expect(result[0]).toMatchObject({ width_mm: 500, height_mm: 500, rotation: 'forbid' });
  });
});

describe('buildOptimizeRequest vacuum direction resolution integration', () => {
  const items = [
    {
      id: 'det-1',
      width_mm: 600,
      height_mm: 400,
      qty: 1,
      rotation: 'allow_90' as const,
      pattern_direction: 'none' as const,
    },
  ];
  const baseParams = {
    kerf_mm: 2,
    spacing_mm: 1,
    trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
    objective: 'min_waste' as const,
  };

  it('vacuum_table + portrait stock + direction=width → outgoing direction=height (inverted sheet fix)', () => {
    const portraitStock = { id: 'smt-portrait', width_mm: 1050, height_mm: 2080 };
    const inputParams = { ...baseParams, layout_mode: 'vacuum_table' as const, vacuum: { direction: 'width' as const } };
    const request = buildOptimizeRequest({ stock: portraitStock, items, params: inputParams });
    expect(request.params.vacuum?.direction).toBe('height');
    // input.params must NOT be mutated
    expect(inputParams.vacuum.direction).toBe('width');
  });

  it('vacuum_table + landscape stock + direction=width → outgoing direction=width (unchanged)', () => {
    const landscapeStock = { id: 'smt-landscape', width_mm: 2800, height_mm: 2070 };
    const request = buildOptimizeRequest({
      stock: landscapeStock,
      items,
      params: { ...baseParams, layout_mode: 'vacuum_table', vacuum: { direction: 'width' } },
    });
    expect(request.params.vacuum?.direction).toBe('width');
  });

  it('non-vacuum layout (guillotine) with no vacuum → params.vacuum stays undefined', () => {
    const stock = { id: 'smt-9', width_mm: 2800, height_mm: 2070 };
    const request = buildOptimizeRequest({
      stock,
      items,
      params: { ...baseParams, layout_mode: 'guillotine' },
    });
    expect(request.params.vacuum).toBeUndefined();
  });

  it('vacuum_table + portrait stock + width: plain item re-oriented + forbid; textured untouched; input.items NOT mutated', () => {
    const portraitStock = { id: 'smt-portrait', width_mm: 1050, height_mm: 2080 };
    const plainItem = { id: 'det-10', width_mm: 707, height_mm: 407, qty: 2, rotation: 'allow_90' as const, pattern_direction: 'none' as const };
    const texturedItem = { id: 'det-11', width_mm: 900, height_mm: 300, qty: 1, rotation: 'forbid' as const, pattern_direction: 'along_height' as const };
    const inputItems = [plainItem, texturedItem];
    const inputParams = { ...baseParams, layout_mode: 'vacuum_table' as const, vacuum: { direction: 'width' as const } };

    const request = buildOptimizeRequest({ stock: portraitStock, items: inputItems, params: inputParams });

    // plain item: portrait w=1050<h=2080 so longAxisIsX=false; width→longEdgeAlongX=false → width_mm=407, height_mm=707
    expect(request.items[0]).toMatchObject({ id: 'det-10', width_mm: 407, height_mm: 707, rotation: 'forbid' });
    // textured: unchanged
    expect(request.items[1]).toEqual(texturedItem);
    // input.items must NOT be mutated
    expect(inputItems[0].width_mm).toBe(707);
    expect(inputItems[0].rotation).toBe('allow_90');
  });

  it('guillotine layout → items pass through unchanged (no orientation applied)', () => {
    const stock = { id: 'smt-9', width_mm: 1050, height_mm: 2080 };
    const plainItem = { id: 'det-20', width_mm: 707, height_mm: 407, qty: 1, rotation: 'allow_90' as const, pattern_direction: 'none' as const };
    const request = buildOptimizeRequest({
      stock,
      items: [plainItem],
      params: { ...baseParams, layout_mode: 'guillotine' },
    });
    expect(request.items[0]).toEqual(plainItem);
  });
});
