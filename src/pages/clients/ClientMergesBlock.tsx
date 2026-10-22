import React, { useState } from 'react';
import { Button, Tag, Typography } from 'antd';
import { Table } from '../../ui/tooltipDelay';
import type { ClientMergeHistory, MergeView } from '../../api/clientMergesApiTypes';
import { formatDateTime } from '../integrations/duplicatesModel';
import { countLines } from '../integrations/mergeClientsModel';
import { can } from '../../utils/permissions';
import { MERGE_STATUS_LABELS, mergeDirectionText, undoButtonVisible } from './clientMergesModel';
import { UndoMergeModal } from './UndoMergeModal';

const { Title, Text } = Typography;

export function ClientMergesBlock({ history, onChanged }: { history: ClientMergeHistory | null; onChanged: () => void }) {
  const [undoing, setUndoing] = useState<MergeView | null>(null);
  if (!history || history.merges.length === 0) return null;
  const canMerge = can('clients.merge');
  return (
    <>
      <Title level={5}>Объединения</Title>
      <Table
        size="small"
        rowKey="mergeId"
        pagination={false}
        dataSource={history.merges}
        style={{ marginBottom: 16 }}
        columns={[
          { title: 'Дата', key: 'at', render: (_: unknown, m: MergeView) => formatDateTime(m.mergedAt) },
          { title: 'Кто', key: 'by', render: (_: unknown, m: MergeView) => m.mergedBy.username || `#${m.mergedBy.userId}` },
          { title: 'Кого → с кем', key: 'dir', render: (_: unknown, m: MergeView) => mergeDirectionText(m) },
          {
            title: 'Статус',
            key: 'status',
            render: (_: unknown, m: MergeView) => (
              <>
                <Tag color={m.status === 'done' ? 'blue' : 'default'}>{MERGE_STATUS_LABELS[m.status]}</Tag>
                {m.status === 'undone' && m.undoneAt && (
                  <Text type="secondary">{formatDateTime(m.undoneAt)}{m.undoneBy ? ` · ${m.undoneBy.username || `#${m.undoneBy.userId}`}` : ''}</Text>
                )}
              </>
            ),
          },
          {
            title: 'Перенесено',
            key: 'counts',
            render: (_: unknown, m: MergeView) => countLines(m.counts).map((line) => `${line.label}: ${line.value}`).join('; ') || '—',
          },
          {
            title: '',
            key: 'actions',
            render: (_: unknown, m: MergeView) => undoButtonVisible(m, canMerge)
              ? <Button size="small" danger onClick={() => setUndoing(m)}>Отменить объединение</Button>
              : null,
          },
        ]}
      />
      <UndoMergeModal merge={undoing} onClose={() => setUndoing(null)} onChanged={onChanged} />
    </>
  );
}
