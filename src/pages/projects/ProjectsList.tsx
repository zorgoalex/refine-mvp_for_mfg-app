import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useSelect } from '@refinedev/antd';
import { Input, Select, Space, Table, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigate } from 'react-router-dom';
import { projectsApi } from '../../api/projectsApi';
import type { ProjectDto } from '../../api/projectsApi';
import { formatProjectRow, type ProjectRow } from './projectHelpers';

const { Title } = Typography;

export const ProjectsList: React.FC = () => {
  const navigate = useNavigate();
  const [rows, setRows] = useState<ProjectRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [searchInput, setSearchInput] = useState('');
  const [debouncedSearch, setDebouncedSearch] = useState('');
  const [selectedClientId, setSelectedClientId] = useState<number | undefined>(undefined);

  const { selectProps: clientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
  });

  useEffect(() => {
    const timeoutId = setTimeout(() => {
      setDebouncedSearch(searchInput.trim());
    }, 300);

    return () => clearTimeout(timeoutId);
  }, [searchInput]);

  const loadProjects = useCallback(async () => {
    setLoading(true);
    try {
      const response = await projectsApi.list({
        search: debouncedSearch || undefined,
        clientId: selectedClientId,
      });
      setRows(response.map((project: ProjectDto) => formatProjectRow(project)));
    } catch (error) {
      message.error(error instanceof Error ? error.message : 'Не удалось загрузить проекты');
    } finally {
      setLoading(false);
    }
  }, [debouncedSearch, selectedClientId]);

  useEffect(() => {
    void loadProjects();
  }, [loadProjects]);

  const columns = useMemo<ColumnsType<ProjectRow>>(
    () => [
      {
        title: 'Код',
        dataIndex: 'code',
        key: 'code',
        width: 140,
      },
      {
        title: 'Имя',
        dataIndex: 'name',
        key: 'name',
      },
      {
        title: 'Клиент',
        dataIndex: 'clientLabel',
        key: 'clientLabel',
      },
      {
        title: 'Заказов',
        dataIndex: 'ordersCountLabel',
        key: 'ordersCountLabel',
        width: 120,
      },
      {
        title: 'Сумма',
        dataIndex: 'totalFinalAmountLabel',
        key: 'totalFinalAmountLabel',
        width: 150,
      },
      {
        title: 'Оплачено',
        dataIndex: 'totalPaidAmountLabel',
        key: 'totalPaidAmountLabel',
        width: 150,
      },
    ],
    [],
  );

  return (
    <div style={{ padding: 24 }}>
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Title level={3} style={{ margin: 0 }}>
          Проекты
        </Title>

        <Space wrap>
          <Input
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Поиск по коду или имени"
            allowClear
            style={{ width: 280 }}
          />
          <Select
            {...clientSelectProps}
            value={selectedClientId}
            onChange={(value) => setSelectedClientId(value)}
            placeholder="Клиент"
            allowClear
            showSearch
            style={{ width: 280 }}
          />
        </Space>

        <Table<ProjectRow>
          rowKey="projectId"
          columns={columns}
          dataSource={rows}
          loading={loading}
          onRow={(record) => ({
            onClick: () => navigate(`/projects/show/${record.projectId}`),
            style: { cursor: 'pointer' },
          })}
        />
      </Space>
    </div>
  );
};
