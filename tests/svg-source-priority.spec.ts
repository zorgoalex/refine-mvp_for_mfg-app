import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import type { parseSvgCutUploadText } from '../src/pages/cut/svgCutUploadParser';

declare global { interface Window { svgPriorityParser: { parseSvgCutUploadText: typeof parseSvgCutUploadText }; } }
let bundle: string;
test.beforeAll(async () => {
  const result = await build({entryPoints: ['src/pages/cut/svgCutUploadParser.ts'], bundle: true, write: false, format: 'iife', globalName: 'svgPriorityParser'});
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
