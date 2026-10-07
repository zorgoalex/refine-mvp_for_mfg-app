import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Popconfirm, Progress, Radio, Space, Tag, Typography } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import {
  CLIENT_CONFIRM_MAX, partyContactsApi,
  type ClientCounterpartyAmbiguity, type ClientCounterpartyMatch, type ClientCounterpartyMatches, type ClientMatchStrength,
} from '../../api/partyContactsApi';
import {
  STRENGTH_COLORS, STRENGTH_LABELS, UNKNOWN_STATE_LABELS, clientsCount, confirmHeadline, confirmSummary, counterpartyDetails, defaultSelection, matchReasons, pairsToVerify,
  runConfirmation, verifyPairs,
  type ConfirmSummary,
} from './clientCounterpartyModel';

interface Props {
  open: boolean;
  onClose: () => void;
  /** Something was linked: the list behind the window is stale. */
  onChanged: () => void;
}

type View = ClientMatchStrength | 'ambiguous';

/**
 * Bulk confirmation of client ↔ 1C counterparty pairs. Only unambiguous pairs can be confirmed here (one exact
 * candidate for the client, free, and not a candidate of another client); the rest is resolved in the card.
 */
export const ClientCounterpartyBulkModal: React.FC<Props> = ({ open, onClose, onChanged }) => {
  const [data, setData] = useState<ClientCounterpartyMatches | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<View>('both');
  const [selected, setSelected] = useState<number[]>([]);
  const [progress, setProgress] = useState<{ done: number; total: number } | null>(null);
  const [outcome, setOutcome] = useState<ConfirmSummary | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const loadRef = useRef(0);

  /**
   * Reads the view. Only the answer of the latest read is used (reopening the window starts a new one), and
   * until it comes nothing can be confirmed: the previous rows and selection are dropped first.
   */
  const load = useCallback(async (): Promise<boolean> => {
    const epoch = ++loadRef.current;
    setLoading(true);
    setData(null);
    setSelected([]);
    try {
      const result = await partyContactsApi.clientCounterpartyMatches();
      if (epoch !== loadRef.current) return false;
      setData(result);
      setSelected(defaultSelection(result.matches));
      setError(null);
      return true;
    } catch (failure) {
      if (epoch !== loadRef.current) return false;
      setError(`Список совпадений не загружен: ${failure instanceof Error ? failure.message : 'ошибка запроса'}. Закройте окно и откройте его снова.`);
      return false;
    } finally {
      if (epoch === loadRef.current) setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!open) { loadRef.current += 1; return; }
    setOutcome(null);
    setNote(null);
    void load();
  }, [open, load]);

  const shown = useMemo(() => (data?.matches ?? []).filter((match) => match.strength === view), [data, view]);
  const chosen = useMemo(() => (data?.matches ?? []).filter((match) => selected.includes(match.clientId)), [data, selected]);
  const busy = progress !== null;
  /** Nothing is sent from rows that are being re-read or failed to load. */
  const ready = !busy && !loading && data !== null && chosen.length > 0;

  const confirm = async () => {
    if (!ready) return;
    const names = new Map(chosen.map((match) => [match.clientId, match.clientName] as const));
    const pairs = chosen.map((match) => ({ clientId: match.clientId, refKey1c: match.counterparty.refKey1c }));
    setProgress({ done: 0, total: pairs.length });
    setOutcome(null);
    setNote(null);
    let run: Awaited<ReturnType<typeof runConfirmation>>;
    let verification: Awaited<ReturnType<typeof verifyPairs>>;
    try {
      run = await runConfirmation(pairs, (part) => partyContactsApi.confirmClientCounterparties(part), CLIENT_CONFIRM_MAX,
        (done) => setProgress({ done, total: pairs.length }));
      // Nothing is sent twice: pairs without a certain answer are checked by reading the link of each client.
      verification = await verifyPairs(pairsToVerify(run), async (clientId) => (await partyContactsApi.clientCounterparty(clientId)).refKey1c);
    } finally {
      setProgress(null);
    }
    const result = confirmSummary(run, verification, names);
    setOutcome(result);
    // Something was sent: the list behind the window may be stale whatever the answers were.
    onChanged();
    await load();
    const notes = [
      run.failure ? `Ответ сервера на часть запроса не получен (${run.failure}). Повторно ничего не отправлялось; состояние этих пар прочитано один раз.` : null,
      result.unknown.length > 0 ? `Результат по ${clientsCount(result.unknown.length)} неизвестен: точного ответа нет, а запись могла ещё выполняться. Все они перечислены ниже — откройте их карточки или это окно через минуту.` : null,
      result.notSent > 0 ? `Не отправлено: ${result.notSent} — эти пары остались в списке, их можно подтвердить ещё раз.` : null,
    ].filter(Boolean);
    setNote(notes.length > 0 ? notes.join(' ') : null);
  };

  const summary = data?.summary;
  const options = [
    { value: 'both' as View, label: `Имя и телефон (${summary?.both ?? 0})` },
    { value: 'phone' as View, label: `Только телефон (${summary?.phone ?? 0})` },
    { value: 'name' as View, label: `Только имя (${summary?.name ?? 0})` },
    { value: 'ambiguous' as View, label: `Неоднозначные (${summary?.ambiguous ?? 0})` },
  ];

  return (
    <Modal
      open={open}
      title="Сопоставление клиентов с контрагентами 1С"
      width={1100}
      onCancel={() => { if (!busy) onClose(); }}
      maskClosable={!busy}
      footer={[
        <Button key="close" onClick={onClose} disabled={busy}>Закрыть</Button>,
        <Popconfirm
          key="confirm"
          title={`Сопоставить ${clientsCount(chosen.length)} с выбранными контрагентами 1С?`}
          okText="Сопоставить"
          cancelText="Отмена"
          disabled={!ready}
          onConfirm={() => { void confirm(); }}
        >
          <Button type="primary" disabled={!ready} loading={busy}>Сопоставить выбранные ({chosen.length})</Button>
        </Popconfirm>,
      ]}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data && !data.available ? <Alert type="warning" showIcon message="Контрагенты 1С ещё не загружены — сопоставлять не с чем." /> : null}
        {summary ? (
          <Typography.Text>
            Активных клиентов: {summary.clients}. Сопоставлено: {summary.linked}. Можно подтвердить здесь: {summary.both + summary.phone + summary.name}.
            {' '}Неоднозначных: {summary.ambiguous}. Без совпадений в 1С: {summary.none}.
          </Typography.Text>
        ) : null}
        <Typography.Text type="secondary">
          Здесь только пары без разночтений: у клиента ровно один контрагент 1С с тем же именем или телефоном, он свободен и не подходит другому клиенту.
          Заранее отмечены пары, где совпали и имя, и телефон; остальные отметьте сами, если уверены.
        </Typography.Text>
        {busy ? <Progress percent={Math.round((progress.done / Math.max(progress.total, 1)) * 100)} format={() => `${progress.done} из ${progress.total}`} /> : null}
        {outcome ? (
          <Alert
            type={outcome.refused.length > 0 || outcome.unknown.length > 0 || outcome.notSent > 0 ? 'warning' : 'success'}
            showIcon
            message={confirmHeadline(outcome)}
            description={outcome.refused.length > 0 || outcome.unknown.length > 0 || note ? (
              <>
                {note ? <div>{note}</div> : null}
                {outcome.unknown.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 220, overflowY: 'auto' }}>
                    {outcome.unknown.map((pair) => (
                      <li key={pair.clientId}>
                        <a href={`/clients/edit/${pair.clientId}`} target="_blank" rel="noreferrer">{pair.clientName}</a> — {UNKNOWN_STATE_LABELS[pair.state]}
                      </li>
                    ))}
                  </ul>
                ) : null}
                {outcome.refused.length > 0 ? (
                  <ul style={{ margin: 0, paddingLeft: 18 }}>
                    {outcome.refused.slice(0, 20).map((line) => <li key={line}>{line}</li>)}
                    {outcome.refused.length > 20 ? <li>и ещё {outcome.refused.length - 20}</li> : null}
                  </ul>
                ) : null}
              </>
            ) : undefined}
          />
        ) : null}
        <Radio.Group
          optionType="button"
          options={options}
          value={view}
          onChange={(event) => setView(event.target.value as View)}
          disabled={busy}
        />
        {view === 'ambiguous' ? (
          <Table<ClientCounterpartyAmbiguity>
            size="small"
            loading={loading}
            rowKey="clientId"
            dataSource={data?.ambiguous ?? []}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            columns={[
              {
                title: 'Клиент', dataIndex: 'clientName',
                render: (name: string, row) => <a href={`/clients/edit/${row.clientId}`} target="_blank" rel="noreferrer">{name}</a>,
              },
              {
                title: 'Подходящие контрагенты 1С — выберите в карточке клиента', dataIndex: 'candidates',
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    {row.candidates.slice(0, 5).map((candidate) => (
                      <span key={candidate.refKey1c}>{candidate.name} <Typography.Text type="secondary">— {matchReasons(candidate.matchedBy)}</Typography.Text></span>
                    ))}
                    {row.candidates.length > 5 ? <Typography.Text type="secondary">и ещё {row.candidates.length - 5}</Typography.Text> : null}
                  </Space>
                ),
              },
            ]}
          />
        ) : (
          <Table<ClientCounterpartyMatch>
            size="small"
            loading={loading}
            rowKey="clientId"
            dataSource={shown}
            pagination={{ pageSize: 15, showSizeChanger: false }}
            rowSelection={{
              selectedRowKeys: selected,
              preserveSelectedRowKeys: true,
              getCheckboxProps: () => ({ disabled: busy }),
              onChange: (keys) => {
                // Selection of the other views is kept: only the keys of the shown view change.
                const visible = new Set(shown.map((match) => match.clientId));
                setSelected([...selected.filter((id) => !visible.has(id)), ...keys.map(Number).filter((id) => visible.has(id))]);
              },
            }}
            columns={[
              {
                title: 'Клиент ERP', dataIndex: 'clientName',
                render: (name: string, row) => (
                  <Space direction="vertical" size={0}>
                    <a href={`/clients/edit/${row.clientId}`} target="_blank" rel="noreferrer">{name}</a>
                    {row.clientPhones.length > 0 ? <Typography.Text type="secondary">{row.clientPhones.slice(0, 3).join(', ')}</Typography.Text> : null}
                  </Space>
                ),
              },
              {
                title: 'Контрагент 1С', dataIndex: 'counterparty',
                render: (_: unknown, row) => (
                  <Space direction="vertical" size={0}>
                    <span>{row.counterparty.name}</span>
                    {counterpartyDetails(row.counterparty) ? <Typography.Text type="secondary">{counterpartyDetails(row.counterparty)}</Typography.Text> : null}
                  </Space>
                ),
              },
              {
                title: 'Совпало', dataIndex: 'strength', width: 150,
                render: (strength: ClientMatchStrength) => <Tag color={STRENGTH_COLORS[strength]}>{STRENGTH_LABELS[strength]}</Tag>,
              },
            ]}
          />
        )}
      </Space>
    </Modal>
  );
};
