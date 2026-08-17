import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const repository = readFileSync(new URL('./pg-cut-repository.ts', import.meta.url), 'utf8');
const controller = readFileSync(new URL('../http/cut.controller.ts', import.meta.url), 'utf8');
const pdfRenderer = readFileSync(new URL('../render/sheet-pdf.ts', import.meta.url), 'utf8');
const labelsRepository = readFileSync(new URL('../../labels/adapters/pg-labels-repository.ts', import.meta.url), 'utf8');

describe('cut result history implementation guards', () => {
  it('allocates result numbers under job transaction and freezes whole-job snapshot', () => {
    expect(repository).toContain('next_cut_result_no');
    expect(repository).toContain('validateFrozenJobSnapshot(snapshot)');
    expect(repository).toContain('snapshot_manifest');
    expect(repository).toContain('snapshot_digest');
    expect(repository).toContain("resultKind: 'auto'");
    expect(repository).toContain("resultKind: 'manual'");
    expect(repository).toContain('Ручной вариант содержит другой набор деталей');
  });

  it('dedupes commands and abandons expired calculate leases without replay', () => {
    expect(repository).toContain('CUT_RESULT_COMMAND_IN_PROGRESS');
    expect(repository).toContain('CUT_RESULT_COMMAND_ABANDONED');
    expect(repository).toContain('lease_expires_at > now()');
    expect(repository).toContain("status = 'completed', cut_result_id");
    expect(repository).toContain('reconcileExpiredCommands(limit = 50)');
    expect(repository).toContain("status = 'calculating' AND version = $2");
  });

  it('keeps repeated manual saves under one public result number', () => {
    expect(repository).toContain('reuseCurrentManualVersion: true');
    expect(repository).toContain('revisionNo: input.current.revisionNo + 1');
    expect(repository).toContain('nextResultNo: input.nextResultNo');
    expect(repository).toContain('ORDER BY r.result_no DESC, r.revision_no DESC');
    expect(repository).toContain('ORDER BY r.revision_no DESC');
    expect(labelsRepository).toContain('newer.revision_no > r.revision_no');
  });

  it('binds frozen render routes to job, result, group, and sheet ids', () => {
    expect(controller).toContain("@Get(':cutJobId/results/:resultNo/groups/:groupId/sheets/:sheetIndex.png')");
    expect(controller).toContain("@Get(':cutJobId/results/:resultNo/groups/:groupId/sheets/:sheetIndex.svg')");
    expect(repository).toContain('candidate.cutGroupId === args.cutGroupId');
  });

  it('keeps frozen placements and uses current geometry rendering only for explicit metadata refreshes', () => {
    expect(repository).toContain("contractVersion: 'cut_sheet_render_v1'");
    expect(repository).toContain('renderSnapshot.pdfMeta as PdfSheetMeta');
    expect(repository).toContain('renderSnapshot.pdfDetailRows as PdfSheetDetailRow[]');
    const frozenLoader = repository.slice(
      repository.indexOf('private async loadFrozenRenderContext'),
      repository.indexOf('private async attachFrozenRenderSnapshots'),
    );
    expect(frozenLoader).toContain('renderSnapshot?.views');
    expect(frozenLoader).toContain("const baseSvg = rebuildSvgWithPieceMetadata && (rebuildForRenderStyle || !view.svg.includes('data-detail-id='))");
    expect(frozenLoader).toContain('? buildSheetSvg({');
    expect(frozenLoader).toContain(': view.svg;');
    expect(frozenLoader).toContain('const baseBathSvg = rebuildBathSvgWithCurrentRenderer');
    expect(frozenLoader).toContain(': view.bathSvg;');
    expect(repository).toContain('buildFrozenSheetsPdf(frozenContext.renderContractVersion, pdfSheets)');
    expect(repository).toContain("buildFrozenSheetsPdf('cut_sheet_render_v1', pdfSheets)");
    expect(pdfRenderer).toContain("case 'cut_sheet_render_v1':");
    expect(pdfRenderer).toContain('return buildSheetsPdfV1(sheets)');
  });

  it('refreshes PDF dynamic fields and CNC relations on every PDF render', () => {
    expect(repository).toContain('refreshPdfDynamicFieldsForSheets');
    expect(repository).toContain('refreshPdfDynamicFields: true');
    expect(repository).toContain('cti.match_detail_id = od.detail_id');
    expect(repository).toContain("cti.match_status = 'matched'");
    expect(repository).toContain('buildPdfSheetMeta(sheet.placements, detailById, detailByItemId)');
    expect(repository).toContain('buildPdfDetailRows(sheet.placements, detailById, detailByItemId)');
    expect(controller).toContain('fresh on-demand render');
    expect(controller).toContain('this.cut.renderGroupPdf({');
    expect(controller).toContain('this.cut.renderJobPdf({');
    expect(controller).not.toContain('this.sendPdf(response, result');
  });
});
