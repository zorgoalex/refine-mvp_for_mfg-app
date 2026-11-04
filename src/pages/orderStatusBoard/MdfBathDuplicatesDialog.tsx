import React, { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, Button, Modal, Tag, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { orderStatusBoardApi } from '../../api/orderStatusBoardApi';
import type { CncTelegramBathCard } from '../../api/types/cncTelegramApi.types';
import type { MdfBathDuplicateAction } from '../../api/types/orderStatusBoardApi.types';
import { Segmented } from '../../ui/Segmented';
import { Tooltip } from '../../ui/tooltipDelay';
import {
  bathArchiveHint,
  bathDuplicateBadgeCount,
  bathDuplicateRows,
  bathHasDuplicates,
  bathReworkBadgeCount,
  newBathDuplicateIdempotencyKey,
  otherBathTitle,
  reverseBathDuplicate,
  type BathArchiveHintView,
} from './mdfBathDuplicates';

/** «Разобрать дубль» on the MDF board (RUNTIME_CONFIG_MDF_BATH_DUPLICATES): the page provides it, bath cards read it. */
export interface MdfBathDuplicatesContextValue {
  enabled: boolean;
  open: (bath: CncTelegramBathCard) => void;
}

export const MdfBathDuplicatesContext = createContext<MdfBathDuplicatesContextValue>({
  enabled: false,
  open: () => undefined,
});

/** Card badges: «Дубль: N дет.» opens the dialog, «Переделка: N дет.» shows a valid rework mark. */
export function MdfBathDuplicateBadges({ bath }: { bath: CncTelegramBathCard }) {
  const { enabled, open } = useContext(MdfBathDuplicatesContext);
  if (!enabled) return null;
  const duplicateCount = bathDuplicateBadgeCount(bath);
  const reworkCount = bathReworkBadgeCount(bath);
  if (!bathHasDuplicates(bath) && reworkCount === 0) return null;
  return (
    <span className="cnc-bath-card__duplicate-badges" onClick={(event) => event.stopPropagation()}>
      {bathHasDuplicates(bath) && (
        <Tooltip title="Разобрать дубль: эти детали есть и в другой активной ванне">
          <Button
            size="small"
            className="cnc-bath-card__duplicate-badge"
            danger={duplicateCount > 0}
            aria-haspopup="dialog"
            aria-label={`Разобрать дубль ванны: ${duplicateCount} общих деталей`}
            onClick={(event) => {
              event.stopPropagation();
              open(bath);
            }}
          >
            {duplicateCount > 0 ? `Дубль: ${duplicateCount} дет.` : 'Разобрать дубль'}
          </Button>
        </Tooltip>
      )}
      {reworkCount > 0 && (
        <Tag color="orange" className="cnc-bath-card__rework-badge">
          Переделка: {reworkCount} дет.
        </Tag>
      )}
    </span>
  );
}

interface Props {
  bath: CncTelegramBathCard;
  /** Every bath card on the board: the other side's own hint and number when it is shown too. */
  boardBaths: readonly CncTelegramBathCard[];
  canResolve: boolean;
  onClose: () => void;
  onResolved: () => void;
}

export function MdfBathDuplicatesDialog({ bath, boardBaths, canResolve, onClose, onResolved }: Props) {
  const pairs = useMemo(() => bath.duplicates ?? [], [bath.duplicates]);
  const [selected, setSelected] = useState(pairs[0]?.otherBathCardId ?? '');
  const [saving, setSaving] = useState<MdfBathDuplicateAction | null>(null);
  const savingRef = useRef(false);
  // One key per decision attempt: an explicit retry after a network error resends the same decision.
  const attempt = useRef<{ signature: string; key: string } | null>(null);
  useEffect(() => {
    if (!pairs.some(pair => pair.otherBathCardId === selected)) setSelected(pairs[0]?.otherBathCardId ?? '');
  }, [pairs, selected]);
  const entry = pairs.find(pair => pair.otherBathCardId === selected) ?? pairs[0];
  const thisNumber = bath.displayCutNumber ?? bath.cutNumber;

  const resolve = async (action: MdfBathDuplicateAction) => {
    if (!entry || savingRef.current) return;
    const request = { bathCardId: bath.bathCardId, otherBathCardId: entry.otherBathCardId, action,
      expectedDigest: entry.digest };
    const signature = JSON.stringify(request);
    if (attempt.current?.signature !== signature) attempt.current = { signature, key: newBathDuplicateIdempotencyKey() };
    savingRef.current = true;
    setSaving(action);
    try {
      await orderStatusBoardApi.resolveMdfBathDuplicate(request, attempt.current.key);
      attempt.current = null;
      message.success(action === 'keep_both'
        ? 'Дубль разобран: оставлены обе ванны'
        : 'Общие детали ванны помечены как переделка');
      onResolved();
      onClose();
    } catch (error) {
      if (isApiError(error, 'MDF_BATH_DUPLICATE_STALE')) {
        attempt.current = null;
        message.warning('Ванны изменились — доска обновлена, откройте дубль заново.');
        onResolved();
        onClose();
      } else {
        message.error(isApiError(error) || error instanceof Error ? error.message : 'Не удалось разобрать дубль.');
      }
    } finally {
      savingRef.current = false;
      setSaving(null);
    }
  };

  if (!entry) return null;
  const other = reverseBathDuplicate(boardBaths, bath, entry);
  const rows = bathDuplicateRows(bath, entry);
  const hints: Array<{ title: string; hint: BathArchiveHintView }> = [
    { title: `Ванна ${thisNumber}`, hint: bathArchiveHint(bath, entry) },
    ...(other ? [{ title: `Ванна ${other.bath.displayCutNumber ?? other.bath.cutNumber}`,
      hint: bathArchiveHint(other.bath, other.entry) }] : []),
  ];

  return (
    <Modal
      open
      title={`Разобрать дубль · ванна ${thisNumber}`}
      onCancel={onClose}
      width={720}
      footer={[
        <Button key="close" onClick={onClose} disabled={saving !== null}>Закрыть</Button>,
        <Button key="rework" onClick={() => void resolve('rework_mark')} loading={saving === 'rework_mark'}
          disabled={!canResolve || saving !== null}>
          Пометить общие детали этой ванны как переделку
        </Button>,
        <Button key="keep" type="primary" onClick={() => void resolve('keep_both')} loading={saving === 'keep_both'}
          disabled={!canResolve || saving !== null}>
          Оставить обе
        </Button>,
      ]}
    >
      {pairs.length > 1 && (
        <Segmented
          block
          value={entry.otherBathCardId}
          onChange={(value) => setSelected(String(value))}
          options={pairs.map(pair => ({ value: pair.otherBathCardId, label: otherBathTitle(pair) }))}
        />
      )}
      <div className="mdf-bath-duplicates__baths" aria-label="Ванны с общими деталями">
        <div>
          <div className="mdf-bath-duplicates__label">Эта ванна</div>
          <div>{thisNumber} · {bath.cutJobName}</div>
        </div>
        <div>
          <div className="mdf-bath-duplicates__label">Другая ванна</div>
          <div>{other ? `${other.bath.displayCutNumber ?? other.bath.cutNumber} · ` : ''}{otherBathTitle(entry)}</div>
        </div>
      </div>
      <p>
        Общих деталей: {entry.sharedCount}
        {entry.shared.length < entry.sharedCount ? ` (показаны ${entry.shared.length} — по доступным заказам)` : ''}
        {entry.coveredBy ? '. Все детали этой ванны есть в другой.' : '.'}
      </p>
      <table className="mdf-bath-duplicates__table" aria-label="Общие детали">
        <thead>
          <tr><th>Заказ</th><th>№</th><th>Здесь</th><th>Там</th></tr>
        </thead>
        <tbody>
          {rows.map(row => (
            <tr key={row.key}>
              <td>{row.orderName}</td>
              <td>{row.detailNumber ?? '—'}</td>
              <td>{row.here}</td>
              <td className={row.there < row.here ? 'mdf-bath-duplicates__short' : undefined}>{row.there}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {entry.resolvedAction === 'rework_mark' && (
        <Alert type="info" showIcon message="Общие детали этой пары уже помечены как переделка." />
      )}
      {hints.map(({ title, hint }) => (
        <Alert
          key={title}
          type={hint.tone}
          showIcon
          className="mdf-bath-duplicates__hint"
          message={`${title}: ${hint.text}`}
          description={hint.href ? <a href={hint.href} target="_blank" rel="noreferrer">Открыть задание в «Раскрое»</a> : undefined}
        />
      ))}
      {!canResolve && (
        <Alert type="warning" showIcon message="Разбор дубля доступен с правами раскроя (cut.manage) и просмотра заказов." />
      )}
    </Modal>
  );
}
