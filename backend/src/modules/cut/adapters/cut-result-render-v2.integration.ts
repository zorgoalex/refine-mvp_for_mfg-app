import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CUT_RENDER_STYLE_DEFAULT, CUT_RENDER_STYLE_TELEGRAM_PHOTO, resolveCutRenderStyle } from '../../../shared/cut-render-style';

// cut_sheet_render_is_complete (migration 231) on a database where 231 is applied. Read-only:
// the function is called with crafted sheets, nothing is written. Opt-in via
// CUT_RENDER_V2_DATABASE_URL (an owned clone; see the cut render parity runner).
const url = process.env.CUT_RENDER_V2_DATABASE_URL;

type Json = Record<string, any>;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

// A real resolved style, as the backend stores it.
const style = JSON.parse(JSON.stringify(resolveCutRenderStyle(CUT_RENDER_STYLE_DEFAULT)));

function validSheet(): Json {
  return {
    sheetIndex: 0,
    placements: {
      sheet_width_mm: 2800,
      sheet_height_mm: 2070,
      trim_mm: { left: 10, right: 10, top: 10, bottom: 10 },
      pieces: [
        { item_id: 'det-1', instance: 1, x_mm: 0, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
        { item_id: 'det-2', instance: 2, x_mm: 620, y_mm: 0, width_mm: 600, height_mm: 400, rotated: false },
      ],
    },
    renderSnapshot: {
      contractVersion: 'cut_sheet_render_v2',
      views: { 'r0:raw:top-left:labels-off': { svg: '<svg/>' } },
      model: {
        renderStyle: clone(style),
        showBathMeterGuides: false,
        pieces: [
          { itemId: 'det-1', instance: 1, label: ['E2E-Тест', '#1', '600×400'], fill: '#123456', bath: { edgeTypeName: 'ПВХ', millingTypeName: null, doweling: true } },
          { itemId: 'det-2', instance: 2, label: ['E2E-Тест', '#2'], fill: null, bath: { edgeTypeName: null, millingTypeName: 'Фреза', doweling: false } },
        ],
      },
      pdfMeta: { orders: [] },
      pdfDetailRows: [],
    },
  };
}

function v1Sheet(): Json {
  const sheet = validSheet();
  const views: Json = {};
  for (const key of [
    'r0:raw:top-left:labels-off', 'r0:raw:top-left:labels-on', 'r0:raw:bottom-left:labels-off', 'r0:raw:bottom-left:labels-on',
    'r90:raw:top-left:labels-off', 'r90:raw:top-left:labels-on', 'r90:raw:bottom-left:labels-off', 'r90:raw:bottom-left:labels-on',
    'r90:tl:top-left:labels-off', 'r90:tl:top-left:labels-on', 'r90:tl:bottom-left:labels-off', 'r90:tl:bottom-left:labels-on',
  ]) views[key] = { svg: '<svg/>', bathSvg: '<svg/>' };
  sheet.renderSnapshot = { contractVersion: 'cut_sheet_render_v1', views, pdfMeta: {}, pdfDetailRows: [] };
  return sheet;
}

describe.skipIf(!url)('cut_sheet_render_is_complete (migration 231)', () => {
  let pool: Pool;
  const check = async (sheet: Json): Promise<boolean> =>
    (await pool.query<{ ok: boolean }>('SELECT public.cut_sheet_render_is_complete($1::jsonb) AS ok', [JSON.stringify(sheet)])).rows[0].ok;

  beforeAll(() => {
    pool = new Pool({ connectionString: url, max: 1 });
  });
  afterAll(async () => {
    await pool?.end();
  });

  it('accepts a complete v2 sheet, a v2 sheet without a style, and a v1 sheet', async () => {
    expect(await check(validSheet())).toBe(true);
    const noStyle = validSheet();
    noStyle.renderSnapshot.model.renderStyle = null;
    expect(await check(noStyle)).toBe(true);
    const telegram = validSheet();
    telegram.renderSnapshot.model.renderStyle = JSON.parse(JSON.stringify(resolveCutRenderStyle(CUT_RENDER_STYLE_TELEGRAM_PHOTO)));
    expect(await check(telegram)).toBe(true);
    const shortHex = validSheet();
    shortHex.renderSnapshot.model.renderStyle.piece.defaultFill = '#fff';
    expect(await check(shortHex)).toBe(true);
    const bounds = validSheet();
    Object.assign(bounds.renderSnapshot.model.renderStyle.label, { fontWeight: 1000, letterSpacingRatio: -0.2 });
    bounds.renderSnapshot.model.renderStyle.sourceSvg.minStrokePx = 20;
    expect(await check(bounds)).toBe(true);
    expect(await check(v1Sheet())).toBe(true);
  });

  it('keeps the v1 rule: twelve views', async () => {
    const sheet = v1Sheet();
    delete sheet.renderSnapshot.views['r90:tl:bottom-left:labels-on'];
    expect(await check(sheet)).toBe(false);
  });

  const broken: Array<[string, (sheet: Json) => void]> = [
    ['unknown contract', (s) => { s.renderSnapshot.contractVersion = 'cut_sheet_render_v3'; }],
    ['an extra top-level field', (s) => { s.renderSnapshot.extra = 1; }],
    ['no pdfMeta', (s) => { delete s.renderSnapshot.pdfMeta; }],
    ['pdfDetailRows not an array', (s) => { s.renderSnapshot.pdfDetailRows = {}; }],
    ['an extra view', (s) => { s.renderSnapshot.views['r0:raw:top-left:labels-on'] = { svg: '<svg/>' }; }],
    ['no label-free view', (s) => { s.renderSnapshot.views = { 'r0:raw:top-left:labels-on': { svg: '<svg/>' } }; }],
    ['a stored bath SVG', (s) => { s.renderSnapshot.views['r0:raw:top-left:labels-off'].bathSvg = '<svg/>'; }],
    ['an empty stored SVG', (s) => { s.renderSnapshot.views['r0:raw:top-left:labels-off'].svg = ''; }],
    ['no model', (s) => { delete s.renderSnapshot.model; }],
    ['an extra model field', (s) => { s.renderSnapshot.model.extra = true; }],
    ['a style that is not an object', (s) => { s.renderSnapshot.model.renderStyle = 'default'; }],
    ['a style without its sections', (s) => { delete s.renderSnapshot.model.renderStyle.sourceSvg; }],
    ['a numeric piece colour in the style', (s) => { s.renderSnapshot.model.renderStyle.piece.defaultFill = 7; }],
    ['a style colour that is not a colour', (s) => { s.renderSnapshot.model.renderStyle.label.darkFill = 'red'; }],
    ['a style field missing', (s) => { delete s.renderSnapshot.model.renderStyle.label.fontWeight; }],
    ['an extra style field', (s) => { s.renderSnapshot.model.renderStyle.piece.extra = '#fff'; }],
    ['an unknown fill strategy', (s) => { s.renderSnapshot.model.renderStyle.label.fillStrategy = 'rainbow'; }],
    ['an unknown stroke colour mode', (s) => { s.renderSnapshot.model.renderStyle.sourceSvg.strokeColorMode = 'neon'; }],
    ['a text minimum stroke', (s) => { s.renderSnapshot.model.renderStyle.sourceSvg.minStrokePx = '1'; }],
    ['a text boolean in the style', (s) => { s.renderSnapshot.model.renderStyle.sourceSvg.nonScalingStroke = 'true'; }],
    ['a non-colour palette entry', (s) => { s.renderSnapshot.model.renderStyle.piece.orderPalette = ['#fff', 3]; }],
    ['an unknown style id', (s) => { s.renderSnapshot.model.renderStyle.id = 'custom'; }],
    ['a null fill strategy', (s) => { s.renderSnapshot.model.renderStyle.label.fillStrategy = null; }],
    ['a null stroke colour mode', (s) => { s.renderSnapshot.model.renderStyle.sourceSvg.strokeColorMode = null; }],
    ['a raw screenshot section with a wrong key', (s) => { s.renderSnapshot.model.renderStyle.rawSvgScreenshot = { wrong: 1 }; }],
    ['a negative stroke width', (s) => { s.renderSnapshot.model.renderStyle.piece.strokeWidthMm = -1; }],
    ['an empty palette', (s) => { s.renderSnapshot.model.renderStyle.piece.orderPalette = []; }],
    ['a palette of 25 colours', (s) => { s.renderSnapshot.model.renderStyle.piece.orderPalette = Array(25).fill('#123456'); }],
    ['a fractional font weight', (s) => { s.renderSnapshot.model.renderStyle.label.fontWeight = 450.5; }],
    ['a font weight out of range', (s) => { s.renderSnapshot.model.renderStyle.label.fontWeight = 1200; }],
    ['a letter spacing out of range', (s) => { s.renderSnapshot.model.renderStyle.label.letterSpacingRatio = 0.5; }],
    ['a null style colour', (s) => { s.renderSnapshot.model.renderStyle.piece.stroke = null; }],
    ['a null raw screenshot stroke', (s) => { s.renderSnapshot.model.renderStyle.rawSvgScreenshot.minStrokePx = null; }],
    ['a raw screenshot section with extra fields', (s) => { s.renderSnapshot.model.renderStyle.rawSvgScreenshot.extra = 1; }],
    ['a non-boolean guide flag', (s) => { s.renderSnapshot.model.showBathMeterGuides = 'false'; }],
    ['pieces not an array', (s) => { s.renderSnapshot.model.pieces = {}; }],
    ['a piece missing from the model', (s) => { s.renderSnapshot.model.pieces.pop(); }],
    ['a model piece not on the sheet', (s) => { s.renderSnapshot.model.pieces[1].instance = 3; }],
    ['a duplicated model piece', (s) => { s.renderSnapshot.model.pieces.push(clone(s.renderSnapshot.model.pieces[0])); }],
    ['an extra piece field', (s) => { s.renderSnapshot.model.pieces[0].extra = 1; }],
    ['an empty itemId', (s) => { s.renderSnapshot.model.pieces[0].itemId = ''; }],
    ['instance zero', (s) => { s.renderSnapshot.model.pieces[0].instance = 0; }],
    ['a fractional instance', (s) => { s.renderSnapshot.model.pieces[0].instance = 1.5; }],
    ['a label that is not an array', (s) => { s.renderSnapshot.model.pieces[0].label = 'E2E-Тест'; }],
    ['a label line that is not text', (s) => { s.renderSnapshot.model.pieces[0].label = ['E2E-Тест', 2]; }],
    ['a numeric fill', (s) => { s.renderSnapshot.model.pieces[0].fill = 7; }],
    ['a missing fill', (s) => { delete s.renderSnapshot.model.pieces[0].fill; }],
    ['bath without doweling', (s) => { delete s.renderSnapshot.model.pieces[0].bath.doweling; }],
    ['a non-boolean doweling', (s) => { s.renderSnapshot.model.pieces[0].bath.doweling = 'true'; }],
    ['a numeric edge type', (s) => { s.renderSnapshot.model.pieces[0].bath.edgeTypeName = 5; }],
    ['an extra bath field', (s) => { s.renderSnapshot.model.pieces[0].bath.extra = null; }],
  ];
  it.each(broken)('rejects %s', async (_label, breakSheet) => {
    const sheet = validSheet();
    breakSheet(sheet);
    expect(await check(sheet)).toBe(false);
  });
});
