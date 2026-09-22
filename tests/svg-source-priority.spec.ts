import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { buildStyledSvgUploadPreview, buildStyledCutLayoutPreview } from '../src/pages/cut/svgCutRenderPreview';
import type { parseSvgCutUploadText } from '../src/pages/cut/svgCutUploadParser';

declare global { interface Window { svgPriorityParser: { parseSvgCutUploadText: typeof parseSvgCutUploadText; buildStyledSvgUploadPreview: typeof buildStyledSvgUploadPreview; buildStyledCutLayoutPreview: typeof buildStyledCutLayoutPreview }; } }
let bundle: string;
for (const staleMetadata of [false, true]) test(`2950 keeps adjacent narrow strips and grooved parts with their visible positions (stale metadata: ${staleMetadata})`, async ({page}) => {
  const svg = readFileSync('tests/fixtures/svg-source-priority/adjacent-2950.svg', 'utf8');
  const source = staleMetadata ? svg.replace(/name="Comments" value="[^"]*"/g, 'name="Comments" value="9999#99#@900*800@"') : svg;
  const parsed = await page.evaluate(svg => window.svgPriorityParser.parseSvgCutUploadText(svg, '2950.svg'), source);
  const identities = Object.fromEntries(parsed.cutLayout.items.map(item => [item.sourceElementId, item.detailNumber]));
  expect(identities).toEqual({
    _2950_PartContour: 24, _2950_PartContour_1: 24, _2950_PartContour_4: 24, _2950_PartContour_7: 24,
    _2950_PartContour_10: 14, _2950_PartContour_12: 14,
    _2950_PartContour_15: 13, _2950_PartContour_17: 13, _2950_PartContour_20: 13,
    _2950_PartContour_22: 15, _2950_PartContour_24: 15, _2950_PartContour_27: 15,
    _2950_PartContour_29: 10, _2950_PartContour_30: 9,
  });
  expect(parsed.cutLayout.reasons).toEqual([]);
  for (const [position, width, height, count] of [[9, 2700, 34, 1], [10, 2700, 34, 1], [13, 573, 181, 3], [14, 427, 172, 2], [15, 2727, 497, 3], [24, 604, 231, 4]]) {
    const parts = parsed.cutLayout.items.filter(item => item.detailNumber === position);
    expect(parts).toHaveLength(count);
    for (const part of parts) {
      expect(part.orderName).toBe('2950');
      expect(part.widthMm).toBeCloseTo(width, 0);
      expect(part.heightMm).toBeCloseTo(height, 0);
    }
  }
});
test.beforeAll(async () => {
  const result = await build({stdin: {contents: "export * from './src/pages/cut/svgCutUploadParser'; export * from './src/pages/cut/svgCutRenderPreview';", resolveDir: process.cwd()}, alias: {'@shared': './backend/src/shared'}, bundle: true, write: false, format: 'iife', globalName: 'svgPriorityParser'});
  bundle = result.outputFiles[0].text;
});
test.beforeEach(async ({page}) => { await page.addScriptTag({content: bundle}); });
for (const [file, count] of [['stale-comment-size.svg', 4], ['mixed-test-position.svg', 20]] as const) {
  test(`actual SVG DOM: ${file}`, async ({page}) => {
    const svg = readFileSync(`tests/fixtures/svg-source-priority/${file}`, 'utf8');
    const parsed = await page.evaluate(({svg,file}) => window.svgPriorityParser.parseSvgCutUploadText(svg,file,{includeVisualLabelOnlyItems: true}), {svg,file});
    expect(parsed.cutLayout.status).toBe('valid');
    expect(parsed.cutLayout.items).toHaveLength(count);
    expect(parsed.items.length).toBeGreaterThan(0);
    if (count === 4) expect(parsed.cutLayout.items.find(i => i.detailNumber === 12)).toMatchObject({orderName: '2872', widthMm: 1617, heightMm: 412});
    else expect(parsed.cutLayout.reasons.join(';')).toContain('_2885_PartContour');
  });
}
test('metadata fallback uses geometry; unsafe contour cannot return as label-only item', async ({page}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
    <rect id="good-PartContour" x="20" y="20" width="200" height="100"><metadata><odm name="Comments" value="2872#12#@900*800@"/></metadata></rect>
    <rect id="bad-PartContour" x="1200" y="20" width="200" height="100"/>
    <text x="1250" y="40">2872</text><text x="1250" y="60"># 13</text><text x="1250" y="80">200*100</text>
  </svg>`;
  const parsed = await page.evaluate(svg => window.svgPriorityParser.parseSvgCutUploadText(svg,'partial.svg',{includeVisualLabelOnlyItems: true}), svg);
  expect(parsed.cutLayout.status).toBe('valid');
  expect(parsed.cutLayout.items).toHaveLength(1);
  expect(parsed.cutLayout.items[0]).toMatchObject({orderName: '2872', detailNumber: 12, widthMm: 200, heightMm: 100});
  expect(parsed.cutLayout.reasons.length).toBeGreaterThan(0);
});

test('collapsed path cannot block good labels or return through label-only salvage', async ({page}) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
    <rect id="good-PartContour" x="20" y="20" width="200" height="100"><metadata><odm name="Comments" value="2872#12#@900*800@"/></metadata></rect>
    <path id="collapsed-PartContour" d="M700 50 L700 50"/>
    <text x="700" y="40">2872</text><text x="700" y="60"># 13</text><text x="700" y="80">200*100</text>
  </svg>`;
  const parsed = await page.evaluate(svg => window.svgPriorityParser.parseSvgCutUploadText(svg,'partial.svg',{includeVisualLabelOnlyItems: true}), svg);
  expect(parsed.cutLayout.status).toBe('valid');
  expect(parsed.cutLayout.items).toHaveLength(1);
  expect(parsed.cutLayout.items[0].detailNumber).toBe(12);
  expect(parsed.cutLayout.reasons.join(';')).toContain('collapsed-PartContour');
});

// Preview must retain physical contours independently of business recognition.
test('real Test position remains visible without becoming an imported detail', async ({page}) => {
  const svg = readFileSync('tests/fixtures/svg-source-priority/mixed-test-position.svg', 'utf8');
  const result = await page.evaluate(svg => {
    const parsed = window.svgPriorityParser.parseSvgCutUploadText(svg, 'mixed.svg');
    const rendered = window.svgPriorityParser.buildStyledCutLayoutPreview(JSON.parse(JSON.stringify(parsed.cutLayout))) ?? '';
    const doc = new DOMParser().parseFromString(rendered, 'image/svg+xml');
    return {accepted: parsed.cutLayout.items.length, requested: parsed.items.reduce((n,i)=>n+i.quantity,0),
      contours: doc.querySelectorAll('.cut-sheet-piece-geometry-layer > .cut-sheet-piece').length,
      text: doc.documentElement.textContent};
  }, svg);
  expect(result.accepted).toBe(20);
  expect(result.requested).toBe(20);
  expect(result.contours).toBe(21);
  expect(result.text).toContain('# Test');
});

test('unidentified safe contours render even when no detail can be imported; unsafe contours stay excluded', async ({page}) => {
  const result = await page.evaluate(() => {
    const parsed = window.svgPriorityParser.parseSvgCutUploadText(`<svg xmlns="http://www.w3.org/2000/svg" width="1000mm" height="500mm" viewBox="0 0 1000 500">
      <rect id="unknown-PartContour" x="20" y="20" width="200" height="100"/>
      <text x="50" y="45">2885</text><text x="50" y="65"># &lt;Test&gt;</text><text x="50" y="85">200*100</text>
      <rect id="outside-PartContour" x="1200" y="20" width="200" height="100"/>
      <path id="collapsed-PartContour" d="M700 50 L700 50"/>
    </svg>`, 'unknown.svg');
    const rendered = window.svgPriorityParser.buildStyledCutLayoutPreview(JSON.parse(JSON.stringify(parsed.cutLayout))) ?? '';
    const doc = new DOMParser().parseFromString(rendered, 'image/svg+xml');
    return {status: parsed.cutLayout.status, accepted: parsed.cutLayout.items.length, requested: parsed.items.length,
      contours: doc.querySelectorAll('.cut-sheet-piece-geometry-layer > .cut-sheet-piece').length,
      text: doc.documentElement.textContent, injected: doc.querySelectorAll('Test,script,parsererror').length};
  });
  expect(result).toMatchObject({status:'invalid',accepted:0,requested:0,contours:1,injected:0});
  expect(result.text).toContain('# <Test>');
});

for (const stored of [false, true]) for (const orderName of ['2950', 'ШЖWWW']) test(`2950 preview labels do not overlap (stored layout: ${stored}, order: ${orderName})`, async ({page}) => {
  const source = readFileSync('tests/fixtures/svg-source-priority/adjacent-2950.svg', 'utf8');
  const result = await page.evaluate(async ({source, stored, orderName}) => {
    const parsed = window.svgPriorityParser.parseSvgCutUploadText(source, '2950.svg');
    for (const item of parsed.cutLayout.items) {
      item.orderName = orderName;
      if (item.labelLines?.length) item.labelLines[0] = orderName;
    }
    const svg = stored
      ? window.svgPriorityParser.buildStyledCutLayoutPreview(JSON.parse(JSON.stringify(parsed.cutLayout)))
      : window.svgPriorityParser.buildStyledSvgUploadPreview(parsed);
    document.body.innerHTML = svg ?? '';
    await document.fonts.ready;
    const texts = Array.from(document.querySelectorAll<SVGTextElement>('.cut-sheet-piece-label-layer text'));
    const boxes = texts.map(text => {
      const r = text.getBoundingClientRect();
      return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, text: text.textContent };
    });
    const collisions = boxes.flatMap((a, i) => boxes.slice(i + 1).filter(b =>
      a.x < b.right && a.right > b.x && a.y < b.bottom && a.bottom > b.y
    ).map(b => [a.text, b.text]));
    return { count: texts.length, collisions,
      moved: document.querySelectorAll('.cut-sheet-piece-label-layer g[transform]').length,
      xUnchanged: texts.every((text, i) => {
        const item = parsed.cutLayout.items[i];
        return Math.abs(Number(text.getAttribute('x')) - item.xMm - item.placedWidthMm / 2) < 0.01;
      }),
    };
  }, {source, stored, orderName});
  expect(result.count).toBe(14);
  expect(result.collisions).toEqual([]);
  expect(result.moved).toBeGreaterThan(0);
  expect(result.xUnchanged).toBe(true);
});


test('wide order names on separated strips still trigger staggering', async ({page}) => {
  const source = readFileSync('tests/fixtures/svg-source-priority/adjacent-2950.svg', 'utf8');
  const result = await page.evaluate(async source => {
    const parsed = window.svgPriorityParser.parseSvgCutUploadText(source, '2950.svg');
    const layout = parsed.cutLayout;
    layout.sheet = { widthMm: 1000, heightMm: 2800 };
    layout.renderOnlyContours = [];
    layout.items = [0, 1].map(i => ({ ...layout.items[0], xMm: 300 + 250 * i, yMm: 50,
      placedWidthMm: 34, placedHeightMm: 2700, sourceSvg: undefined,
      orderName: 'WWWWWWWWWWWW', labelLines: ['WWWWWWWWWWWW', '# 10', '2700*34'] }));
    document.body.innerHTML = window.svgPriorityParser.buildStyledCutLayoutPreview(layout) ?? '';
    await document.fonts.ready;
    const [a, b] = Array.from(document.querySelectorAll<SVGTextElement>('.cut-sheet-piece-label-layer text'))
      .map(text => text.getBoundingClientRect());
    return { separated: a.bottom <= b.top || b.bottom <= a.top,
      count: document.querySelectorAll('.cut-sheet-piece-label-layer text').length };
  }, source);
  expect(result).toEqual({separated: true, count: 2});
});
