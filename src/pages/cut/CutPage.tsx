import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import { ApiError } from '../../api/httpClient';
import type {
  CutGroupDto,
  CutJobDto,
  EligibleDetailDto,
} from '../../api/types/cutApi.types';
import { can } from '../../utils/permissions';
import {
  CUT_JOB_STATUS_FILTER_ALL,
  CUT_JOB_STATUS_FILTER_OPTIONS,
  cutJobCounts,
  cutJobSourceLabel,
  cutJobStatusLabel,
  filterJobsByStatus,
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  pollPdf,
  selectableDetailIds,
  triggerBlobDownload,
} from './cutPageHelpers';

// Built-in fallback preset names (used until the backend config list loads).
const DEFAULT_PRESET_OPTIONS = [
  { value: 'thumb', label: 'thumb' },
  { value: 'screen', label: 'screen' },
  { value: 'print', label: 'print' },
];

const { Title, Text } = Typography;

const INELIGIBLE_LABELS: Record<string, string> = {
  deleted: 'Удалена',
  already_reserved: 'Уже в раскрое',
  wrong_status: 'Неподходящий статус',
  no_sheet_spec: 'Нет спецификации',
};

const STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'default',
  calculating: 'processing',
  ready: 'green',
  failed: 'red',
  archived: 'default',
};

/**
 * Backend-owned /cut page (CLAUDE.md principle 2/3): all reads and commands go
 * through cutApi (`/api/v1/cut-jobs`); the read-layer is never written from here.
 * Flow: criteria -> draft job -> eligible details (no_sheet_spec surfaced) ->
 * basket -> calculate -> per-sheet PNG.
 */
export const CutPage: React.FC = () => {
  const canManage = can('cut.manage');
  const [form] = Form.useForm<{ name: string; orderIds?: string; materialIds?: string; filmIds?: string }>();
  const [job, setJob] = useState<CutJobDto | null>(null);
  const [eligible, setEligible] = useState<EligibleDetailDto[] | null>(null);
  const [noSheetSpecCount, setNoSheetSpecCount] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [sheetImages, setSheetImages] = useState<Record<string, string>>({});
  const [preset, setPreset] = useState<string>('screen');
  const [presetOptions, setPresetOptions] = useState(DEFAULT_PRESET_OPTIONS);
  const [jobs, setJobs] = useState<CutJobDto[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(CUT_JOB_STATUS_FILTER_ALL);

  // Render presets are config-driven (/configuration "Раскрой"): load the active
  // names from the backend, falling back to the built-ins.
  useEffect(() => {
    cutConfigApi
      .get()
      .then((cfg) => {
        const options = cfg.renderPresets
          .filter((p) => p.isActive)
          .map((p) => ({ value: p.name, label: p.name }));
        if (options.length > 0) setPresetOptions(options);
      })
      .catch(() => undefined);
  }, []);

  const criteriaFromForm = useCallback(() => {
    const values = form.getFieldsValue();
    return {
      orderIds: parseIdCsv(values.orderIds ?? ''),
      materialIds: parseIdCsv(values.materialIds ?? ''),
      filmIds: parseIdCsv(values.filmIds ?? ''),
    };
  }, [form]);

  const handleError = useCallback((error: unknown, fallback: string) => {
    const text = error instanceof ApiError ? error.message : fallback;
    message.error(text);
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      setJobs(await cutApi.list());
    } catch (error) {
      handleError(error, 'Не удалось загрузить список раскроев');
    } finally {
      setJobsLoading(false);
    }
  }, [handleError]);

  // Load the existing (non-archived) jobs on mount so an operator can reopen a
  // job created earlier — including jobs staged from the Orders "Добавить в
  // раскрой" action, which previously had no surface to be reopened on.
  useEffect(() => {
    if (can('cut.view')) void loadJobs();
  }, [loadJobs]);

  const openJob = useCallback(
    async (cutJobId: number) => {
      setBusy(true);
      try {
        const fresh = await cutApi.get(cutJobId);
        setJob(fresh);
        setEligible(null);
        setSelected([]);
        setSheetImages({});
      } catch (error) {
        handleError(error, 'Не удалось открыть раскрой');
      } finally {
        setBusy(false);
      }
    },
    [handleError],
  );

  const archiveJob = useCallback(
    async (target: CutJobDto) => {
      setBusy(true);
      try {
        await cutApi.archive(target.cutJobId, target.version);
        message.success('Раскрой архивирован');
        if (job?.cutJobId === target.cutJobId) {
          setJob(null);
          setEligible(null);
          setSelected([]);
          setSheetImages({});
        }
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось архивировать раскрой');
      } finally {
        setBusy(false);
      }
    },
    [job, loadJobs, handleError],
  );

  const createJob = useCallback(async () => {
    setBusy(true);
    try {
      const values = await form.validateFields();
      const created = await cutApi.create({ name: values.name, criteria: criteriaFromForm() });
      setJob(created);
      setEligible(null);
      setSelected([]);
      message.success('Раскрой создан');
      void loadJobs();
    } catch (error) {
      if (error && (error as { errorFields?: unknown }).errorFields) return; // antd validation
      handleError(error, 'Не удалось создать раскрой');
    } finally {
      setBusy(false);
    }
  }, [form, criteriaFromForm, loadJobs, handleError]);

  const loadEligible = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const response = await cutApi.listEligibleDetails(job.cutJobId, criteriaFromForm());
      setEligible(response.details);
      setNoSheetSpecCount(response.noSheetSpecCount);
      setSelected(selectableDetailIds(response.details));
    } catch (error) {
      handleError(error, 'Не удалось загрузить детали');
    } finally {
      setBusy(false);
    }
  }, [job, criteriaFromForm, handleError]);

  const addToBasket = useCallback(async () => {
    if (!job || selected.length === 0) return;
    setBusy(true);
    try {
      const updated = await cutApi.addItems(job.cutJobId, { detailIds: selected, version: job.version });
      setJob(updated);
      message.success('Детали добавлены в раскрой');
      void loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось добавить детали');
    } finally {
      setBusy(false);
    }
  }, [job, selected, loadJobs, handleError]);

  const calculate = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const calculated = await cutApi.calculate(job.cutJobId, job.version);
      setJob(calculated);
      setSheetImages({});
      message.success('Раскрой рассчитан');
      void loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось рассчитать раскрой');
    } finally {
      setBusy(false);
    }
  }, [job, loadJobs, handleError]);

  const loadSheet = useCallback(
    async (group: CutGroupDto, sheetIndex: number) => {
      if (!job) return;
      const key = `${group.cutGroupId}:${sheetIndex}`;
      try {
        const blob = await cutApi.fetchSheetPng(job.cutJobId, group.cutGroupId, sheetIndex, preset);
        setSheetImages((prev) => ({ ...prev, [key]: URL.createObjectURL(blob) }));
      } catch (error) {
        handleError(error, 'Не удалось загрузить лист раскроя');
      }
    },
    [job, preset, handleError],
  );

  const downloadSheetSvg = useCallback(
    async (group: CutGroupDto, sheetIndex: number) => {
      if (!job) return;
      try {
        const blob = await cutApi.fetchSheetSvg(job.cutJobId, group.cutGroupId, sheetIndex);
        triggerBlobDownload(blob, `cut-${job.cutJobId}-g${group.cutGroupId}-s${sheetIndex + 1}.svg`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить SVG');
      }
    },
    [job, handleError],
  );

  const downloadGroupPdf = useCallback(
    async (group: CutGroupDto) => {
      if (!job) return;
      setBusy(true);
      try {
        const result = await pollPdf(() => cutApi.fetchGroupPdf(job.cutJobId, group.cutGroupId));
        triggerBlobDownload(result.blob, result.fileName ?? `cut-group-${group.cutGroupId}.pdf`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить PDF группы');
      } finally {
        setBusy(false);
      }
    },
    [job, handleError],
  );

  const downloadJobPdf = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const result = await pollPdf(() => cutApi.fetchJobPdf(job.cutJobId));
      triggerBlobDownload(result.blob, result.fileName ?? `cut-job-${job.cutJobId}.pdf`);
    } catch (error) {
      handleError(error, 'Не удалось выгрузить PDF раскроя');
    } finally {
      setBusy(false);
    }
  }, [job, handleError]);

  const filteredJobs = useMemo(() => filterJobsByStatus(jobs, statusFilter), [jobs, statusFilter]);

  const jobColumns: ColumnsType<CutJobDto> = useMemo(
    () => [
      { title: '#', dataIndex: 'cutJobId', key: 'id', width: 70 },
      { title: 'Название', dataIndex: 'name', key: 'name' },
      {
        title: 'Статус',
        key: 'status',
        width: 120,
        render: (_: unknown, row: CutJobDto) => (
          <Tag color={STATUS_TAG_COLORS[row.status] ?? 'default'}>{cutJobStatusLabel(row.status)}</Tag>
        ),
      },
      {
        title: 'Источник',
        key: 'source',
        width: 100,
        render: (_: unknown, row: CutJobDto) => cutJobSourceLabel(row.source),
      },
      {
        title: 'Детали',
        key: 'items',
        width: 80,
        render: (_: unknown, row: CutJobDto) => cutJobCounts(row).items,
      },
      {
        title: 'Группы',
        key: 'groups',
        width: 80,
        render: (_: unknown, row: CutJobDto) => cutJobCounts(row).groups,
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 200,
        render: (_: unknown, row: CutJobDto) => (
          <Space>
            <Button size="small" type="link" onClick={() => openJob(row.cutJobId)} disabled={busy}>
              Открыть
            </Button>
            {canManage && (
              <Button size="small" type="link" danger onClick={() => archiveJob(row)} disabled={busy}>
                Архивировать
              </Button>
            )}
          </Space>
        ),
      },
    ],
    [busy, canManage, openJob, archiveJob],
  );

  const eligibleColumns: ColumnsType<EligibleDetailDto> = useMemo(
    () => [
      { title: 'Деталь', dataIndex: 'orderDetailId', key: 'detail' },
      { title: 'Заказ', dataIndex: 'orderId', key: 'order' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'qty' },
      {
        title: 'Статус',
        key: 'status',
        render: (_: unknown, row: EligibleDetailDto) =>
          row.eligible ? (
            <Tag color="green">Готова к раскрою</Tag>
          ) : (
            <Tag color="orange">{INELIGIBLE_LABELS[row.ineligibleReason ?? ''] ?? row.ineligibleReason}</Tag>
          ),
      },
    ],
    [],
  );

  const noSheetMsg = noSheetSpecMessage(noSheetSpecCount);

  if (!can('cut.view')) {
    return <Alert type="error" message="Недостаточно прав для просмотра раскроя" showIcon />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={3}>Раскрой</Title>

      <Card title="Критерии выборки" size="small">
        <Form form={form} layout="inline" disabled={busy || !canManage}>
          <Form.Item name="name" rules={[{ required: true, message: 'Укажите название' }]}>
            <Input placeholder="Название раскроя" />
          </Form.Item>
          <Form.Item name="orderIds">
            <Input placeholder="Заказы (9,10)" />
          </Form.Item>
          <Form.Item name="materialIds">
            <Input placeholder="Материалы" />
          </Form.Item>
          <Form.Item name="filmIds">
            <Input placeholder="Плёнки" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={createJob} loading={busy} disabled={!canManage}>
              Создать раскрой
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        size="small"
        title="Раскрои"
        extra={
          <Space>
            <Select<string>
              value={statusFilter}
              onChange={setStatusFilter}
              options={[...CUT_JOB_STATUS_FILTER_OPTIONS]}
              style={{ width: 160 }}
            />
            <Button onClick={loadJobs} loading={jobsLoading}>
              Обновить
            </Button>
          </Space>
        }
      >
        <Table<CutJobDto>
          size="small"
          rowKey="cutJobId"
          columns={jobColumns}
          dataSource={filteredJobs}
          loading={jobsLoading}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: 'Нет раскроев' }}
          rowClassName={(row) => (row.cutJobId === job?.cutJobId ? 'ant-table-row-selected' : '')}
        />
      </Card>

      {job && (
        <Card
          size="small"
          title={`Раскрой #${job.cutJobId} — ${job.name}`}
          extra={<Tag>{job.status}</Tag>}
        >
          <Space>
            <Button onClick={loadEligible} loading={busy}>
              Загрузить подходящие детали
            </Button>
            <Button onClick={addToBasket} disabled={!canManage || selected.length === 0} loading={busy}>
              Добавить выбранные ({selected.length})
            </Button>
            <Button type="primary" onClick={calculate} disabled={!canManage || job.items.length === 0} loading={busy}>
              Рассчитать
            </Button>
            <Select<string>
              value={preset}
              onChange={setPreset}
              options={presetOptions}
              style={{ width: 140 }}
            />
            {job.groups.length > 0 && (
              <Button onClick={downloadJobPdf} loading={busy}>
                Скачать PDF (весь раскрой)
              </Button>
            )}
          </Space>
        </Card>
      )}

      {noSheetMsg && <Alert type="warning" showIcon message={noSheetMsg} />}

      {eligible && (
        <Table<EligibleDetailDto>
          size="small"
          rowKey="orderDetailId"
          columns={eligibleColumns}
          dataSource={eligible}
          pagination={false}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(Number)),
            getCheckboxProps: (row) => ({ disabled: !row.eligible }),
          }}
        />
      )}

      {job?.groups.map((group) => (
        <Card
          key={group.cutGroupId}
          size="small"
          title={`Группа #${group.cutGroupId}`}
          extra={
            <Button size="small" onClick={() => downloadGroupPdf(group)} loading={busy}>
              Скачать PDF
            </Button>
          }
        >
          <Text type="secondary">{formatGroupSummary(group.summary)}</Text>
          <Space direction="vertical" style={{ width: '100%' }}>
            {group.sheets.map((sheet) => {
              const key = `${group.cutGroupId}:${sheet.sheetIndex}`;
              return (
                <div key={key}>
                  <Space>
                    <Button size="small" onClick={() => loadSheet(group, sheet.sheetIndex)}>
                      Лист {sheet.sheetIndex + 1}
                    </Button>
                    <Button size="small" onClick={() => downloadSheetSvg(group, sheet.sheetIndex)}>
                      SVG
                    </Button>
                  </Space>
                  {sheetImages[key] && (
                    <div>
                      <img src={sheetImages[key]} alt={`Лист ${sheet.sheetIndex + 1}`} style={{ maxWidth: '100%' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </Space>
        </Card>
      ))}
    </Space>
  );
};
