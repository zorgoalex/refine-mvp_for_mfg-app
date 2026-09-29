import React, { useMemo, useState } from 'react';
import { Alert, Button, Card, Empty, Input, Space, Tag, Typography } from 'antd';
import { ReloadOutlined } from '@ant-design/icons';
import { Table, Tooltip } from '../../../ui/tooltipDelay';
import { whatsappApi } from '../../../api/whatsappApi';
import type { WhatsAppGroupDto, WhatsAppGroupsResponse } from '../../../api/types/whatsappApi.types';
import {
  filterGroups,
  formatFetchedAt,
  groupDisplayName,
  groupWarnings,
  groupsErrorText,
} from './whatsappGroupsView';

const { Text } = Typography;

export const WhatsAppGroupsCard: React.FC = () => {
  const [data, setData] = useState<WhatsAppGroupsResponse | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState('');

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      setData(await whatsappApi.groups({ refresh: data !== null }));
    } catch (loadError) {
      setError(groupsErrorText(loadError));
    } finally {
      setLoading(false);
    }
  };

  const rows = useMemo(() => filterGroups(data?.groups ?? [], search), [data, search]);
  const fetchedAt = data ? formatFetchedAt(data.fetchedAt) : '';

  return (
    <Card title="Группы аккаунта" className="whatsapp-config__groups">
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space wrap>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>
            {data ? 'Обновить' : 'Загрузить группы'}
          </Button>
          {data && fetchedAt ? (
            <Text type="secondary">{`Обновлено ${fetchedAt}${data.cached ? ' (из кэша)' : ''}`}</Text>
          ) : null}
          {data ? (
            <Input.Search
              allowClear
              placeholder="Поиск по названию или ID"
              style={{ width: 280 }}
              value={search}
              onChange={(event) => setSearch(event.target.value)}
            />
          ) : null}
        </Space>
        {error ? <Alert type="error" showIcon message={error} /> : null}
        {data?.truncated ? (
          <Alert
            type="warning"
            showIcon
            message="Показана только часть групп (лимит 1000). Уточните поиск или укажите ID вручную."
          />
        ) : null}
        {data ? (
          <Table<WhatsAppGroupDto>
            rowKey="id"
            size="small"
            loading={loading}
            dataSource={rows}
            pagination={{ pageSize: 20, hideOnSinglePage: true, showSizeChanger: false }}
            locale={{
              emptyText: (
                <Empty
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description={data.groups.length === 0 ? 'Аккаунт не состоит ни в одной группе' : 'Ничего не найдено'}
                />
              ),
            }}
            columns={[
              { title: 'Название', key: 'name', render: (_: unknown, group: WhatsAppGroupDto) => groupDisplayName(group) },
              {
                title: 'Участников',
                dataIndex: 'participantCount',
                key: 'participantCount',
                width: 110,
                render: (count: number | null) => (count === null ? '—' : count),
              },
              {
                title: 'ID группы',
                dataIndex: 'id',
                key: 'id',
                render: (id: string) => (
                  <Text code copyable={{ text: id }} style={{ fontFamily: 'monospace' }}>{id}</Text>
                ),
              },
              {
                title: 'Пометки',
                key: 'warnings',
                render: (_: unknown, group: WhatsAppGroupDto) => (
                  <Space size={4} wrap>
                    {groupWarnings(group).map((warning) => (
                      <Tooltip key={warning.key} title={warning.text}>
                        <Tag color="warning">{warning.label}</Tag>
                      </Tooltip>
                    ))}
                  </Space>
                ),
              },
            ]}
          />
        ) : null}
      </Space>
    </Card>
  );
};
