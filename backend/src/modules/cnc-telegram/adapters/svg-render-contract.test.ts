import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CUT_RENDER_STYLE_MDF_BOARD_PREVIEW } from '../../../shared/cut-render-style';
import { normalizeSvgRenderContours } from '../../../shared/svg-render-contours';
import { buildManualSvgSheetSvg, buildSheetSvg } from '../../cut/render/sheet-svg';
import { parseManualSvgUpload, parseStructuredIngest } from '../http/cnc-telegram.controller';
import { buildSvgSheetPlacements, cutLayoutOrNull, renderManualSvgScreenshot } from './pg-cnc-telegram-repository';
import type { CncTelegramCutLayoutDto } from '../dto/cnc-telegram.dto';
import { resolveCutRenderStyle } from '../../../shared/cut-render-style';

const count = (svg: string) => (svg.match(/class="cut-sheet-piece"/g) ?? []).length;

describe('persisted SVG render contract', () => {
  it.each([['mixed-test-position.svg', 20, 21], ['stale-comment-size.svg', 4, 4]] as const)(
    'worker -> API -> stored layout -> cut sheet and Telegram screenshot: %s', (file, accepted, contours) => {
      const layout: CncTelegramCutLayoutDto = JSON.parse(execFileSync('python3', ['-c',
        'import json,sys;from pathlib import Path;from cnc_telegram_worker.vector import parse_svg_cut_layout,layout_to_dict;print(json.dumps(layout_to_dict(parse_svg_cut_layout(Path(sys.argv[1])))))',
        resolve('tests/fixtures/svg-source-priority', file)], {
        env: {...process.env, PYTHONPATH: resolve('cnc-telegram-worker')}, encoding: 'utf8',
      }));
      const items = layout.items.map((item, i) => ({sourceItemKey: `item-${i}`, orderName:item.orderName,
        detailNumber:item.detailNumber,widthMm:item.widthMm,heightMm:item.heightMm,quantity:1,source:'vector',confidence:0.99}));
      const manual = parseManualSvgUpload({selectedOrderIds:[1],createMdfMachineFileCard:true,svgContentHash:'a'.repeat(64),
        programName:file,cutLayout:layout,items}, 'unified-render:test');
      const telegram = parseStructuredIngest({externalPacketKey:'test:svg',source:{chatId:'-100',messageId:1,version:1},
        workday:'2026-09-08',parseStatus:'parsed',cutLayout:layout,items}, 'unified-render:telegram');
      const stored = cutLayoutOrNull(JSON.parse(JSON.stringify(telegram.cutLayout)))!;
      expect(stored.items).toHaveLength(accepted);
      expect(manual.items).toHaveLength(accepted);
      expect(stored.renderOnlyContours).toHaveLength(contours - accepted);
      const preview = buildManualSvgSheetSvg(manual.cutLayout, CUT_RENDER_STYLE_MDF_BOARD_PREVIEW)!;
      expect(count(preview)).toBe(contours);
      expect(buildManualSvgSheetSvg(stored, CUT_RENDER_STYLE_MDF_BOARD_PREVIEW)).toBe(preview);
      const placements = buildSvgSheetPlacements({ok:true,sheetWidthMm:stored.sheet!.widthMm,sheetHeightMm:stored.sheet!.heightMm,
        sheetMaterialTypeId:null,filmId:null,materialName:null,informational:true,details:[],
        placements:stored.items.map((item,i)=>({...item,itemKey:`svg-${i}`,orderId:null,orderDetailId:null})),
      }, new Map(), stored.renderOnlyContours);
      const persisted = JSON.parse(JSON.stringify(placements));
      expect(persisted.pieces).toHaveLength(accepted);
      for (const rotate90 of [false,true]) for (const showLabels of [false,true]) {
        expect(count(buildSheetSvg({sheet:persisted,labelFor:()=>[],rotate90,showLabels}))).toBe(contours);
      }
      if (contours === 21) {
        expect(preview).toContain('# Test');
        expect(stored.renderOnlyContours?.[0].labelLines).toContain('# Test');
        expect(persisted.pieces.every((p: {item_id:string})=>!p.item_id.includes('render-only'))).toBe(true);
      }
      const screenshot = renderManualSvgScreenshot(manual, {kind:'svg',fileName:file,contentType:'image/svg+xml',
        sizeBytes:0,sha256:'a'.repeat(64),raw:Buffer.alloc(0),generated:false}, resolveCutRenderStyle(CUT_RENDER_STYLE_MDF_BOARD_PREVIEW), 211);
      expect(screenshot.raw.subarray(0,8).toString('hex')).toBe('89504e470d0a1a0a');
    });

  it('filters unsafe geometry and active fragments without manufacturing printable items', () => {
    const good = {sourceElementId:'Test',xMm:10,yMm:10,placedWidthMm:200,placedHeightMm:100,labelLines:['# Test']};
    expect(normalizeSvgRenderContours([good,{...good,sourceElementId:'outside',xMm:2000},
      {...good,sourceElementId:'collapsed',placedWidthMm:0},
      {...good,sourceElementId:'active',sourceSvg:{viewBox:{xMm:0,yMm:0,widthMm:200,heightMm:100},body:'<script>alert(1)</script>'}}],
    {widthMm:1000,heightMm:500})).toEqual([good]);
  });
});
