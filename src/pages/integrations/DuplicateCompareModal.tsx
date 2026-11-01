import React, { useMemo, useState } from 'react';
import { Checkbox, Modal, Space, Tag, Typography, theme } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { Link } from 'react-router-dom';
import { Table } from '../../ui/tooltipDelay';
import type { DuplicateMemberDetail } from '../../api/integrationDuplicatesApiTypes';
import { DUPLICATE_SYSTEM_COLORS, DUPLICATE_SYSTEM_LABELS, memberErpLink, memberName } from './duplicatesModel';
import { buildCompareRows, compareMembers, type CompareRow } from './duplicateCompareModel';

const { Text } = Typography;

interface Props {
  open: boolean;
  caseId: number | null;
  members: DuplicateMemberDetail[];
  onClose: () => void;
}

/** Fields of every duplicate of the case side by side: rows — fields, columns — records; differences are marked. */
export function DuplicateCompareModal({ open, caseId, members, onClose }: Props) {
  const { token } = theme.useToken();
  const [onlyDiffs, setOnlyDiffs] = useState(false);
  const [includeLeft, setIncludeLeft] = useState(false);
  const hasLeft = members.some((member) => member.leftAt);
  const shown = useMemo(() => compareMembers(members, includeLeft), [members, includeLeft]);
  const rows = useMemo(() => buildCompareRows(shown), [shown]);
  const visibleRows = onlyDiffs ? rows.filter((row) => row.differs) : rows;
  const diffCount = rows.filter((row) => row.differs).length;

  const columns: ColumnsType<CompareRow> = [
    {
      key: 'label',
      title: 'Поле',
      dataIndex: 'label',
      fixed: 'left',
      width: 200,
      render: (label: string, row) => (row.differs ? <Text strong>{label}</Text> : label),
    },
    ...shown.map((member, index) => {
      const link = memberErpLink(member);
      return {
        key: `${member.system}:${member.recordKey}`,
        width: 220,
        title: (
          <Space direction="vertical" size={2}>
            <Space size={4} wrap>
              <Tag color={DUPLICATE_SYSTEM_COLORS[member.system]} style={{ marginInlineEnd: 0 }}>
                {DUPLICATE_SYSTEM_LABELS[member.system]}
              </Tag>
              {member.leftAt && <Tag>ушла</Tag>}
            </Space>
            <span>{member.name ?? <Text type="secondary">{memberName(member)}</Text>}</span>
            {link && <Link to={link} onClick={onClose}>Открыть карточку</Link>}
          </Space>
        ),
        onCell: (row: CompareRow) => ({
          style: row.differs && !row.cells[index].hidden ? { background: token.colorWarningBg } : undefined,
        }),
        render: (_: unknown, row: CompareRow) => {
          const value = row.cells[index];
          return value.hidden ? <Text type="secondary">{value.text}</Text> : value.text;
        },
      };
    }),
  ];

  return (
    <Modal
      open={open}
      title={caseId != null ? `Сравнение записей · дело #${caseId}` : 'Сравнение записей'}
      onCancel={onClose}
      footer={null}
      width="min(1200px, 95vw)"
      destroyOnClose
    >
      <Space direction="vertical" size="small" style={{ width: '100%' }}>
        <Space wrap>
          <Checkbox checked={onlyDiffs} onChange={(event) => setOnlyDiffs(event.target.checked)}>
            Только различия ({diffCount})
          </Checkbox>
          {hasLeft && (
            <Checkbox checked={includeLeft} onChange={(event) => setIncludeLeft(event.target.checked)}>
              Показать ушедшие из дела
            </Checkbox>
          )}
        </Space>
        <Table<CompareRow>
          size="small"
          bordered
          rowKey="label"
          columns={columns}
          dataSource={visibleRows}
          pagination={false}
          scroll={{ x: 200 + shown.length * 220 }}
          locale={{ emptyText: onlyDiffs ? 'Различий нет' : 'Нет записей' }}
        />
      </Space>
    </Modal>
  );
}
