import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ApiError } from '../../api/apiError';
import type { ClientCounterparty } from '../../api/partyContactsApi';
import {
  clientLinkErrorMessage, counterpartyDetails, counterpartyOptions, isCounterpartyApiMissing, matchReasons, takenBy,
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
});
