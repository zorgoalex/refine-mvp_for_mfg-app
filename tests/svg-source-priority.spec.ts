import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { buildStyledSvgUploadPreview } from '../src/pages/cut/svgCutRenderPreview';
import type { parseSvgCutUploadText } from '../src/pages/cut/svgCutUploadParser';

declare global { interface Window { svgPriorityParser: { parseSvgCutUploadText: typeof parseSvgCutUploadText; buildStyledSvgUploadPreview: typeof buildStyledSvgUploadPreview }; } }
let bundle: string;
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
    const rendered = window.svgPriorityParser.buildStyledSvgUploadPreview({...parsed, svgContentHash: ''}) ?? '';
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
    const rendered = window.svgPriorityParser.buildStyledSvgUploadPreview({...parsed, svgContentHash: ''}) ?? '';
    const doc = new DOMParser().parseFromString(rendered, 'image/svg+xml');
    return {status: parsed.cutLayout.status, accepted: parsed.cutLayout.items.length, requested: parsed.items.length,
      contours: doc.querySelectorAll('.cut-sheet-piece-geometry-layer > .cut-sheet-piece').length,
      text: doc.documentElement.textContent, injected: doc.querySelectorAll('Test,script,parsererror').length};
  });
  expect(result).toMatchObject({status:'invalid',accepted:0,requested:0,contours:1,injected:0});
  expect(result.text).toContain('# <Test>');
});
