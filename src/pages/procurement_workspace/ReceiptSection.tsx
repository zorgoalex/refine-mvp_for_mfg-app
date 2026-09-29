import { Alert, Select } from 'antd';
import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import type { OnecDocumentListItemDto } from '../../api/types/onecDocumentsApi.types';
import { formatDate } from '../../utils/dateFormat';
import { AllocationSuggestionPanel } from '../onec_purchase_documents/AllocationSuggestionPanel';
import { allocationStateLabel } from '../onec_purchase_documents/onecDocumentsHelpers';

export interface ReceiptSectionProps {
  /** Раздел виден: иначе без опроса сервера (та же логика, что у `WorklistSection`). */
  active: boolean;
}

type LoadState =
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OnecDocumentListItemDto[] };

const RECEIPT_PARAM = 'receipt';
/** Не полностью распределённые приходы — выше в списке (план §6, «по умолчанию — не полностью распределённые»). */
const ALLOCATION_STATE_RANK: Record<OnecDocumentListItemDto['allocationState'], number> = { none: 0, partial: 0, full: 1 };

/**
 * «Приход 1С» на экране снабжения: выбор недавнего проведённого прихода + тот же
 * `AllocationSuggestionPanel`, что и в карточке документа 1С. Выбранный документ — в
 * адресе (`receipt=`).
 */
export function ReceiptSection({ active }: ReceiptSectionProps) {
  const [searchParams, setSearchParams] = useSearchParams();
  const [state, setState] = useState<LoadState>({ status: 'loading' });
  const [revision, setRevision] = useState(0);

  useEffect(() => {
    if (!active) return undefined;
    let alive = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    onecDocumentsApi.list({ tab: 'receipts', postedOnly: true, page: 1, pageSize: 50 })
      .then((response) => { if (alive) setState({ status: 'ready', data: sortReceipts(response.data) }); })
      .catch((error: unknown) => {
        if (alive) setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить приходы 1С' });
      });
    return () => { alive = false; };
  }, [active, revision]);

  const documents = state.status === 'ready' ? state.data : EMPTY_DOCUMENTS;
  const requestedId = Number(searchParams.get(RECEIPT_PARAM));
  const selectedId = documents.some((document) => document.documentId === requestedId)
    ? requestedId
    : documents[0]?.documentId ?? null;

  // Список загрузился и в адресе не было валидного `receipt=` — подставляем документ по умолчанию.
  useEffect(() => {
    if (state.status !== 'ready' || selectedId == null || requestedId === selectedId) return;
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set(RECEIPT_PARAM, String(selectedId));
      return params;
    }, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.status, selectedId]);

  const setSelected = (documentId: number) => setSearchParams((current) => {
    const params = new URLSearchParams(current);
    params.set(RECEIPT_PARAM, String(documentId));
    return params;
  }, { replace: true });

  const selected = documents.find((document) => document.documentId === selectedId) ?? null;

  return (
    <div>
      <div className="rr-appbar">
        <span className="rr-ttl">
          {selected ? `Поступление ${selected.number} от ${formatDate(selected.date)}` : 'Приход 1С: подобрать заказы'}
        </span>
        {selected && <span className="rr-tag rr-tag--ok">проведён</span>}
        {selected && (
          <span className="rr-muted">
            {selected.supplierName ?? selected.counterpartyName ?? '—'} · {selected.linesCount} стр. · {allocationStateLabel(selected.allocationState)}
          </span>
        )}
        <span style={{ flex: 1 }} />
      <Select<number>
        showSearch
        style={{ width: 360 }}
        placeholder="Выберите приход 1С"
        loading={state.status === 'loading'}
        value={selectedId ?? undefined}
        onChange={setSelected}
        optionFilterProp="label"
        notFoundContent={state.status === 'ready' ? 'Нет проведённых приходов' : undefined}
        options={documents.map((document) => ({
          value: document.documentId,
          label: `№${document.number} от ${formatDate(document.date)} · ${document.supplierName ?? document.counterpartyName ?? '—'} · ${allocationStateLabel(document.allocationState)}`,
        }))}
      />
      </div>

      {state.status === 'error' && <div className="rr-pad"><Alert type="error" showIcon message={state.message} /></div>}
      {state.status === 'ready' && documents.length === 0 && (
        <div className="rr-pad"><div className="rr-hint-box">Проведённых приходов 1С пока нет — они появятся после загрузки документов из 1С.</div></div>
      )}

      {selectedId != null && (
        <AllocationSuggestionPanel
          key={`${selectedId}:${revision}`}
          documentId={selectedId}
          onDone={() => setRevision((value) => value + 1)}
        />
      )}
    </div>
  );
}

function sortReceipts(data: OnecDocumentListItemDto[]): OnecDocumentListItemDto[] {
  return [...data].sort((a, b) => ALLOCATION_STATE_RANK[a.allocationState] - ALLOCATION_STATE_RANK[b.allocationState]);
}

const EMPTY_DOCUMENTS: OnecDocumentListItemDto[] = [];
