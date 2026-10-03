import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { CutJobItemDto } from '../../cut/dto/cut.dto';
import {
  FROZEN_SHEET_STORED_VIEW_KEY,
  FROZEN_SHEET_VIEWS,
  frozenSheetRenderProblem,
  frozenSheetViewKey,
  renderFrozenSheetView,
} from '../../cut/render/frozen-sheet-render';
import type { CncTelegramCutLayoutDto } from '../dto/cnc-telegram.dto';
import { buildSvgRenderSnapshot, buildSvgSheetPlacements } from './pg-cnc-telegram-repository';

const roundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Real worker output for the SVG fixtures (the same path the import takes). */
function layoutOf(file: string): CncTelegramCutLayoutDto {
  return JSON.parse(execFileSync('python3', ['-c',
    'import json,sys;from pathlib import Path;from cnc_telegram_worker.vector import parse_svg_cut_layout,layout_to_dict;print(json.dumps(layout_to_dict(parse_svg_cut_layout(Path(sys.argv[1])))))',
    resolve('tests/fixtures/svg-source-priority', file)], {
    env: { ...process.env, PYTHONPATH: resolve('cnc-telegram-worker') }, encoding: 'utf8',
  }));
}

describe('SVG import render snapshot: contract v2 keeps every v1 view', () => {
  it.each(['mixed-test-position.svg', 'stale-comment-size.svg'])('%s', (file) => {
    const layout = layoutOf(file);
    // Two orders, two linked details with bath data, the rest unlinked; render-only contours kept.
    const items = new Map<number, CutJobItemDto>([
      [42, { orderDetailId: 42, orderId: 11, orderName: 'E2E-Тест А', qty: 1,
        detail: { detailNumber: 3, width: 600, height: 400, edgeTypeName: 'ПВХ 2 мм', millingTypeName: 'Фреза R3', doweling: true, materialName: 'МДФ 16' } } as unknown as CutJobItemDto],
      [43, { orderDetailId: 43, orderId: 12, orderName: 'E2E-Тест Б', qty: 2,
        detail: { detailNumber: 5, width: 300, height: 900, edgeTypeName: null, millingTypeName: null, doweling: false } } as unknown as CutJobItemDto],
    ]);
    const plan = {
      ok: true as const, sheetWidthMm: layout.sheet!.widthMm, sheetHeightMm: layout.sheet!.heightMm,
      sheetMaterialTypeId: null, filmId: null, materialName: 'МДФ 19 (E2E)', informational: false, details: [],
      placements: layout.items.map((item, i) => ({
        ...item, itemKey: `svg-${i}`,
        orderId: i === 0 ? 11 : i === 1 ? 12 : null,
        orderDetailId: i === 0 ? 42 : i === 1 ? 43 : null,
      })),
    };
    const placements = buildSvgSheetPlacements(plan as never, items, layout.renderOnlyContours);
    const v1 = buildSvgRenderSnapshot(placements, items, file, plan as never, 'v1');
    const v2 = roundTrip(buildSvgRenderSnapshot(placements, items, file, plan as never, 'v2'));
    if (v1.contractVersion !== 'cut_sheet_render_v1' || v2.contractVersion !== 'cut_sheet_render_v2') {
      throw new Error('unexpected contracts');
    }
    expect(Object.keys(v1.views)).toHaveLength(12);
    expect(frozenSheetRenderProblem(v2, roundTrip(placements))).toBeNull();
    expect(v2.views[FROZEN_SHEET_STORED_VIEW_KEY].svg).toBe(v1.views[FROZEN_SHEET_STORED_VIEW_KEY].svg);
    expect(v2.pdfMeta).toEqual(roundTrip(v1.pdfMeta));
    expect(v2.pdfDetailRows).toEqual(roundTrip(v1.pdfDetailRows));
    for (const view of FROZEN_SHEET_VIEWS) {
      expect(renderFrozenSheetView(roundTrip(placements), v2.model, view), frozenSheetViewKey(view))
        .toEqual(v1.views[frozenSheetViewKey(view)]);
    }
  });
});
