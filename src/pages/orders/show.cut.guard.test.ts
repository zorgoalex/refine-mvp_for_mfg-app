import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// Source-text guards: the order show page exposes the detail-level cut picker,
// gated by useBackendCut + cut.manage, and passes chosen detailIds to AddToCutModal.
const source = readFileSync(fileURLToPath(new URL('./show.tsx', import.meta.url)), 'utf8');
const versionLinesSource = readFileSync(fileURLToPath(new URL('./CutJobVersionLines.tsx', import.meta.url)), 'utf8');

describe('OrderShow cut detail-picker guards', () => {
  it('gates the cut picker behind useBackendCut and cut.manage', () => {
    expect(source).toContain('featureFlags.useBackendCut');
    expect(source).toContain("can('cut.manage')");
  });

  it('wires the detail picker into AddToCutModal with detailIds', () => {
    expect(source).toContain('AddToCutModal');
    expect(source).toContain('Выделить детали для раскроя');
    expect(source).toContain('detailIds=');
    expect(source).toContain('orderNames={[record.order_name]}');
  });

  it('renders split current-result cut links for the order', () => {
    expect(source).toContain('const { cutJobByDetailId, bathCutJobByDetailId } = cutJobMaps');
    expect(source).toContain('cutOrderJobs');
    expect(source).toContain("import { CUT_JOB_READY_EVENT, cutJobReadyAffects, readCutJobReadyEvent } from \"../cut/cutJobEvents\";");
    expect(source).toContain('cncTelegramApi.orderCuttingSequences');
    expect(source).toContain('cncOrderCuttingSequences');
    expect(source).toContain("title: 'Расчет ванны'");
    expect(source).toContain("key: 'bath_cut_job'");
    expect(source).toContain('versionRef ? cutJobDeepLink(versionRef) : cutJobDeepLink(j.cutJobId)');
    expect(source).toContain('<CutJobVersionLines job={ref} />');
    expect(source).toContain('<CutJobVersionLines job={versionRef}');
    expect(source).toContain('Профиль: {cutJobProfileLabel(j)}');
    expect(source).toContain('Файлы станка');
    expect(source).toContain('№{sequence.cuttingSequenceNo}');
    expect(versionLinesSource).toContain('cutJobVersionLabel(job)');
    expect(versionLinesSource).toContain("fontVariantNumeric: 'tabular-nums'");
    expect(versionLinesSource).toContain("overflowWrap: 'anywhere'");
  });

  it('renders embedded cut screen as a top order info tab', () => {
    expect(source).toContain("key: 'cut', label: 'Раскрой'");
    expect(source).toContain('import { CutPage }');
    expect(source).toContain('<CutPage embeddedOrderId={record.order_id} />');
    expect(source).toContain("activeInfoPanel === 'cut'");
  });

  it('renders two-column order materials with linked bath cut jobs in the read-only order card', () => {
    expect(source).toContain('computeOrderBathFilmUsage');
    expect(source).toContain('Материалы заказа');
    expect(source).toContain('buildOrderFilmMaterialRows');
    expect(source).toContain('buildOrderSheetMaterialRows');
    expect(source).toContain('<CutJobLinks cutJobIds={value} cutJobNameById={cutJobNameById} />');
    expect(source).toContain('formatNumber(value, 1)');
    expect(source).toContain('bathCutJobs');
  });
});
