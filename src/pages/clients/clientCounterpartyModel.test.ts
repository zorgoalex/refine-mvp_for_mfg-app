import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { ClientCounterparty } from '../../api/partyContactsApi';
import {
  chunks, clientLinkErrorMessage, clientsCount, confirmHeadline, confirmSummary, counterpartyDetails, counterpartyOptions, defaultSelection,
  isCounterpartyApiMissing, matchReasons, pairsToVerify, runConfirmation, takenBy, verifyPairs,
} from './clientCounterpartyModel';

const item = (patch: Partial<ClientCounterparty> = {}): ClientCounterparty => ({
  refKey1c: 'k1', name: 'Адилов Айдын', code: null, bin: null, isBuyer: true, phones: [], matchedBy: [], clientId: null, clientName: null, ...patch,
});
const read = (file: string) => readFileSync(new URL(file, import.meta.url), 'utf8');
const apiError = (status: number, code: string, details?: unknown) => new ApiError({ status, code, message: code, details });

describe('client ↔ 1C counterparty model', () => {
  it('names the reasons: exact ones first, a similar name is not repeated next to an equal one', () => {
    expect(matchReasons(['phone', 'name'])).toBe('совпадает имя, совпадает телефон');
    expect(matchReasons(['similar', 'phone'])).toBe('совпадает телефон, похожее имя');
    expect(matchReasons(['name', 'similar'])).toBe('совпадает имя');
    expect(matchReasons([])).toBe('');
  });

  it('shows what tells two counterparties of one name apart', () => {
    expect(counterpartyDetails({ code: 'НФ-1', bin: '123456789012', phones: ['8701', '8702', '8703', '8704', '8705'] }))
      .toBe('код НФ-1 · БИН/ИИН 123456789012 · 8701, 8702, 8703 и ещё 2');
    expect(counterpartyDetails({ code: null, bin: null, phones: [] })).toBe('');
  });

  it('a counterparty of another client is shown and cannot be chosen; the own one can', () => {
    expect(takenBy(item({ clientId: 5, clientName: 'Иванов' }), 7)).toBe('Иванов');
    expect(takenBy(item({ clientId: 5, clientName: null }), 7)).toBe('#5');
    expect(takenBy(item({ clientId: 7, clientName: 'Сам' }), 7)).toBeNull();
    expect(counterpartyOptions([item({ code: 'К-1' }), item({ refKey1c: 'k2', clientId: 5, clientName: 'Иванов' })], 7)).toEqual([
      { value: 'k1', label: 'Адилов Айдын · код К-1', disabled: false },
      { value: 'k2', label: 'Адилов Айдын — уже сопоставлен с клиентом «Иванов»', disabled: true },
    ]);
  });

  it('explains a refusal; a taken counterparty names its holder', () => {
    expect(clientLinkErrorMessage(apiError(409, 'CLIENT_COUNTERPARTY_TAKEN', { clientId: 5, clientName: 'Иванов' })))
      .toBe('Этот контрагент 1С уже сопоставлен с клиентом «Иванов». Сначала снимите сопоставление у него.');
    expect(clientLinkErrorMessage(apiError(409, 'CLIENT_COUNTERPARTY_TAKEN'))).toBe('Этот контрагент 1С уже сопоставлен с другим клиентом.');
    expect(clientLinkErrorMessage(apiError(422, 'CLIENT_COUNTERPARTY_UNKNOWN'))).toBe('Такого контрагента нет в загруженных данных 1С.');
    expect(clientLinkErrorMessage(new Error('x'))).toBe('Не удалось изменить сопоставление с контрагентом 1С.');
  });

  it('hides the block on a backend without the API, not on a missing client', () => {
    expect(isCounterpartyApiMissing(apiError(404, 'HTTP_ERROR'))).toBe(true);
    expect(isCounterpartyApiMissing(apiError(404, 'CLIENT_NOT_FOUND'))).toBe(false);
    expect(isCounterpartyApiMissing(apiError(500, 'INTERNAL_ERROR'))).toBe(false);
  });

  it('the client forms no longer carry the 1C key: it is changed only by the card command', () => {
    for (const file of ['./create.tsx', './edit.tsx']) expect(read(file)).not.toMatch(/name="ref_key_1c"/);
    expect(read('./edit.tsx')).toMatch(/<ClientCounterpartyCard clientId=\{Number\(id\) \|\| null\} editable=\{can\("clients\.update"\)\} \/>/);
    expect(read('./show.tsx')).toMatch(/<ClientCounterpartyCard [^>]*editable=\{false\} \/>/);
    expect(read('./ClientCounterpartyCard.tsx')).not.toMatch(/from 'antd'[^;]*\bTooltip\b/);
  });

  it('bulk: only pairs with both the name and a phone equal are selected from the start', () => {
    const match = (clientId: number, strength: 'both' | 'phone' | 'name') => ({
      clientId, clientName: `К${clientId}`, clientPhones: [], strength,
      counterparty: { refKey1c: `k${clientId}`, name: 'x', code: null, bin: null, isBuyer: true, phones: [] },
    });
    expect(defaultSelection([match(1, 'both'), match(2, 'phone'), match(3, 'name'), match(4, 'both')])).toEqual([1, 4]);
  });

  const result = (clientId: number, status: 'linked' | 'conflict' | 'taken' | 'unknown' | 'not_found' | 'uncertain', holderClientName: string | null = null) =>
    ({ clientId, refKey1c: `k${clientId}`, status, holderClientId: holderClientName ? 9 : null, holderClientName });
  const pairsOf = (...ids: number[]) => ids.map((clientId) => ({ clientId, refKey1c: `k${clientId}` }));
  const nothing = { linked: [], notLinked: [], unknown: [] };

  it('bulk: requests are cut into parts and the outcome names every refused pair', () => {
    expect(chunks([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    expect(chunks([], 2)).toEqual([]);
    const summary = confirmSummary({
      results: [result(1, 'linked'), result(2, 'taken', 'Петров'), result(3, 'conflict'), result(4, 'unknown'), result(5, 'not_found'), result(6, 'linked')],
      unanswered: [], notSent: [],
    }, nothing, new Map([[2, 'Иванов'], [3, 'Сидоров'], [4, 'Кузнецов']]));
    expect(summary).toEqual({
      linked: 2,
      refused: [
        'Иванов — контрагент уже сопоставлен с другим клиентом («Петров»)',
        'Сидоров — у клиента уже появилось другое сопоставление',
        'Кузнецов — контрагента больше нет в загруженных данных 1С',
        '#5 — клиент не найден',
      ],
      unknown: [], notSent: 0,
    });
    expect(confirmHeadline(summary)).toBe('Сопоставлено: 2, пропущено: 4');
  });

  it('bulk: a part is never sent twice — a lost answer stops the run and its pairs go to verification', async () => {
    const sent: number[][] = [];
    const progress: number[] = [];
    const run = await runConfirmation(pairsOf(1, 2, 3, 4, 5), async (part) => {
      sent.push(part.map((pair) => pair.clientId));
      if (part[0].clientId === 3) throw new Error('Failed to fetch');
      return { results: [result(part[0].clientId, 'linked'), result(part[1].clientId, 'uncertain')] };
    }, 2, (done) => progress.push(done));
    expect(sent).toEqual([[1, 2], [3, 4]]);
    expect(run.unanswered).toEqual(pairsOf(3, 4));
    expect(run.notSent).toEqual(pairsOf(5));
    expect(run.failure).toBe('Failed to fetch');
    expect(progress).toEqual([2]);
    // An uncertain pair of an answered part is verified too.
    expect(pairsToVerify(run)).toEqual(pairsOf(2, 3, 4));
  });

  it('bulk: the answer was lost and another user removed the link meanwhile — it is not linked again, and reported as not linked', async () => {
    // The server linked clients 1 and 2; the answer was lost; someone removed the link of client 1 in its card;
    // the link of client 3 cannot be read.
    const links = new Map<number, string | null>([[1, null], [2, 'K2']]);
    const reads: number[] = [];
    let sends = 0;
    const run = await runConfirmation(pairsOf(1, 2, 3), async () => { sends += 1; throw new Error('timeout'); }, 100);
    const verification = await verifyPairs(pairsToVerify(run), async (clientId) => {
      reads.push(clientId);
      if (!links.has(clientId)) throw new Error('500');
      return links.get(clientId) ?? null;
    }, 2);
    expect(sends).toBe(1);
    expect(reads.sort()).toEqual([1, 2, 3]);
    // The exact key is compared (case does not matter): client 2 is linked, client 1 is not, client 3 is unknown.
    expect(verification).toEqual({ linked: pairsOf(2), notLinked: pairsOf(1), unknown: pairsOf(3) });
    const summary = confirmSummary(run, verification, new Map([[1, 'Иванов']]));
    // Client 1 is NOT called skipped: the answer was lost, so the server may still be working and link it later.
    expect(summary).toEqual({
      linked: 1, refused: [],
      unknown: [{ clientId: 1, clientName: 'Иванов', state: 'pending' }, { clientId: 3, clientName: '#3', state: 'unreadable' }],
      notSent: 0,
    });
    expect(confirmHeadline(summary)).toBe('Сопоставлено: 1, результат неизвестен: 2');
  });

  it('bulk: the answer is lost, the read finds no link, then the original request links the client — the window never said «skipped»', async () => {
    // The request is still running on the server when the link is read.
    let link: string | null = null;
    const run = await runConfirmation(pairsOf(1), async () => { throw new Error('socket hang up'); }, 100);
    const verification = await verifyPairs(pairsToVerify(run), async () => link);
    link = 'k1'; // the late commit of the original request
    const summary = confirmSummary(run, verification, new Map([[1, 'Иванов']]));
    expect(summary.refused).toEqual([]);
    expect(summary.linked).toBe(0);
    expect(summary.unknown).toEqual([{ clientId: 1, clientName: 'Иванов', state: 'pending' }]);
  });

  it('bulk: an uncertain pair, the read finds no link, then the late commit links the client — never «skipped»; a found link is a proof', async () => {
    // The server answered `uncertain` (its commit was still being finished), the read on another connection saw null.
    const run = { results: [result(1, 'uncertain'), result(2, 'uncertain')], unanswered: [], notSent: [] };
    let late: string | null = null;
    const verification = await verifyPairs(pairsToVerify(run), async (clientId) => (clientId === 1 ? 'K1' : late));
    late = 'k2'; // the commit completes after the read
    expect(confirmSummary(run, verification, new Map([[2, 'Петров']]))).toEqual({
      linked: 1, refused: [], unknown: [{ clientId: 2, clientName: 'Петров', state: 'pending' }], notSent: 0,
    });
  });

  it('bulk: every unknown pair is named, however many', async () => {
    const ids = Array.from({ length: 100 }, (_, index) => index + 1);
    const run = await runConfirmation(pairsOf(...ids), async () => { throw new Error('502'); }, 100);
    const verification = await verifyPairs(pairsToVerify(run), async () => { throw new Error('502'); });
    const summary = confirmSummary(run, verification, new Map());
    expect(summary.unknown.map((pair) => pair.clientId)).toEqual(ids);
    expect(summary.unknown.every((pair) => pair.state === 'unreadable')).toBe(true);
    expect(confirmHeadline(summary)).toBe('Сопоставлено: 0, результат неизвестен: 100');
  });

  it('bulk: a client linked to another counterparty is not counted as linked by the verification', async () => {
    const verification = await verifyPairs(pairsOf(1), async () => 'other-key');
    expect(verification).toEqual({ linked: [], notLinked: pairsOf(1), unknown: [] });
    expect(await verifyPairs([], async () => null)).toEqual({ linked: [], notLinked: [], unknown: [] });
  });

  it('bulk: the window drops stale rows while it re-reads, ignores an older answer, never repeats a request and never infers success from the list', () => {
    const modal = read('./ClientCounterpartyBulkModal.tsx');
    // A new read first clears the rows and the selection; only the latest answer is applied.
    expect(modal).toMatch(/const epoch = \+\+loadRef\.current;\s*setLoading\(true\);\s*setData\(null\);\s*setSelected\(\[\]\);/);
    expect(modal).toMatch(/if \(epoch !== loadRef\.current\) return false;\s*setData\(result\);/);
    // Confirmation needs loaded, current rows.
    expect(modal).toMatch(/const ready = !busy && !loading && data !== null && chosen\.length > 0;/);
    expect(modal).toMatch(/const confirm = async \(\) => \{\s*if \(!ready\) return;/);
    expect(modal).toMatch(/disabled=\{!ready\}\s*onConfirm/);
    // One send per part, then verification by reading the link of each uncertain client.
    expect(modal.match(/confirmClientCounterparties\(/g)).toHaveLength(1);
    expect(modal).toMatch(/verification = await verifyPairs\(pairsToVerify\(run\), async \(clientId\) => \(await partyContactsApi\.clientCounterparty\(clientId\)\)\.refKey1c\);/);
    // The list is refreshed whatever the answers were; a pair missing from the list is never called linked.
    expect(modal).toMatch(/setOutcome\(result\);[^]*?onChanged\(\);\s*await load\(\);/);
    expect(modal).not.toMatch(/больше нет[^`'"]*сопоставлены/);
    // Unknown pairs are named with a link to the card of each client.
    expect(modal).toMatch(/outcome\.unknown\.map\(\(pair\) => \(\s*<li key=\{pair\.clientId\}>\s*<a href=\{`\/clients\/edit\/\$\{pair\.clientId\}`\}/);
    expect(modal).not.toMatch(/outcome\.unknown\.slice/);
  });

  it('bulk: counts clients in Russian', () => {
    expect([0, 1, 2, 4, 5, 11, 12, 21, 22, 25, 101, 111, 112].map(clientsCount)).toEqual([
      '0 клиентов', '1 клиент', '2 клиента', '4 клиента', '5 клиентов', '11 клиентов', '12 клиентов', '21 клиент', '22 клиента', '25 клиентов',
      '101 клиент', '111 клиентов', '112 клиентов',
    ]);
  });

  it('bulk: the window is opened from the clients list only with the right to change clients', () => {
    expect(read('./list.tsx')).toMatch(/\{can\("clients\.update"\) \? \(\s*<Button[^>]*onClick=\{\(\) => setMatchingOpen\(true\)\}>Сопоставить с 1С<\/Button>/);
    expect(read('./ClientCounterpartyBulkModal.tsx')).not.toMatch(/from 'antd'[^;]*\b(Table|Tooltip)\b/);
  });
});
