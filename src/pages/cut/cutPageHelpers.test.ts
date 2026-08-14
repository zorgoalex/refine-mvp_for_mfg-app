import { describe, expect, it } from 'vitest';
import {
  buildCutAddWarning,
  buildFilmTextureMap,
  formatPlacementsMessage,
  CUT_JOB_STATUS_FILTER_ALL,
  cutJobCounts,
  cutJobSourceLabel,
  cutJobStatusLabel,
  distinctOrderIdsFromItems,
  filterJobsByStatus,
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  parseJobQueryParam,
  parseResultQueryParam,
  safeHttpHref,
  pollPdf,
  pruneEmptySheets,
  restrictDetailIds,
  selectableDetailIds,
  sheetMaterialFilmNames,
} from './cutPageHelpers';

describe('parseJobQueryParam', () => {
  it('parses a positive integer job id', () => {
    expect(parseJobQueryParam('?job=45')).toBe(45);
  });
  it('returns null for missing/invalid', () => {
    expect(parseJobQueryParam('')).toBeNull();
    expect(parseJobQueryParam('?job=abc')).toBeNull();
    expect(parseJobQueryParam('?job=-3')).toBeNull();
    expect(parseJobQueryParam('?foo=1')).toBeNull();
  });
});

describe('parseResultQueryParam', () => {
  it('parses only a positive integer result number', () => {
    expect(parseResultQueryParam('?job=45&result=3')).toBe(3);
    expect(parseResultQueryParam('?result=0')).toBeNull();
    expect(parseResultQueryParam('?result=abc')).toBeNull();
    expect(parseResultQueryParam('?job=45')).toBeNull();
  });
});

describe('cutPageHelpers', () => {
  it('parses a CSV of positive ids, dropping noise', () => {
    expect(parseIdCsv('9, 10, x, -3, 0, 11')).toEqual([9, 10, 11]);
    expect(parseIdCsv('')).toEqual([]);
    expect(parseIdCsv('  ')).toEqual([]);
  });

  it('builds a prominent no_sheet_spec operator message only when count > 0', () => {
    expect(noSheetSpecMessage(0)).toBeNull();
    const msg = noSheetSpecMessage(3);
    expect(msg).toContain('3');
    expect(msg?.toLowerCase()).toContain('специфика');
  });

  it('returns only the eligible detail ids as selectable', () => {
    const details = [
      { orderDetailId: 1, eligible: true },
      { orderDetailId: 2, eligible: false },
      { orderDetailId: 3, eligible: true },
    ];
    expect(selectableDetailIds(details)).toEqual([1, 3]);
  });

  it('formats a freecut group summary compactly', () => {
    expect(formatGroupSummary({ used_stock_count: 2, waste_percent: 12.5 })).toBe('листов: 2, остаток: 13%');
    expect(formatGroupSummary(null)).toBe('');
  });

  it('pollPdf retries on a cold-cache 202 and resolves once the PDF is ready', async () => {
    const blob = new Blob(['%PDF-1']);
    let calls = 0;
    const sleeps: number[] = [];
    const result = await pollPdf(
      async () => {
        calls += 1;
        return calls < 3 ? { pending: true } : { pending: false, blob, fileName: 'cut.pdf' };
      },
      { maxAttempts: 5, delayMs: 10, sleep: async (ms) => { sleeps.push(ms); } },
    );
    expect(result.pending).toBe(false);
    expect(calls).toBe(3);
    expect(sleeps).toEqual([10, 10]); // slept between the two pending attempts
  });

  it('pollPdf throws after exhausting attempts while still pending', async () => {
    await expect(
      pollPdf(async () => ({ pending: true }), { maxAttempts: 2, delayMs: 1, sleep: async () => {} }),
    ).rejects.toThrow(/PDF/);
  });

  it('maps cut job status codes to Russian labels, passing unknown through', () => {
    expect(cutJobStatusLabel('draft')).toBe('Черновик');
    expect(cutJobStatusLabel('ready')).toBe('Готов');
    expect(cutJobStatusLabel('archived')).toBe('Удалено');
    expect(cutJobStatusLabel('weird')).toBe('weird');
  });

  it('maps cut job source codes to Russian labels, passing unknown through', () => {
    expect(cutJobSourceLabel('manual')).toBe('Ручной');
    expect(cutJobSourceLabel('api')).toBe('API');
    expect(cutJobSourceLabel('other')).toBe('other');
  });

  it('filters jobs by status, with "all" returning a copy of the list', () => {
    const jobs = [
      { status: 'draft' },
      { status: 'ready' },
      { status: 'draft' },
    ];
    expect(filterJobsByStatus(jobs, 'draft')).toEqual([{ status: 'draft' }, { status: 'draft' }]);
    expect(filterJobsByStatus(jobs, CUT_JOB_STATUS_FILTER_ALL)).toEqual(jobs);
    expect(filterJobsByStatus(jobs, CUT_JOB_STATUS_FILTER_ALL)).not.toBe(jobs);
    expect(filterJobsByStatus(jobs, '')).toEqual(jobs);
  });

  it('builds a reason-aware add-to-cut warning (no_sheet_spec / wrong_status counts)', () => {
    expect(buildCutAddWarning([{ eligible: false, ineligibleReason: 'no_sheet_spec' }])).toMatch(/специфика/);
    const mixed = buildCutAddWarning([
      { eligible: false, ineligibleReason: 'no_sheet_spec' },
      { eligible: false, ineligibleReason: 'wrong_status' },
    ]);
    expect(mixed).toMatch(/без раскройной спецификации материала: 1/);
    expect(mixed).toMatch(/неподходящий статус: 1/);
    expect(buildCutAddWarning([])).toBe('Нет подходящих деталей для раскроя');
  });

  it('formats an informational placements message (never blocking)', () => {
    expect(
      formatPlacementsMessage({ jobs: [{ cutJobId: 1, name: 'Раскрой A' }, { cutJobId: 5, name: 'B' }], hasArchived: false }),
    ).toMatch(/#1 Раскрой A.*#5 B/);
    const archived = formatPlacementsMessage({ jobs: [], hasArchived: true });
    expect(archived).toMatch(/удалённых заданиях/);
    expect(formatPlacementsMessage({ jobs: [], hasArchived: false })).toBeNull();
    expect(
      formatPlacementsMessage({ jobs: [{ cutJobId: 1, name: 'A' }], hasArchived: false }),
    ).toMatch(/не ограничено/);
  });

  it('counts job items and groups defensively', () => {
    expect(cutJobCounts({ items: [1, 2], groups: [1] })).toEqual({ items: 2, groups: 1 });
    expect(cutJobCounts({})).toEqual({ items: 0, groups: 0 });
  });

  it('restrictDetailIds intersects eligible with chosen (eligible order, distinct)', () => {
    expect(restrictDetailIds([3, 1, 2], [2, 3])).toEqual([3, 2]);
    expect(restrictDetailIds([1, 2, 3], [])).toEqual([]);
    expect(restrictDetailIds([1, 2], [5, 6])).toEqual([]);
    expect(restrictDetailIds([1, 1, 2], [1, 2])).toEqual([1, 2]);
  });

  it('safeHttpHref fail-closes non-http schemes (stored-link XSS guard)', () => {
    expect(safeHttpHref('https://drive.google.com/file/x')).toBe('https://drive.google.com/file/x');
    expect(safeHttpHref('http://x.test/a')).toBe('http://x.test/a');
    expect(safeHttpHref('  https://x.test/a  ')).toBe('https://x.test/a');
    expect(safeHttpHref('/orders/show/1')).toBe('/orders/show/1');
    // Hostile / non-http schemes -> null (rendered as inert text, not anchor).
    expect(safeHttpHref('javascript:alert(1)')).toBeNull();
    expect(safeHttpHref('JavaScript:alert(1)')).toBeNull();
    expect(safeHttpHref('data:text/html,hi')).toBeNull();
    expect(safeHttpHref('vbscript:msgbox(1)')).toBeNull();
    expect(safeHttpHref('//evil.test')).toBeNull();
    expect(safeHttpHref('')).toBeNull();
    expect(safeHttpHref(null)).toBeNull();
    expect(safeHttpHref(undefined)).toBeNull();
  });

  it('distinctOrderIdsFromItems keeps first-seen order, drops dups and invalid ids', () => {
    expect(distinctOrderIdsFromItems([{ orderId: 9 }, { orderId: 10 }, { orderId: 9 }])).toEqual([9, 10]);
    expect(distinctOrderIdsFromItems([])).toEqual([]);
    expect(distinctOrderIdsFromItems([{ orderId: 0 }, { orderId: -1 }, { orderId: 7 }])).toEqual([7]);
  });
});

describe('buildFilmTextureMap', () => {
  const makePiece = (item_id: string) => ({ item_id });
  const makeSheet = (...itemIds: string[]) => ({
    placements: { pieces: itemIds.map(makePiece) },
  });
  const makeItem = (orderDetailId: number, filmTexture: boolean | null) => ({
    orderDetailId,
    detail: { filmTexture },
  });
  const makeItemNoDetail = (orderDetailId: number) => ({
    orderDetailId,
    detail: null,
  });

  it('returns true for a piece whose detail has filmTexture=true', () => {
    const sheets = [makeSheet('det-1')];
    const items = [makeItem(1, true)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('det-1')).toBe(true);
  });

  it('returns false for a piece whose detail has filmTexture=false', () => {
    const sheets = [makeSheet('det-2')];
    const items = [makeItem(2, false)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('det-2')).toBe(false);
  });

  it('returns false for a piece whose detail has filmTexture=null', () => {
    const sheets = [makeSheet('det-3')];
    const items = [makeItem(3, null)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('det-3')).toBe(false);
  });

  it('returns false for a piece whose detail is null', () => {
    const sheets = [makeSheet('det-4')];
    const items = [makeItemNoDetail(4)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('det-4')).toBe(false);
  });

  it('returns false for a piece with an unrecognised item_id format', () => {
    const sheets = [makeSheet('group-7')];
    const items = [makeItem(7, true)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('group-7')).toBe(false);
  });

  it('deduplicates: same item_id across sheets is only resolved once', () => {
    const sheets = [makeSheet('det-1'), makeSheet('det-1')];
    const items = [makeItem(1, true)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.size).toBe(1);
    expect(map.get('det-1')).toBe(true);
  });

  it('handles multiple pieces across multiple sheets', () => {
    const sheets = [makeSheet('det-10', 'det-20'), makeSheet('det-30')];
    const items = [makeItem(10, true), makeItem(20, null), makeItem(30, false)];
    const map = buildFilmTextureMap(sheets, items);
    expect(map.get('det-10')).toBe(true);
    expect(map.get('det-20')).toBe(false);
    expect(map.get('det-30')).toBe(false);
  });

  it('returns an empty map for empty sheets', () => {
    expect(buildFilmTextureMap([], [])).toEqual(new Map());
  });
});

describe('pruneEmptySheets', () => {
  const s = (sheetIndex: number, pieceCount: number) => ({
    sheetIndex,
    placements: { pieces: Array.from({ length: pieceCount }, (_, i) => ({ id: i })) },
  });

  it('drops a sheet with no pieces, keeping real sheetIndex of survivors', () => {
    const out = pruneEmptySheets([s(0, 3), s(1, 0), s(2, 2)]);
    expect(out.map((x) => x.sheetIndex)).toEqual([0, 2]); // index 1 dropped, no renumber
  });

  it('keeps all sheets when none are empty', () => {
    const input = [s(0, 1), s(1, 2)];
    expect(pruneEmptySheets(input).map((x) => x.sheetIndex)).toEqual([0, 1]);
  });

  it('falls back to the input when every sheet is empty (defensive, should not happen)', () => {
    const input = [s(0, 0), s(1, 0)];
    expect(pruneEmptySheets(input).map((x) => x.sheetIndex)).toEqual([0, 1]);
  });
});

describe('sheetMaterialFilmNames', () => {
  const info = new Map([
    ['det-1', { materialName: 'ЛДСП Белый', filmName: 'Дуб' }],
    ['det-2', { materialName: 'ЛДСП Белый', filmName: 'Дуб' }],
    ['det-3', { materialName: 'МДФ', filmName: 'Орех' }],
    ['det-4', { materialName: '  ', filmName: null }],
  ]);
  const pcs = (...ids: string[]) => ids.map((item_id) => ({ item_id }));

  it('collects distinct materials in first-seen order, films omitted when showFilm=false', () => {
    const r = sheetMaterialFilmNames(pcs('det-1', 'det-2', 'det-3'), info, false);
    expect(r.materials).toEqual(['ЛДСП Белый', 'МДФ']);
    expect(r.films).toEqual([]);
  });

  it('collects distinct films when showFilm=true', () => {
    const r = sheetMaterialFilmNames(pcs('det-1', 'det-2', 'det-3'), info, true);
    expect(r.materials).toEqual(['ЛДСП Белый', 'МДФ']);
    expect(r.films).toEqual(['Дуб', 'Орех']);
  });

  it('drops blank/whitespace names and unknown item ids', () => {
    const r = sheetMaterialFilmNames(pcs('det-4', 'det-x'), info, true);
    expect(r.materials).toEqual([]);
    expect(r.films).toEqual([]);
  });

  it('single film on a film-split sheet', () => {
    const r = sheetMaterialFilmNames(pcs('det-1', 'det-2'), info, true);
    expect(r.materials).toEqual(['ЛДСП Белый']);
    expect(r.films).toEqual(['Дуб']);
  });
});
