import { describe, expect, it } from 'vitest';
import {
  CUT_RENDER_STYLE_DEFAULT,
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  CUT_RENDER_STYLE_TELEGRAM_PHOTO,
  CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW,
  cutRenderStyleRuleProblem,
  resolveCutRenderStyle,
  type CutRenderStyleRule,
} from '../../../shared/cut-render-style';
import type { FreecutPlacement, SheetPlacementsJson } from '../application/cut-freecut-mapping';
import {
  buildFrozenSheetRenderModel,
  FROZEN_SHEET_RENDER_V2,
  FROZEN_SHEET_STORED_VIEW_KEY,
  FROZEN_SHEET_VIEWS,
  FrozenSheetModelError,
  frozenSheetRenderProblem,
  frozenSheetView,
  frozenSheetViewKey,
  renderFrozenSheetView,
  type FrozenSheetRenderModel,
  type FrozenSheetView,
} from './frozen-sheet-render';
import { buildBathProfileSheetSvg, buildSheetSvg, type BathPieceDetailInfo } from './sheet-svg';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function sheet(extra: Partial<SheetPlacementsJson> = {}): SheetPlacementsJson {
  return {
    sheet_width_mm: 2800,
    sheet_height_mm: 2070,
    trim_mm: { left: 10, right: 12, top: 8, bottom: 6 },
    pieces: [
      { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false,
        label: { orderId: 11, orderName: 'E2E-Тест А', detailNumber: 1, widthMm: 600, heightMm: 400 } },
      { item_id: 'det-1', instance: 2, x_mm: 620, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false,
        label: { orderId: 11, orderName: 'E2E-Тест А', detailNumber: 1, widthMm: 600, heightMm: 400 } },
      { item_id: 'det-2', instance: 1, x_mm: 0, y_mm: 420, width_mm: 300, height_mm: 900, rotated: true,
        label: { orderId: 12, orderName: 'E2E-Тест Б', detailNumber: 7, widthMm: 900, heightMm: 300 } },
      { item_id: 'svg-3', instance: 1, x_mm: 1300, y_mm: 500, width_mm: 250, height_mm: 250, rotated: false },
    ] as unknown as FreecutPlacement[],
    renderOnlyContours: [
      { sourceElementId: 'E2E-контур', xMm: 2000, yMm: 1500, placedWidthMm: 200, placedHeightMm: 100, labelLines: ['# Test'] },
    ],
    ...extra,
  } as SheetPlacementsJson;
}

// The callbacks a writer passes today, in both writer flavours (string and array labels, a null
// fill, absent bath names, doweling on one piece).
const labelFor = (piece: FreecutPlacement): string | string[] =>
  piece.item_id === 'svg-3' ? 'Без заказа' : [`E2E-${piece.item_id}`, `#${piece.instance}`, '600×400', 'МДФ 16'];
const fillFor = (piece: FreecutPlacement): string | null | undefined =>
  piece.item_id === 'det-1' ? '#aa3300' : piece.item_id === 'det-2' ? null : undefined;
const bathDetailInfoFor = (piece: FreecutPlacement): BathPieceDetailInfo =>
  piece.item_id === 'det-1'
    ? { edgeTypeName: 'ПВХ 2 мм', millingTypeName: 'Фреза R3', doweling: true }
    : piece.item_id === 'det-2'
      ? { edgeTypeName: '  ', millingTypeName: null, doweling: false }
      : { edgeTypeName: null, millingTypeName: null, doweling: null };

/** What the live renderer drew before contract v2 (pg-cut-repository loadGroupRenderContext). */
function liveReference(input: {
  sheet: SheetPlacementsJson; view: FrozenSheetView; renderStyle: CutRenderStyleRule; showBathMeterGuides: boolean;
}) {
  return {
    svg: buildSheetSvg({
      sheet: input.sheet, labelFor, fillFor, rotate90: input.view.rotate90, originTopLeft: input.view.originTopLeft,
      axisOrigin: input.view.axisOrigin, showLabels: input.view.showLabels,
      showBathMeterGuides: input.showBathMeterGuides, renderStyle: input.renderStyle,
    }),
    bathSvg: buildBathProfileSheetSvg({
      sheet: input.sheet, labelFor, bathDetailInfoFor, fillFor, rotate90: input.view.rotate90,
      originTopLeft: input.view.originTopLeft, axisOrigin: input.view.axisOrigin,
      showBathMeterGuides: input.showBathMeterGuides, renderStyle: input.renderStyle,
    }),
  };
}

/** What the SVG-import writer stored before contract v2 (buildSvgRenderSnapshot v1 loop). */
function svgImportReference(input: { sheet: SheetPlacementsJson; view: FrozenSheetView }) {
  return {
    svg: buildSheetSvg({
      sheet: input.sheet, labelFor, fillFor, rotate90: input.view.rotate90, originTopLeft: input.view.originTopLeft,
      axisOrigin: input.view.axisOrigin, showLabels: input.view.showLabels,
    }),
    bathSvg: buildBathProfileSheetSvg({
      sheet: input.sheet, labelFor, fillFor, bathDetailInfoFor, rotate90: input.view.rotate90,
      originTopLeft: input.view.originTopLeft, axisOrigin: input.view.axisOrigin, showLabels: true,
    }),
  };
}

const RAW_VIEWS: FrozenSheetView[] = [
  ...FROZEN_SHEET_VIEWS,
  // The live path passes the top-left flag through even for unrotated views.
  { rotate90: false, originTopLeft: true, axisOrigin: 'top-left', showLabels: true },
  { rotate90: false, originTopLeft: true, axisOrigin: 'bottom-left', showLabels: false },
];

describe('frozen sheet render (contract v2)', () => {
  it('lists the twelve v1 views with their v1 keys', () => {
    expect(FROZEN_SHEET_VIEWS.map(frozenSheetViewKey)).toEqual([
      'r0:raw:top-left:labels-off', 'r0:raw:top-left:labels-on', 'r0:raw:bottom-left:labels-off', 'r0:raw:bottom-left:labels-on',
      'r90:raw:top-left:labels-off', 'r90:raw:top-left:labels-on', 'r90:raw:bottom-left:labels-off', 'r90:raw:bottom-left:labels-on',
      'r90:tl:top-left:labels-off', 'r90:tl:top-left:labels-on', 'r90:tl:bottom-left:labels-off', 'r90:tl:bottom-left:labels-on',
    ]);
    expect(FROZEN_SHEET_STORED_VIEW_KEY).toBe('r0:raw:top-left:labels-off');
    expect(frozenSheetView({})).toEqual({ rotate90: false, originTopLeft: false, axisOrigin: 'top-left', showLabels: true });
    expect(frozenSheetView({ originTopLeft: true, showLabels: false }))
      .toEqual({ rotate90: false, originTopLeft: false, axisOrigin: 'top-left', showLabels: false });
  });

  for (const styleName of [CUT_RENDER_STYLE_DEFAULT, CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW, CUT_RENDER_STYLE_TELEGRAM_PHOTO]) {
    for (const showBathMeterGuides of [false, true]) {
      for (const native of [false, true]) {
        it(`live renderer: a stored model draws every view byte-for-byte (${styleName}, guides ${showBathMeterGuides}, native ${native})`, () => {
          const renderStyle = resolveCutRenderStyle(styleName);
          const placements = sheet(native ? { coordinate_contract: 'native_portrait_v1' } as Partial<SheetPlacementsJson> : {});
          const model = roundTrip(buildFrozenSheetRenderModel({
            sheet: placements, labelFor, fillFor, bathDetailInfoFor, renderStyle, showBathMeterGuides,
          }));
          const storedSheet = roundTrip(placements);
          for (const view of RAW_VIEWS) {
            expect(renderFrozenSheetView(storedSheet, model, view)).toEqual(
              liveReference({ sheet: placements, view, renderStyle, showBathMeterGuides }),
            );
          }
        });
      }
    }
  }

  it('SVG-import writer: a stored model draws every v1 view byte-for-byte', () => {
    const placements = sheet();
    const model = roundTrip(buildFrozenSheetRenderModel({
      sheet: placements, labelFor, fillFor, bathDetailInfoFor, renderStyle: null, showBathMeterGuides: false,
    }));
    for (const view of FROZEN_SHEET_VIEWS) {
      expect(renderFrozenSheetView(roundTrip(placements), model, view)).toEqual(svgImportReference({ sheet: placements, view }));
    }
  });

  it('keeps only real pieces in the model; render-only contours draw without it', () => {
    const placements = sheet();
    const model = buildFrozenSheetRenderModel({
      sheet: placements, labelFor, fillFor, bathDetailInfoFor, renderStyle: null, showBathMeterGuides: false,
    });
    expect(model.pieces.map((piece) => `${piece.itemId}#${piece.instance}`)).toEqual(['det-1#1', 'det-1#2', 'det-2#1', 'svg-3#1']);
    expect(model.pieces[3]).toEqual({
      itemId: 'svg-3', instance: 1, label: ['Без заказа'], fill: null,
      bath: { edgeTypeName: null, millingTypeName: null, doweling: false },
    });
    const svg = renderFrozenSheetView(placements, model, FROZEN_SHEET_VIEWS[1]).svg;
    expect(svg).toContain('# Test');
  });

  it('refuses to draw a piece the model does not know, instead of drawing a default', () => {
    const placements = sheet();
    const model = buildFrozenSheetRenderModel({
      sheet: placements, labelFor, fillFor, bathDetailInfoFor, renderStyle: null, showBathMeterGuides: false,
    });
    const incomplete: FrozenSheetRenderModel = { ...model, pieces: model.pieces.slice(1) };
    expect(() => renderFrozenSheetView(placements, incomplete, FROZEN_SHEET_VIEWS[0])).toThrow(FrozenSheetModelError);
  });

  it.each([
    ['a duplicated piece', { sheet: { ...sheet(), pieces: [...sheet().pieces, sheet().pieces[0]] } }],
    ['a label line that is not text', { labelFor: () => ['E2E', 3 as unknown as string] }],
    ['a fill that is not text', { fillFor: () => 5 as unknown as string }],
    ['a bath name that is not text', { bathDetailInfoFor: () => ({ edgeTypeName: 4 as unknown as string }) }],
  ])('refuses to build a model with %s', (_label, override) => {
    expect(() => buildFrozenSheetRenderModel({
      sheet: sheet(), labelFor, fillFor, bathDetailInfoFor, renderStyle: null, showBathMeterGuides: false,
      ...(override as object),
    })).toThrow(FrozenSheetModelError);
  });
});

describe('stored render styles', () => {
  it.each([CUT_RENDER_STYLE_DEFAULT, CUT_RENDER_STYLE_MDF_BOARD_PREVIEW, CUT_RENDER_STYLE_VACUUM_TASK_PREVIEW, CUT_RENDER_STYLE_TELEGRAM_PHOTO])(
    'every built-in resolved style is a complete stored style: %s', (name) => {
      expect(cutRenderStyleRuleProblem(roundTrip(resolveCutRenderStyle(name)))).toBeNull();
    },
  );
});

describe('frozenSheetRenderProblem', () => {
  const placements = sheet();
  const valid = () => roundTrip({
    contractVersion: FROZEN_SHEET_RENDER_V2,
    views: { [FROZEN_SHEET_STORED_VIEW_KEY]: { svg: '<svg/>' } },
    model: buildFrozenSheetRenderModel({
      sheet: placements, labelFor, fillFor, bathDetailInfoFor,
      renderStyle: resolveCutRenderStyle(CUT_RENDER_STYLE_DEFAULT), showBathMeterGuides: true,
    }),
    pdfMeta: {},
    pdfDetailRows: [],
  }) as Record<string, any>;

  it('accepts a complete v2 render and a v1 render with twelve views', () => {
    expect(frozenSheetRenderProblem(valid(), placements)).toBeNull();
    const v1 = {
      contractVersion: 'cut_sheet_render_v1',
      views: Object.fromEntries(FROZEN_SHEET_VIEWS.map((view) => [frozenSheetViewKey(view), { svg: 'a', bathSvg: 'b' }])),
      pdfMeta: {},
      pdfDetailRows: [],
    };
    expect(frozenSheetRenderProblem(v1, placements)).toBeNull();
    expect(frozenSheetRenderProblem({ ...v1, views: { a: { svg: 'a', bathSvg: 'b' } } }, placements)).not.toBeNull();
  });

  it.each<[string, (render: Record<string, any>) => void]>([
    ['unknown contract', (r) => { r.contractVersion = 'cut_sheet_render_v3'; }],
    ['an extra field', (r) => { r.extra = 1; }],
    ['an extra view', (r) => { r.views['r0:raw:top-left:labels-on'] = { svg: '<svg/>' }; }],
    ['a stored bath SVG', (r) => { r.views[FROZEN_SHEET_STORED_VIEW_KEY].bathSvg = '<svg/>'; }],
    ['an empty stored SVG', (r) => { r.views[FROZEN_SHEET_STORED_VIEW_KEY].svg = ''; }],
    ['no model', (r) => { delete r.model; }],
    ['a style without sections', (r) => { delete r.model.renderStyle.label; }],
    ['a numeric piece colour in the style', (r) => { r.model.renderStyle.piece.defaultFill = 7; }],
    ['a style field missing', (r) => { delete r.model.renderStyle.label.fontWeight; }],
    ['an extra style field', (r) => { r.model.renderStyle.piece.extra = '#fff'; }],
    ['an unknown fill strategy', (r) => { r.model.renderStyle.label.fillStrategy = 'rainbow'; }],
    ['a text minimum stroke', (r) => { r.model.renderStyle.sourceSvg.minStrokePx = '1'; }],
    ['a non-colour palette entry', (r) => { r.model.renderStyle.piece.orderPalette = ['#fff', 3]; }],
    ['an unknown style id', (r) => { r.model.renderStyle.id = 'custom'; }],
    ['a null fill strategy', (r) => { r.model.renderStyle.label.fillStrategy = null; }],
    ['a null stroke colour mode', (r) => { r.model.renderStyle.sourceSvg.strokeColorMode = null; }],
    ['a raw screenshot section with a wrong key', (r) => { r.model.renderStyle.rawSvgScreenshot = { wrong: 1 }; }],
    ['a negative stroke width', (r) => { r.model.renderStyle.piece.strokeWidthMm = -1; }],
    ['an empty palette', (r) => { r.model.renderStyle.piece.orderPalette = []; }],
    ['a palette of 25 colours', (r) => { r.model.renderStyle.piece.orderPalette = Array(25).fill('#123456'); }],
    ['a fractional font weight', (r) => { r.model.renderStyle.label.fontWeight = 450.5; }],
    ['a letter spacing out of range', (r) => { r.model.renderStyle.label.letterSpacingRatio = 0.5; }],
    ['a null style colour', (r) => { r.model.renderStyle.piece.stroke = null; }],
    ['a string guide flag', (r) => { r.model.showBathMeterGuides = 'true'; }],
    ['a missing piece', (r) => { r.model.pieces.pop(); }],
    ['a foreign piece', (r) => { r.model.pieces[0].itemId = 'det-9'; }],
    ['a duplicated piece', (r) => { r.model.pieces.push({ ...r.model.pieces[0] }); }],
    ['instance zero', (r) => { r.model.pieces[0].instance = 0; }],
    ['a string label', (r) => { r.model.pieces[0].label = 'E2E'; }],
    ['a numeric fill', (r) => { r.model.pieces[0].fill = 1; }],
    ['a missing doweling', (r) => { delete r.model.pieces[0].bath.doweling; }],
    ['a numeric edge type', (r) => { r.model.pieces[0].bath.edgeTypeName = 2; }],
    ['no pdfDetailRows', (r) => { delete r.pdfDetailRows; }],
  ])('rejects %s', (_label, breakRender) => {
    const render = valid();
    breakRender(render);
    expect(frozenSheetRenderProblem(render, placements)).not.toBeNull();
  });
});
