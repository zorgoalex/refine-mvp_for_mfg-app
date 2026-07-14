// Ячейка «Примечания» панели: текст + инлайн-редактор (✎ → Input; Enter или
// blur = сохранить, Esc = отмена — blur после Esc НЕ сохраняет). Сохранение —
// backend-команда PATCH nodes/:id/notes; успех отдаётся родителю вместе с
// epoch (stale-guard при смене ревизии).

import React, { useRef, useState } from 'react';
import { EditOutlined } from '@ant-design/icons';
import { Button, Input, Space, Tooltip, Typography, notification } from 'antd';
import { bazisApi } from '../../api/bazisApi';
import {
  NODE_NOTES_MAX_LENGTH,
  normalizeNotesInput,
  shouldSaveOnBlur,
  type NotesCloseReason,
} from './panelNotesEditor';

const { Text } = Typography;

interface PanelNotesCellProps {
  nodeId: number;
  notes: string | null;
  canManage: boolean;
  /** Эпоха данных PanelsTab на момент рендера (см. notesEpochRef). */
  epoch: number;
  onSaved: (nodeId: number, notes: string | null, epoch: number) => void;
}

export const PanelNotesCell: React.FC<PanelNotesCellProps> = ({
  nodeId,
  notes,
  canManage,
  epoch,
  onSaved,
}) => {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const closeReasonRef = useRef<NotesCloseReason>('none');

  const startEdit = () => {
    closeReasonRef.current = 'none';
    setValue(notes ?? '');
    setEditing(true);
  };

  const save = async () => {
    if (busy) {
      return;
    }
    const next = normalizeNotesInput(value);
    if (next === (notes ?? null)) {
      setEditing(false);
      return;
    }
    setBusy(true);
    try {
      const saved = await bazisApi.setNodeNotes(nodeId, next);
      onSaved(nodeId, saved.notes, epoch);
      setEditing(false);
    } catch (error) {
      // Ошибка: остаёмся в редакторе с введённым значением, даём повторить.
      closeReasonRef.current = 'none';
      notification.error({
        message: 'Не удалось сохранить примечание',
        description: error instanceof Error ? error.message : 'Повторите попытку позже',
      });
    } finally {
      setBusy(false);
    }
  };

  if (editing) {
    return (
      <Input
        size="small"
        autoFocus
        value={value}
        maxLength={NODE_NOTES_MAX_LENGTH}
        disabled={busy}
        onChange={(event) => setValue(event.target.value)}
        onClick={(event) => event.stopPropagation()}
        onPressEnter={() => {
          closeReasonRef.current = 'commit';
          void save();
        }}
        onBlur={() => {
          if (shouldSaveOnBlur(closeReasonRef.current, busy)) {
            closeReasonRef.current = 'commit';
            void save();
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.stopPropagation();
            if (!busy) {
              closeReasonRef.current = 'cancel';
              setEditing(false);
            }
          }
        }}
      />
    );
  }

  return (
    <Space size={4} onClick={(event) => event.stopPropagation()}>
      <Tooltip title={notes?.trim() || undefined}>
        <Text ellipsis style={{ maxWidth: 180 }}>
          {notes?.trim() || '—'}
        </Text>
      </Tooltip>
      {canManage ? (
        <Tooltip title="Изменить примечание">
          <Button type="text" size="small" icon={<EditOutlined />} onClick={startEdit} />
        </Tooltip>
      ) : null}
    </Space>
  );
};
