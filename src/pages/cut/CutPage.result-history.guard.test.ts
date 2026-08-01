import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync(new URL('./CutPage.tsx', import.meta.url), 'utf8');

describe('CutPage result history guard', () => {
  it('shows completed results and marks historical mode read-only', () => {
    expect(source).toContain('Выполненные раскрои');
    expect(source).toContain('Историческая версия');
    expect(source).toContain('job?.status === \'archived\' || isHistoricalResult');
    expect(source).toContain('Вернуться к живому заданию');
  });

  it('routes historical PNG/SVG/PDF through immutable result number', () => {
    expect(source).toContain('isHistoricalResult ? selectedResult?.resultNo : undefined');
    expect(source).toContain('cutApi.getResult');
  });

  it('keeps saved versions printable even when the live job requires recalculation', () => {
    expect(source).toContain('const jobPdfPreviewBlockReason = cutPdfPreviewBlockReason({');
    expect(source).toContain('const groupPdfPreviewBlockReason = cutPdfPreviewBlockReason({');
    expect(source.match(/isFrozenResult: isHistoricalResult/g)).toHaveLength(3);
    expect(source).toContain('disabled={jobPdfPreviewBlockReason !== null}');
    expect(source).toContain('disabled={groupPdfPreviewBlockReason !== null}');
  });

  it('keeps ordinary job opening live; frozen read-only mode is only explicit result opening', () => {
    expect(source).toContain('if (resultNo !== undefined) {');
    expect(source).toContain('const frozen = await cutApi.getResult(cutJobId, resultNo)');
    expect(source).toContain('setIsFrozenResultSelection(resultNo !== undefined)');
    expect(source).toContain('await openJob(job.cutJobId, result.resultNo)');
    expect(source).not.toContain('currentIsLatest');
    expect(source).not.toContain('effectiveResultNo');
  });

  it('wires archive and acting-result commands for completed result rows', () => {
    expect(source).toContain('cutApi.setCurrentResult(job.cutJobId, result.resultNo)');
    expect(source).toContain('cutApi.archiveResult(job.cutJobId, result.resultNo)');
    expect(source).toContain('cutApi.unarchiveResult(job.cutJobId, result.resultNo)');
    expect(source).toContain('отправлен в архив');
    expect(source).toContain('Сделать действующим');
  });

  it('allows request-only PDF template selection for every frozen or archived version', () => {
    expect(source).toContain("const pdfTemplateIsRequestOnly = isHistoricalResult || job?.status === 'archived'");
    expect(source.match(/if \(pdfTemplateIsRequestOnly\) return;/g)).toHaveLength(2);
    expect(source).toContain('pdfTemplateIsRequestOnly, handleError, loadJobs');
    expect(source).not.toContain('disabled={busy || isArchivedJob}\n                    data-testid="pdf-template-select-job"');
  });

  it('keeps command ids stable until calculate/manual requests are confirmed', () => {
    expect(source).toContain('calcCommandRef.current?.cutJobId !== job.cutJobId');
    expect(source).toContain('manualCommandRef.current?.key !== commandKey');
    expect(source).toContain('cutApi.calculate(job.cutJobId, commandVersion, commandId)');
    expect(source).toContain('emitCutJobReady(calculated)');
    expect(source).toContain('emitCutJobReady(fresh)');
    expect(source).toContain('version: job.version');
    expect(source).toContain('responseWasLostAfterSuccess');
  });

  it('loads job+result deep links and names the last successful result on failure', () => {
    expect(source).toContain('parseResultQueryParam');
    expect(source).toContain('openJob(deepLinkJobId, deepLinkResultNo ?? undefined)');
    expect(source).toContain('`/cut?job=${job.cutJobId}&result=${result.resultNo}`');
    expect(source).toContain('Последний успешный раскрой:');
  });
});
