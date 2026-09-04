import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Alert,
  Button,
  DatePicker,
  Descriptions,
  Drawer,
  Input,
  InputNumber,
  Modal,
  Select,
  Space,
  Spin,
  Switch,
  Tag,
  Typography,
  notification,
} from 'antd';
import {
  DeleteOutlined,
  EditOutlined,
  ExportOutlined,
  PlusOutlined,
  ReloadOutlined,
  SettingOutlined,
  WalletOutlined,
} from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import type { Dayjs } from 'dayjs';
import { useNavigate } from 'react-router-dom';
import { Table } from '../../ui/tooltipDelay';
import { authSession } from '../../api/authSession';
import {
  bitrix24Api,
  type Bitrix24AmbiguousPaymentCommand,
  type Bitrix24IncomingPayment,
  type Bitrix24IncomingRequest,
  type Bitrix24IncomingRequestDetailInput,
  type Bitrix24IncomingRequestListItem,
  type Bitrix24PaymentTypeMapping,
  type Bitrix24RequestState,
  type Bitrix24SyncHealth,
  type Bitrix24UserMapping,
  type Bitrix24UserMappingTarget,
} from '../../api/bitrix24Api';
import { can } from '../../utils/permissions';

const stateOptions: Array<{ value: Bitrix24RequestState; label: string }> = [
  { value: 'active', label: 'Активные' },
  { value: 'unresolved', label: 'Без клиента' },
  { value: 'converted', label: 'Преобразованные' },
  { value: 'archived', label: 'Архив' },
];

interface RequestFilters {
  search: string;
  stageId: string;
  assignedById: string;
  clientId: number | null;
  updatedRange: [Dayjs | null, Dayjs | null] | null;
}

type EditableRequestDetail = Bitrix24IncomingRequestDetailInput & { localKey: string };

const emptyFilters = (): RequestFilters => ({
  search: '',
  stageId: '',
  assignedById: '',
  clientId: null,
  updatedRange: null,
});

export const Bitrix24IncomingRequestsPage: React.FC = () => {
  const navigate = useNavigate();
  const user = authSession.getUser();
  const [state, setState] = useState<Bitrix24RequestState>('active');
  const [rows, setRows] = useState<Bitrix24IncomingRequestListItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [draftFilters, setDraftFilters] = useState<RequestFilters>(emptyFilters);
  const [filters, setFilters] = useState<RequestFilters>(emptyFilters);
  const [selected, setSelected] = useState<Bitrix24IncomingRequest | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [conversionOpen, setConversionOpen] = useState(false);
  const [conversionName, setConversionName] = useState('');
  const [conversionProjectId, setConversionProjectId] = useState<number | null>(null);
  const [conversionCreateProject, setConversionCreateProject] = useState(true);
  const [converting, setConverting] = useState(false);
  const [detailEditorOpen, setDetailEditorOpen] = useState(false);
  const [detailDrafts, setDetailDrafts] = useState<EditableRequestDetail[]>([]);
  const [savingDetails, setSavingDetails] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [selectedPaymentIds, setSelectedPaymentIds] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsLoading, setSettingsLoading] = useState(false);
  const [catalogRefreshing, setCatalogRefreshing] = useState(false);
  const [mappings, setMappings] = useState<Bitrix24PaymentTypeMapping[]>([]);
  const [userMappings, setUserMappings] = useState<Bitrix24UserMapping[]>([]);
  const [userMappingTargets, setUserMappingTargets] = useState<Bitrix24UserMappingTarget[]>([]);
  const [newBitrixUserId, setNewBitrixUserId] = useState('');
  const [newErpUserId, setNewErpUserId] = useState<number | null>(null);
  const [health, setHealth] = useState<Bitrix24SyncHealth | null>(null);
  const [ambiguousCommands, setAmbiguousCommands] = useState<Bitrix24AmbiguousPaymentCommand[]>([]);
  const [ambiguityResolution, setAmbiguityResolution] = useState<{
    command: Bitrix24AmbiguousPaymentCommand;
    resolution: 'attach_existing' | 'confirm_absent';
  } | null>(null);
  const [ambiguityPaymentId, setAmbiguityPaymentId] = useState('');
  const [ambiguityReason, setAmbiguityReason] = useState('');
  const [ambiguityResolving, setAmbiguityResolving] = useState(false);
  const { selectProps: paymentTypeSelectProps } = useSelect({
    resource: 'payment_types',
    optionLabel: 'type_paid_name',
    optionValue: 'type_paid_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
  });
  const { selectProps: sheetMaterialSelectProps } = useSelect({
    resource: 'sheet_material_types',
    optionLabel: 'name',
    optionValue: 'sheet_material_type_id',
    filters: [
      { field: 'is_active', operator: 'eq', value: true },
      { field: 'is_cuttable', operator: 'eq', value: true },
    ],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { pageSize: 1_000 },
  });
  const { selectProps: millingTypeSelectProps } = useSelect({
    resource: 'milling_types',
    optionLabel: 'milling_type_name',
    optionValue: 'milling_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { pageSize: 1_000 },
  });
  const { selectProps: edgeTypeSelectProps } = useSelect({
    resource: 'edge_types',
    optionLabel: 'edge_type_name',
    optionValue: 'edge_type_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }],
    pagination: { pageSize: 1_000 },
  });
  const { selectProps: filmSelectProps } = useSelect({
    resource: 'films',
    optionLabel: 'film_name',
    optionValue: 'film_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    pagination: { pageSize: 1_000 },
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await bitrix24Api.listIncomingRequests({
        state,
        search: filters.search.trim() || undefined,
        stageId: filters.stageId.trim() || undefined,
        assignedById: filters.assignedById.trim() || undefined,
        clientId: filters.clientId ?? undefined,
        updatedFrom: filters.updatedRange?.[0]?.startOf('day').toISOString(),
        updatedTo: filters.updatedRange?.[1]?.endOf('day').toISOString(),
        page,
        pageSize: 25,
      });
      setRows(response.data);
      setTotal(response.pagination.total);
    } catch (error) {
      notification.error({
        message: 'Не удалось загрузить заявки Bitrix',
        description: errorMessage(error),
      });
    } finally {
      setLoading(false);
    }
  }, [filters, page, state]);

  useEffect(() => {
    void load();
  }, [load]);

  const openDetails = async (requestId: number) => {
    setDetailLoading(true);
    setSelectedPaymentIds([]);
    try {
      setSelected(await bitrix24Api.getIncomingRequest(requestId));
    } catch (error) {
      notification.error({
        message: 'Не удалось открыть заявку',
        description: errorMessage(error),
      });
    } finally {
      setDetailLoading(false);
    }
  };

  const convertToProduction = async () => {
    if (!selected?.linkedOrderId) return;
    setConverting(true);
    try {
      const converted = await bitrix24Api.convertToProduction(selected.linkedOrderId, {
        version: selected.orderVersion ?? selected.version,
        orderName: conversionName.trim(),
        projectId: conversionCreateProject ? null : conversionProjectId,
        createProject: conversionCreateProject,
        idempotencyKey: crypto.randomUUID(),
      });
      setConversionOpen(false);
      setSelected(null);
      notification.success({ message: 'Заявка преобразована в производственный заказ' });
      navigate(`/orders/show/${converted.orderId}`);
    } catch (error) {
      notification.error({
        message: 'Не удалось преобразовать заявку',
        description: errorMessage(error),
      });
    } finally {
      setConverting(false);
    }
  };

  const openDetailEditor = () => {
    if (!selected) return;
    setDetailDrafts(selected.details.map((detail) => ({
      id: detail.id,
      localKey: `saved-${detail.id}`,
      detailName: detail.detailName,
      height: detail.height,
      width: detail.width,
      quantity: detail.quantity,
      sheetMaterialTypeId: detail.sheetMaterialTypeId,
      millingTypeId: detail.millingTypeId,
      edgeTypeId: detail.edgeTypeId,
      filmId: detail.filmId,
      millingCostPerSqm: detail.millingCostPerSqm,
      detailCost: detail.detailCost,
      priority: detail.priority,
      note: detail.note,
    })));
    setDetailEditorOpen(true);
  };

  const updateDetailDraft = (
    localKey: string,
    patch: Partial<Bitrix24IncomingRequestDetailInput>,
  ) => {
    setDetailDrafts((current) => current.map((detail) =>
      detail.localKey === localKey ? { ...detail, ...patch } : detail));
  };

  const addDetailDraft = () => {
    const firstValue = (options: typeof sheetMaterialSelectProps.options) => {
      const value = options?.[0]?.value;
      return value === undefined || value === null ? 0 : Number(value);
    };
    setDetailDrafts((current) => [...current, {
      localKey: `new-${crypto.randomUUID()}`,
      detailName: null,
      height: 0,
      width: 0,
      quantity: 1,
      sheetMaterialTypeId: firstValue(sheetMaterialSelectProps.options),
      millingTypeId: firstValue(millingTypeSelectProps.options),
      edgeTypeId: firstValue(edgeTypeSelectProps.options),
      filmId: null,
      ...(canViewFinancials ? {
        millingCostPerSqm: null,
        detailCost: null,
      } : {}),
      priority: 100,
      note: null,
    }]);
  };

  const saveDetails = async () => {
    if (!selected || selected.orderVersion === null) return;
    const invalid = detailDrafts.some((detail) =>
      detail.height <= 0 || detail.width <= 0 || !Number.isInteger(detail.quantity) ||
      detail.quantity <= 0 || detail.sheetMaterialTypeId <= 0 ||
      detail.millingTypeId <= 0 || detail.edgeTypeId <= 0);
    if (invalid) {
      notification.warning({ message: 'Заполните размеры, количество, материал, фрезеровку и обкат' });
      return;
    }
    setSavingDetails(true);
    try {
      const updated = await bitrix24Api.replaceIncomingRequestDetails(selected.requestId, {
        orderVersion: selected.orderVersion,
        details: detailDrafts.map(({ localKey: _localKey, ...detail }) => detail),
      });
      setSelected({
        ...selected,
        details: updated.details,
        detailCount: updated.detailCount,
        erpFinalAmount: updated.erpFinalAmount,
        orderVersion: updated.orderVersion,
      });
      setDetailEditorOpen(false);
      await load();
      notification.success({ message: 'Детали CRM-заявки сохранены' });
    } catch (error) {
      notification.error({
        message: 'Детали не сохранены',
        description: errorMessage(error),
      });
    } finally {
      setSavingDetails(false);
    }
  };

  const materializePayments = async () => {
    if (!selected || selected.orderVersion === null) return;
    const bitrixPaymentIds = selectedPaymentIds.filter((id) =>
      selected.payments.some((payment) =>
        payment.bitrixPaymentId === id && payment.paid && payment.state !== 'deleted'));
    if (bitrixPaymentIds.length === 0) {
      notification.info({ message: 'Нет активных оплат для переноса' });
      return;
    }
    setMaterializing(true);
    try {
      const updated = await bitrix24Api.materializePayments(selected.requestId, {
        bitrixPaymentIds,
        expectedOrderVersion: selected.orderVersion,
      });
      setSelected(updated);
      await load();
      notification.success({ message: 'Платежи перенесены в ERP' });
    } catch (error) {
      notification.error({
        message: 'Платежи не перенесены',
        description: errorMessage(error),
      });
    } finally {
      setMaterializing(false);
    }
  };

  const archiveIncomingRequest = () => {
    if (!selected?.linkedOrderId || selected.orderVersion === null) return;
    Modal.confirm({
      title: 'Архивировать CRM-заявку в ERP?',
      content: 'Сделка Bitrix останется без изменений. Новое событие Bitrix создаст видимый конфликт, но не восстановит заявку автоматически.',
      okText: 'Архивировать',
      okButtonProps: { danger: true },
      cancelText: 'Отмена',
      onOk: async () => {
        setArchiving(true);
        try {
          await bitrix24Api.archiveIncomingRequest(
            selected.requestId,
            selected.orderVersion as number,
          );
          setSelected(null);
          await load();
          notification.success({ message: 'CRM-заявка архивирована только в ERP' });
        } catch (error) {
          notification.error({
            message: 'CRM-заявка не архивирована',
            description: errorMessage(error),
          });
          throw error;
        } finally {
          setArchiving(false);
        }
      },
    });
  };

  const loadSettings = useCallback(async () => {
    setSettingsLoading(true);
    try {
      const [nextMappings, nextUserMappings, nextUserTargets, nextHealth, nextAmbiguous] = await Promise.all([
        bitrix24Api.listPaymentTypeMappings(),
        bitrix24Api.listUserMappings(),
        bitrix24Api.listUserMappingTargets(),
        bitrix24Api.getSyncHealth(),
        bitrix24Api.listAmbiguousPaymentCommands(),
      ]);
      setMappings(nextMappings);
      setUserMappings(nextUserMappings);
      setUserMappingTargets(nextUserTargets);
      setHealth(nextHealth);
      setAmbiguousCommands(nextAmbiguous);
    } catch (error) {
      notification.error({
        message: 'Не удалось загрузить настройки Bitrix',
        description: errorMessage(error),
      });
    } finally {
      setSettingsLoading(false);
    }
  }, []);

  const updateMapping = async (
    mapping: Bitrix24PaymentTypeMapping,
    typePaidId: number | null,
    active: boolean,
    widgetEnabled = mapping.widgetEnabled,
    isDefault = mapping.isDefault,
  ) => {
    if (!typePaidId) return;
    setSettingsLoading(true);
    try {
      await bitrix24Api.updatePaymentTypeMapping(mapping.paySystemId, {
        typePaidId,
        active,
        widgetEnabled,
        isDefault,
      });
      await loadSettings();
    } catch (error) {
      notification.error({
        message: 'Не удалось сохранить сопоставление',
        description: errorMessage(error),
      });
      setSettingsLoading(false);
    }
  };

  const refreshPaymentSystems = async () => {
    setCatalogRefreshing(true);
    try {
      const result = await bitrix24Api.refreshPaymentSystems();
      notification.success({ message: `Платёжных систем обновлено: ${result.refreshed}` });
      await loadSettings();
    } catch (error) {
      notification.error({
        message: 'Не удалось обновить платёжные системы Bitrix',
        description: errorMessage(error),
      });
    } finally {
      setCatalogRefreshing(false);
    }
  };

  const retryFailed = async () => {
    setSettingsLoading(true);
    try {
      const result = await bitrix24Api.retryFailed();
      notification.success({
        message: `Возвращено в очередь: ${result.retried}`,
      });
      await loadSettings();
    } catch (error) {
      notification.error({
        message: 'Не удалось повторить события',
        description: errorMessage(error),
      });
      setSettingsLoading(false);
    }
  };

  const updateUserMapping = async (
    bitrixUserId: string,
    erpUserId: number,
    active: boolean,
  ) => {
    setSettingsLoading(true);
    try {
      await bitrix24Api.updateUserMapping(bitrixUserId, { erpUserId, active });
      setNewBitrixUserId('');
      setNewErpUserId(null);
      await loadSettings();
    } catch (error) {
      notification.error({
        message: 'Не удалось сохранить сопоставление пользователя',
        description: errorMessage(error),
      });
      setSettingsLoading(false);
    }
  };

  const resolveAmbiguity = async () => {
    if (!ambiguityResolution || ambiguityReason.trim().length < 10) return;
    if (
      ambiguityResolution.resolution === 'attach_existing' &&
      !/^[1-9][0-9]*$/.test(ambiguityPaymentId)
    ) return;
    setAmbiguityResolving(true);
    try {
      const common = {
        reason: ambiguityReason.trim(),
        expectedVersion: ambiguityResolution.command.version,
      };
      await bitrix24Api.resolvePaymentAmbiguity(
        ambiguityResolution.command.commandId,
        ambiguityResolution.resolution === 'attach_existing'
          ? {
              resolution: 'attach_existing',
              bitrixPaymentId: ambiguityPaymentId,
              ...common,
            }
          : { resolution: 'confirm_absent', ...common },
      );
      setAmbiguityResolution(null);
      setAmbiguityPaymentId('');
      setAmbiguityReason('');
      await loadSettings();
      notification.success({ message: 'Неопределённая команда оплаты разрешена' });
    } catch (error) {
      notification.error({
        message: 'Не удалось разрешить команду оплаты',
        description: errorMessage(error),
      });
    } finally {
      setAmbiguityResolving(false);
    }
  };

  const canConvert = can('bitrix24.requests.convert', user);
  const canUpdate = can('bitrix24.requests.update', user);
  const canViewFinancials = can('orders.view_financials', user);
  const canMaterialize =
    canViewFinancials && can('bitrix24.payments.materialize', user);
  const canManage = can('bitrix24.integration.manage', user);

  const columns = useMemo(() => [
    {
      title: 'Заявка',
      dataIndex: 'title',
      key: 'title',
      render: (value: string, row: Bitrix24IncomingRequestListItem) => (
        <Button type="link" style={{ padding: 0 }} onClick={() => void openDetails(row.requestId)}>
          {value}
        </Button>
      ),
    },
    {
      title: 'Клиент',
      dataIndex: 'clientName',
      key: 'clientName',
      render: (value: string | null) => value || 'Не указан',
    },
    ...(canViewFinancials ? [{
      title: 'Сумма CRM',
      key: 'crmAmount',
      align: 'right' as const,
      render: (_: unknown, row: Bitrix24IncomingRequestListItem) =>
        money(row.crmAmount, row.currencyId),
    },
    {
      title: 'Платежи Bitrix',
      key: 'payments',
      align: 'right' as const,
      render: (_: unknown, row: Bitrix24IncomingRequestListItem) =>
        `${row.paymentCount} · ${money(row.paymentAmount, row.currencyId)}`,
    }] : []),
    {
      title: 'Стадия',
      dataIndex: 'stageId',
      key: 'stageId',
      render: (value: string | null) => value || '—',
    },
    {
      title: 'Обновлено',
      dataIndex: 'bitrixUpdatedAt',
      key: 'bitrixUpdatedAt',
      render: (value: string | null) => formatDateTime(value),
    },
    {
      title: '',
      key: 'bitrix',
      width: 48,
      render: (_: unknown, row: Bitrix24IncomingRequestListItem) => (
        <Button
          type="text"
          icon={<ExportOutlined />}
          href={row.bitrixUrl}
          target="_blank"
          rel="noreferrer"
          title="Открыть в Bitrix24"
        />
      ),
    },
  ], [canViewFinancials]);
  const unmappedPaymentCount =
    selected?.payments.filter(
      (payment) => payment.state !== 'deleted' && payment.mappedTypePaidId === null,
    ).length ?? 0;
  const selectedUnmappedPaymentCount = selected?.payments.filter(
    (payment) => selectedPaymentIds.includes(payment.bitrixPaymentId) &&
      payment.mappedTypePaidId === null,
  ).length ?? 0;

  return (
    <div style={{ padding: 16 }}>
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
          <div>
            <Typography.Title level={3} style={{ margin: 0 }}>
              Входящие заявки Bitrix
            </Typography.Title>
            <Typography.Text type="secondary">
              Каждая сопоставленная сделка Bitrix создаёт отдельную CRM-заявку ERP без проекта.
            </Typography.Text>
          </div>
          <Space>
            <Select
              value={state}
              options={stateOptions}
              onChange={(value) => {
                setPage(1);
                setState(value);
              }}
              style={{ width: 160 }}
            />
            <Button icon={<ReloadOutlined />} onClick={() => void load()} loading={loading}>
              Обновить
            </Button>
            {canManage && (
              <Button
                icon={<SettingOutlined />}
                onClick={() => {
                  setSettingsOpen(true);
                  void loadSettings();
                }}
              >
                Настройки
              </Button>
            )}
          </Space>

        </Space>

        <Space wrap>
          <Input
            allowClear
            value={draftFilters.search}
            placeholder="Название или клиент"
            style={{ width: 220 }}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, search: event.target.value }))}
          />
          <Input
            allowClear
            value={draftFilters.stageId}
            placeholder="ID стадии Bitrix"
            style={{ width: 170 }}
            onChange={(event) =>
              setDraftFilters((current) => ({ ...current, stageId: event.target.value }))}
          />
          <Input
            allowClear
            value={draftFilters.assignedById}
            placeholder="ID ответственного"
            style={{ width: 170 }}
            onChange={(event) =>
              setDraftFilters((current) => ({
                ...current,
                assignedById: event.target.value.replace(/\D/g, ''),
              }))}
          />
          <InputNumber
            min={1}
            precision={0}
            value={draftFilters.clientId}
            placeholder="ID клиента ERP"
            style={{ width: 160 }}
            onChange={(value) =>
              setDraftFilters((current) => ({ ...current, clientId: value }))}
          />
          <DatePicker.RangePicker
            value={draftFilters.updatedRange}
            onChange={(value) =>
              setDraftFilters((current) => ({ ...current, updatedRange: value }))}
          />
          <Button
            type="primary"
            onClick={() => {
              setPage(1);
              setFilters(draftFilters);
            }}
          >
            Применить
          </Button>
          <Button
            onClick={() => {
              const reset = emptyFilters();
              setPage(1);
              setDraftFilters(reset);
              setFilters(reset);
            }}
          >
            Сбросить
          </Button>
        </Space>

        <Table
          rowKey="requestId"
          columns={columns}
          dataSource={rows}
          loading={loading}
          pagination={{
            current: page,
            pageSize: 25,
            total,
            showSizeChanger: false,
            onChange: setPage,
          }}
          scroll={{ x: 900 }}
        />
      </Space>

      <Drawer
        width={720}
        open={selected !== null || detailLoading}
        onClose={() => {
          setSelected(null);
          setSelectedPaymentIds([]);
        }}
        title={selected?.title ?? 'Заявка Bitrix'}
        extra={selected ? (
          <Button
            icon={<ExportOutlined />}
            href={selected.bitrixUrl}
            target="_blank"
            rel="noreferrer"
          >
            Открыть в Bitrix
          </Button>
        ) : null}
      >
        {detailLoading && <Spin />}
        {!detailLoading && selected && (
          <Space direction="vertical" size={16} style={{ width: '100%' }}>
            <Descriptions bordered size="small" column={2}>
              <Descriptions.Item label="Состояние">
                <RequestStateTag state={selected.state} />
              </Descriptions.Item>
              <Descriptions.Item label="Клиент">
                {selected.clientName || 'Не указан'}
              </Descriptions.Item>
              {canViewFinancials && (
                <>
                  <Descriptions.Item label="Сумма CRM">
                    {money(selected.crmAmount, selected.currencyId)}
                  </Descriptions.Item>
                  <Descriptions.Item label="Расчёт ERP">
                    {money(selected.erpFinalAmount, selected.currencyId)}
                  </Descriptions.Item>
                </>
              )}
              <Descriptions.Item label="Стадия">
                {selected.stageName || selected.stageId || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Ответственный">
                {selected.assignedByName || selected.assignedById || '—'}
              </Descriptions.Item>
              <Descriptions.Item label="Обновлено">
                {formatDateTime(selected.bitrixUpdatedAt)}
              </Descriptions.Item>
              <Descriptions.Item label="Проект">
                {selected.projectCode || 'Не назначен'}
              </Descriptions.Item>
              <Descriptions.Item label="Детали">
                {selected.detailCount}
              </Descriptions.Item>
              <Descriptions.Item label="Комментарий" span={2}>
                {selected.comments || '—'}
              </Descriptions.Item>
              {selected.linkedOrderId && (
                <Descriptions.Item label="Заказ ERP" span={2}>
                  {selected.state === 'converted' ? (
                    <Button
                      type="link"
                      style={{ padding: 0 }}
                      onClick={() => navigate(`/orders/show/${selected.linkedOrderId}`)}
                    >
                      {selected.fullNumber || `#${selected.linkedOrderId}`}
                    </Button>
                  ) : `CRM-заявка #${selected.linkedOrderId}`}
                </Descriptions.Item>
              )}
            </Descriptions>

            {selected.syncStatus === 'blocked' && (
              <Alert type="error" showIcon message="Синхронизация заявки заблокирована" description={selected.syncErrorCode || undefined} />
            )}
            <Space style={{ justifyContent: 'space-between', width: '100%' }}>
              <Typography.Title level={5} style={{ margin: 0 }}>
                Детали ERP
              </Typography.Title>
              {selected.state === 'active' && canUpdate && (
                <Button
                  icon={<EditOutlined />}
                  disabled={selected.syncStatus === 'blocked'}
                  onClick={openDetailEditor}
                >
                  Редактировать
                </Button>
              )}
            </Space>
            <Table
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={selected.details}
              scroll={{ x: 680 }}
              columns={[
                { title: '№', dataIndex: 'detailNumber', width: 52 },
                { title: 'Название', dataIndex: 'detailName', render: (value) => value || '—' },
                { title: 'Высота', dataIndex: 'height', width: 90 },
                { title: 'Ширина', dataIndex: 'width', width: 90 },
                { title: 'Кол-во', dataIndex: 'quantity', width: 75 },
                ...(canViewFinancials ? [{
                  title: 'Стоимость',
                  dataIndex: 'detailCost',
                  width: 110,
                  render: (value) => money(value, selected.currencyId),
                }] : []),
              ]}
            />
            {selected.state === 'active' && canConvert && (
              <Button
                type="primary"
                disabled={selected.detailCount === 0 || selected.syncStatus === 'blocked'}
                onClick={() => {
                  setConversionName(selected.title);
                  setConversionProjectId(null);
                  setConversionCreateProject(true);
                  setConversionOpen(true);
                }}
              >
                Преобразовать в заказ
              </Button>
            )}
            {selected.state === 'active' && canUpdate && (
              <Button
                danger
                icon={<DeleteOutlined />}
                loading={archiving}
                onClick={archiveIncomingRequest}
              >
                Архивировать только в ERP
              </Button>
            )}
            {selected.state === 'active' && selected.detailCount === 0 && (
              <Alert type="info" showIcon message="Для преобразования добавьте минимум одну деталь в CRM-заявку." />
            )}

            {canViewFinancials && (
              <>
                <Typography.Title level={5} style={{ marginBottom: 0 }}>
                  Платежи Bitrix
                </Typography.Title>
                {unmappedPaymentCount > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${unmappedPaymentCount} платёжных систем не сопоставлено с типами оплат ERP`}
                description="Администратор должен настроить соответствия до переноса денег."
              />
                )}
                <Table<Bitrix24IncomingPayment>
              rowKey="bitrixPaymentId"
              size="small"
              pagination={false}
              dataSource={selected.payments}
              rowSelection={selected.state === 'converted' && canMaterialize ? {
                selectedRowKeys: selectedPaymentIds,
                onChange: (keys) => setSelectedPaymentIds(keys.map(String)),
                getCheckboxProps: (payment) => ({
                  disabled: !payment.paid || payment.state === 'deleted',
                }),
              } : undefined}
              columns={[
                { title: 'ID', dataIndex: 'bitrixPaymentId' },
                {
                  title: 'Система',
                  key: 'system',
                  render: (_, payment) =>
                    payment.paySystemName || payment.paySystemId || 'Не указана',
                },
                {
                  title: 'Сумма',
                  key: 'amount',
                  align: 'right',
                  render: (_, payment) => money(payment.amount, payment.currencyId),
                },
                {
                  title: 'Дата',
                  dataIndex: 'paymentDate',
                  render: formatDateTime,
                },
                {
                  title: 'Статус',
                  key: 'state',
                  render: (_, payment) => paymentState(payment),
                },
              ]}
                />
                {selected.state === 'converted' && canMaterialize && selected.payments.length > 0 && (
              <Button
                type="primary"
                icon={<WalletOutlined />}
                loading={materializing}
                disabled={selectedPaymentIds.length === 0 || selectedUnmappedPaymentCount > 0}
                onClick={() => void materializePayments()}
              >
                Перенести выбранные платежи в ERP
              </Button>
                )}
              </>
            )}
          </Space>
        )}
      </Drawer>

      <Modal
        open={ambiguityResolution !== null}
        title={ambiguityResolution?.resolution === 'attach_existing'
          ? 'Привязать существующий платёж Bitrix24'
          : 'Подтвердить отсутствие платежа'}
        okText="Подтвердить решение"
        cancelText="Отмена"
        confirmLoading={ambiguityResolving}
        okButtonProps={{
          danger: ambiguityResolution?.resolution === 'confirm_absent',
          disabled: ambiguityReason.trim().length < 10 || (
            ambiguityResolution?.resolution === 'attach_existing' &&
            !/^[1-9][0-9]*$/.test(ambiguityPaymentId)
          ),
        }}
        onOk={() => void resolveAmbiguity()}
        onCancel={() => {
          setAmbiguityResolution(null);
          setAmbiguityPaymentId('');
          setAmbiguityReason('');
        }}
      >
        <Space direction="vertical" style={{ width: '100%' }}>
          <Alert
            type="warning"
            showIcon
            message="Финансовое решение будет записано в аудит"
            description="Перед подтверждением вручную откройте точную сделку Bitrix24 и проверьте оплаты."
          />
          {ambiguityResolution?.resolution === 'attach_existing' && (
            <Input
              value={ambiguityPaymentId}
              onChange={(event) => setAmbiguityPaymentId(event.target.value.replace(/\D/g, ''))}
              placeholder="Числовой ID платежа Bitrix24"
            />
          )}
          <Input.TextArea
            value={ambiguityReason}
            onChange={(event) => setAmbiguityReason(event.target.value)}
            maxLength={2000}
            rows={4}
            placeholder="Причина решения (минимум 10 символов)"
          />
        </Space>
      </Modal>

      <Drawer
        width={760}
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        title="Настройки синхронизации Bitrix"
      >
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Descriptions bordered size="small" column={2}>
            <Descriptions.Item label="Приложение">
              {health?.installationStatus || 'Не установлено'}
            </Descriptions.Item>
            <Descriptions.Item label="Токен до">
              {formatDateTime(health?.tokenExpiresAt ?? null)}
            </Descriptions.Item>
            <Descriptions.Item label="Очередь">
              {health
                ? `${health.queue.pending} ожидают, ${health.queue.processing} выполняются`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Ошибки">
              {health ? `${health.queue.failed} повторов, ${health.queue.dead} остановлено` : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Последняя обработка" span={2}>
              {formatDateTime(health?.lastProcessedAt ?? null)}
            </Descriptions.Item>
            <Descriptions.Item label="Последняя сверка платежей" span={2}>
              {formatDateTime(health?.lastReconcileAt ?? null)}
            </Descriptions.Item>
            <Descriptions.Item label="Последняя оплата из виджета" span={2}>
              {formatDateTime(health?.widget.lastSubmitAt ?? null)}
            </Descriptions.Item>
            <Descriptions.Item label="Оплаты ожидают заказа">
              {health?.widget.awaitingOrder ?? '—'}
            </Descriptions.Item>
            <Descriptions.Item label="Повтор ERP / неопределённые">
              {health
                ? `${health.widget.awaitingRetry} / ${health.widget.ambiguous}`
                : '—'}
            </Descriptions.Item>
            {health?.lastError && (
              <Descriptions.Item label="Последняя ошибка" span={2}>
                {health.lastError}
              </Descriptions.Item>
            )}
          </Descriptions>

          <Space>
            <Button
              icon={<ReloadOutlined />}
              loading={settingsLoading}
              onClick={() => void loadSettings()}
            >
              Обновить
            </Button>
            <Button
              disabled={!health || health.queue.failed + health.queue.dead === 0}
              loading={settingsLoading}
              onClick={() => void retryFailed()}
            >
              Повторить ошибки
            </Button>
          </Space>

          {ambiguousCommands.length > 0 && (
            <>
              <Alert
                type="error"
                showIcon
                message={`Неопределённых созданий оплаты: ${ambiguousCommands.length}`}
                description="Не повторяйте создание. Сверьте сделку Bitrix24 и вручную привяжите найденный платёж либо подтвердите его отсутствие."
              />
              <Table<Bitrix24AmbiguousPaymentCommand>
                rowKey="commandId"
                pagination={false}
                dataSource={ambiguousCommands}
                scroll={{ x: 820 }}
                columns={[
                  { title: 'Сделка', dataIndex: 'bitrixDealId', width: 90 },
                  {
                    title: 'Сумма / дата',
                    key: 'money',
                    render: (_, command) =>
                      `${money(Number(command.amount), command.currencyId)} · ${command.paymentDate}`,
                  },
                  { title: 'Actor Bitrix', dataIndex: 'bitrixActorUserId', width: 110 },
                  {
                    title: 'Кандидаты',
                    key: 'candidates',
                    render: (_, command) =>
                      command.diagnosticCandidateIds.join(', ') || 'Не определены',
                  },
                  {
                    title: 'Действия',
                    key: 'actions',
                    width: 230,
                    render: (_, command) => (
                      <Space>
                        <Button
                          size="small"
                          onClick={() => setAmbiguityResolution({
                            command,
                            resolution: 'attach_existing',
                          })}
                        >
                          Привязать ID
                        </Button>
                        <Button
                          size="small"
                          danger
                          onClick={() => setAmbiguityResolution({
                            command,
                            resolution: 'confirm_absent',
                          })}
                        >
                          Не создан
                        </Button>
                      </Space>
                    ),
                  },
                ]}
              />
            </>
          )}

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            Ответственные пользователи
          </Typography.Title>
          <Typography.Text type="secondary">
            ID пользователя берётся из Bitrix24. Активная связь назначает ответственного ERP;
            изменение автоматически ставит связанные активные заявки на повторную сверку.
          </Typography.Text>
          <Space wrap>
            <Input
              value={newBitrixUserId}
              onChange={(event) => setNewBitrixUserId(event.target.value.replace(/\D/g, ''))}
              placeholder="ID пользователя Bitrix24"
              style={{ width: 210 }}
            />
            <Select
              showSearch
              optionFilterProp="label"
              value={newErpUserId ?? undefined}
              options={userMappingTargets.map((target) => ({
                value: target.userId,
                label: target.fullName
                  ? `${target.fullName} (${target.username})`
                  : target.username,
              }))}
              onChange={(value) => setNewErpUserId(Number(value))}
              placeholder="Пользователь ERP"
              style={{ width: 300 }}
            />
            <Button
              type="primary"
              disabled={!/^[1-9][0-9]*$/.test(newBitrixUserId) || !newErpUserId}
              onClick={() => {
                if (newErpUserId) {
                  void updateUserMapping(newBitrixUserId, newErpUserId, true);
                }
              }}
            >
              Сопоставить
            </Button>
          </Space>
          <Table<Bitrix24UserMapping>
            rowKey="mappingId"
            loading={settingsLoading}
            pagination={false}
            dataSource={userMappings}
            columns={[
              { title: 'ID Bitrix24', dataIndex: 'bitrixUserId', width: 120 },
              {
                title: 'Пользователь ERP',
                key: 'erpUserId',
                render: (_, mapping) => (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    value={mapping.erpUserId}
                    options={userMappingTargets.map((target) => ({
                      value: target.userId,
                      label: target.fullName
                        ? `${target.fullName} (${target.username})`
                        : target.username,
                    }))}
                    style={{ width: '100%' }}
                    onChange={(value) =>
                      void updateUserMapping(mapping.bitrixUserId, Number(value), true)}
                  />
                ),
              },
              {
                title: 'Активно',
                key: 'active',
                width: 90,
                render: (_, mapping) => (
                  <Switch
                    checked={mapping.active}
                    onChange={(active) =>
                      void updateUserMapping(
                        mapping.bitrixUserId,
                        mapping.erpUserId,
                        active,
                      )}
                  />
                ),
              },
            ]}
          />

          <Typography.Title level={5} style={{ marginBottom: 0 }}>
            Платёжные системы
          </Typography.Title>
          <Typography.Text type="secondary">
            Без сопоставления платёж Bitrix не меняет деньги заказа ERP. В виджете доступны
            только активные системы с включённым переключателем.
          </Typography.Text>
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={catalogRefreshing}
              onClick={() => void refreshPaymentSystems()}
            >
              Обновить платёжные системы Bitrix
            </Button>
            <Typography.Text type="secondary">
              Последнее обновление: {formatDateTime(
                health?.paymentSystemCatalogLastFetchedAt ??
                  mappings.map((mapping) => mapping.lastFetchedAt).find(Boolean) ?? null,
              )}
            </Typography.Text>
          </Space>
          <Table<Bitrix24PaymentTypeMapping>
            rowKey="paySystemId"
            loading={settingsLoading}
            pagination={false}
            dataSource={mappings}
            columns={[
              { title: 'ID', dataIndex: 'paySystemId', width: 80 },
              {
                title: 'Система Bitrix',
                key: 'paySystem',
                render: (_, mapping) =>
                  mapping.paySystemName || `Система #${mapping.paySystemId}`,
              },
              {
                title: 'Тип оплаты ERP',
                key: 'typePaidId',
                render: (_, mapping) => (
                  <Select
                    value={mapping.typePaidId ?? undefined}
                    options={paymentTypeSelectProps.options}
                    loading={paymentTypeSelectProps.loading}
                    placeholder="Выберите тип"
                    style={{ width: '100%' }}
                    onChange={(value) =>
                      void updateMapping(mapping, Number(value), true)}
                  />
                ),
              },
              {
                title: 'В виджете',
                key: 'widgetEnabled',
                width: 100,
                render: (_, mapping) => (
                  <Switch
                    checked={mapping.widgetEnabled}
                    disabled={mapping.typePaidId === null || !mapping.active}
                    onChange={(widgetEnabled) =>
                      void updateMapping(
                        mapping,
                        mapping.typePaidId,
                        mapping.active,
                        widgetEnabled,
                        widgetEnabled ? mapping.isDefault : false,
                      )}
                  />
                ),
              },
              {
                title: 'По умолчанию',
                key: 'isDefault',
                width: 120,
                render: (_, mapping) => (
                  <Switch
                    checked={mapping.isDefault}
                    disabled={!mapping.active || !mapping.widgetEnabled}
                    onChange={(isDefault) =>
                      void updateMapping(
                        mapping,
                        mapping.typePaidId,
                        mapping.active,
                        mapping.widgetEnabled,
                        isDefault,
                      )}
                  />
                ),
              },
              {
                title: 'Активно',
                key: 'active',
                width: 90,
                render: (_, mapping) => (
                  <Switch
                    checked={mapping.active}
                    disabled={mapping.typePaidId === null}
                    onChange={(active) =>
                      void updateMapping(mapping, mapping.typePaidId, active)}
                  />
                ),
              },
            ]}
          />
        </Space>
      </Drawer>

      <Modal
        width={1280}
        title="Детали CRM-заявки"
        open={detailEditorOpen}
        confirmLoading={savingDetails}
        okText="Сохранить"
        cancelText="Отмена"
        onOk={() => void saveDetails()}
        onCancel={() => setDetailEditorOpen(false)}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info"
            showIcon
            message="Сумма CRM хранится отдельно. Расчёт ERP формируется только из этих деталей."
          />
          <Button icon={<PlusOutlined />} onClick={addDetailDraft}>
            Добавить деталь
          </Button>
          <Table<EditableRequestDetail>
            rowKey="localKey"
            size="small"
            pagination={false}
            dataSource={detailDrafts}
            scroll={{ x: 1_180, y: 460 }}
            columns={[
              {
                title: 'Название',
                width: 170,
                render: (_, detail) => (
                  <Input
                    value={detail.detailName ?? ''}
                    maxLength={200}
                    onChange={(event) => updateDetailDraft(detail.localKey, {
                      detailName: event.target.value || null,
                    })}
                  />
                ),
              },
              {
                title: 'Высота, мм',
                width: 115,
                render: (_, detail) => (
                  <InputNumber
                    min={0.01}
                    value={detail.height}
                    onChange={(value) => updateDetailDraft(detail.localKey, { height: value ?? 0 })}
                  />
                ),
              },
              {
                title: 'Ширина, мм',
                width: 115,
                render: (_, detail) => (
                  <InputNumber
                    min={0.01}
                    value={detail.width}
                    onChange={(value) => updateDetailDraft(detail.localKey, { width: value ?? 0 })}
                  />
                ),
              },
              {
                title: 'Кол-во',
                width: 90,
                render: (_, detail) => (
                  <InputNumber
                    min={1}
                    precision={0}
                    value={detail.quantity}
                    onChange={(value) => updateDetailDraft(detail.localKey, { quantity: value ?? 0 })}
                  />
                ),
              },
              {
                title: 'Материал',
                width: 210,
                render: (_, detail) => (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={sheetMaterialSelectProps.options}
                    loading={sheetMaterialSelectProps.loading}
                    value={detail.sheetMaterialTypeId || undefined}
                    onChange={(value) => updateDetailDraft(detail.localKey, {
                      sheetMaterialTypeId: Number(value),
                    })}
                    style={{ width: '100%' }}
                  />
                ),
              },
              {
                title: 'Фрезеровка',
                width: 170,
                render: (_, detail) => (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={millingTypeSelectProps.options}
                    loading={millingTypeSelectProps.loading}
                    value={detail.millingTypeId || undefined}
                    onChange={(value) => updateDetailDraft(detail.localKey, {
                      millingTypeId: Number(value),
                    })}
                    style={{ width: '100%' }}
                  />
                ),
              },
              {
                title: 'Обкат',
                width: 150,
                render: (_, detail) => (
                  <Select
                    showSearch
                    optionFilterProp="label"
                    options={edgeTypeSelectProps.options}
                    loading={edgeTypeSelectProps.loading}
                    value={detail.edgeTypeId || undefined}
                    onChange={(value) => updateDetailDraft(detail.localKey, {
                      edgeTypeId: Number(value),
                    })}
                    style={{ width: '100%' }}
                  />
                ),
              },
              {
                title: 'Плёнка',
                width: 170,
                render: (_, detail) => (
                  <Select
                    allowClear
                    showSearch
                    optionFilterProp="label"
                    options={filmSelectProps.options}
                    loading={filmSelectProps.loading}
                    value={detail.filmId ?? undefined}
                    onChange={(value) => updateDetailDraft(detail.localKey, {
                      filmId: value == null ? null : Number(value),
                    })}
                    style={{ width: '100%' }}
                  />
                ),
              },
              ...(canViewFinancials ? [{
                title: 'Стоимость',
                width: 125,
                render: (_, detail) => (
                  <InputNumber
                    min={0}
                    precision={2}
                    value={detail.detailCost}
                    onChange={(value) => updateDetailDraft(detail.localKey, { detailCost: value })}
                  />
                ),
              }] : []),
              {
                title: '',
                width: 52,
                fixed: 'right',
                render: (_, detail) => (
                  <Button
                    danger
                    type="text"
                    icon={<DeleteOutlined />}
                    title="Удалить деталь"
                    onClick={() => setDetailDrafts((current) =>
                      current.filter((item) => item.localKey !== detail.localKey))}
                  />
                ),
              },
            ]}
          />
        </Space>
      </Modal>

      <Modal
        title="Преобразовать CRM-заявку в заказ"
        open={conversionOpen}
        confirmLoading={converting}
        okText="Преобразовать"
        cancelText="Отмена"
        okButtonProps={{
          disabled: !conversionName.trim() || (!conversionCreateProject && !conversionProjectId),
        }}
        onOk={() => void convertToProduction()}
        onCancel={() => {
          setConversionOpen(false);
        }}
      >
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Input value={conversionName} maxLength={200} placeholder="Номер/название заказа" onChange={(event) => setConversionName(event.target.value)} />
          <Space>
            <Switch checked={conversionCreateProject} onChange={setConversionCreateProject} />
            <Typography.Text>Создать новый проект</Typography.Text>
          </Space>
          {!conversionCreateProject && (
            <InputNumber
              min={1}
              precision={0}
              value={conversionProjectId}
              onChange={(value) => setConversionProjectId(typeof value === 'number' ? value : null)}
              placeholder="ID существующего проекта этого клиента"
              style={{ width: '100%' }}
            />
          )}
        </Space>
      </Modal>
    </div>
  );
};

const RequestStateTag = ({ state }: { state: Bitrix24RequestState }) => {
  if (state === 'converted') return <Tag color="green">Производственный заказ</Tag>;
  if (state === 'archived') return <Tag>Архив</Tag>;
  if (state === 'unresolved') return <Tag color="orange">Ожидает клиента</Tag>;
  return <Tag color="blue">CRM-заявка</Tag>;
};

function paymentState(payment: Bitrix24IncomingPayment) {
  if (payment.state === 'deleted') return <Tag>Удалён в Bitrix</Tag>;
  if (payment.state === 'materialized') return <Tag color="green">В ERP</Tag>;
  if (!payment.paid) return <Tag color="orange">Не оплачен</Tag>;
  return <Tag color="blue">Готов к переносу</Tag>;
}

function money(value: number | null, currency: string | null): string {
  if (value === null) return '—';
  return `${new Intl.NumberFormat('ru-RU', { maximumFractionDigits: 2 }).format(value)} ${currency ?? ''}`.trim();
}

function formatDateTime(value: string | null): string {
  if (!value) return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString('ru-RU');
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Неизвестная ошибка';
}
