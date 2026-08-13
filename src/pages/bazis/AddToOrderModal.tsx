import { Table } from '../../ui/tooltipDelay';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Button, Modal, Radio, Select, Space, Spin, Typography, message } from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { ApiError, isApiError } from '../../api/apiError';
import { bazisApi } from '../../api/bazisApi';
import type {
  BazisOrderDraftDetail,
  BazisOrderDraftDuplicate,
  BazisOrderDraftResponse,
} from '../../api/types/bazisApi.types';
import { ordersApi } from '../../api/ordersApi';
import type { OrderListItemDto } from '../../api/types/orderApi.types';

const { Text } = Typography;

interface AddToOrderModalProps {
  open: boolean;
  revisionId: number;
  selectedNodeIds: number[];
  onClose: () => void;
  onSuccess?: (orderId: number) => void;
}

type DuplicateDecision = 'replace' | 'skip';

interface DuplicateTableRow extends BazisOrderDraftDuplicate {
  key: string;
  panelTitle: string;
  matchLabel: string;
}

export const AddToOrderModal: React.FC<AddToOrderModalProps> = ({
  open,
  revisionId,
  selectedNodeIds,
  onClose,
  onSuccess,
}) => {
  // Клиент Базис-проекта определяется initial draft-запросом (без targetOrderId):
  // карточка проекта клиента не отдаёт, а server-filtered поиск заказов обязан
  // быть ограничен клиентом проекта. Заодно unmapped-материалы ловятся ДО выбора заказа.
  const [projectClient, setProjectClient] = useState<{ clientId: number; clientName: string | null } | null>(null);
  const [clientLoading, setClientLoading] = useState(false);
  const [orders, setOrders] = useState<OrderListItemDto[]>([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [orderSearch, setOrderSearch] = useState('');
  const [selectedOrderId, setSelectedOrderId] = useState<number | undefined>(undefined);
  const [selectedOrder, setSelectedOrder] = useState<OrderListItemDto | undefined>(undefined);
  const [draft, setDraft] = useState<BazisOrderDraftResponse | null>(null);
  const [draftLoading, setDraftLoading] = useState(false);
  const [draftErrorText, setDraftErrorText] = useState<string | null>(null);
  const [duplicateActions, setDuplicateActions] = useState<Record<string, DuplicateDecision>>({});
  const [submitLoading, setSubmitLoading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(createUuid);
  const prevOpenRef = useRef(false);
  const draftRequestSeqRef = useRef(0);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setOrders([]);
      setOrdersLoading(false);
      setOrderSearch('');
      setSelectedOrderId(undefined);
      setSelectedOrder(undefined);
      setDraft(null);
      setDraftLoading(false);
      setDraftErrorText(null);
      setDuplicateActions({});
      setSubmitLoading(false);
      setIdempotencyKey(createUuid());
      setProjectClient(null);
      setClientLoading(true);
      void (async () => {
        try {
          const initial = await bazisApi.orderDraft(revisionId, { selectedNodeIds });
          setProjectClient({ clientId: initial.clientId, clientName: initial.clientName });
        } catch (error) {
          if (isApiError(error, 'BAZIS_UNMAPPED_MATERIALS')) {
            showUnmappedMaterialsWarning(error as ApiError);
          } else {
            message.error(error instanceof Error ? error.message : 'Не удалось определить клиента проекта');
          }
          onClose();
        } finally {
          setClientLoading(false);
        }
      })();
    }

    if (!open && prevOpenRef.current) {
      draftRequestSeqRef.current += 1;
    }

    prevOpenRef.current = open;
  }, [open]);

  const projectClientId = projectClient?.clientId ?? null;

  useEffect(() => {
    if (!open || projectClientId == null) {
      return;
    }

    let cancelled = false;
    const timer = window.setTimeout(async () => {
      setOrdersLoading(true);
      try {
        const response = await ordersApi.list({
          clientId: projectClientId,
          search: orderSearch.trim() || undefined,
          pageSize: 50,
          sortBy: 'orderDate',
          sortOrder: 'desc',
        });

        if (!cancelled) {
          setOrders(response.data);
        }
      } catch (error) {
        if (!cancelled) {
          message.error(error instanceof Error ? error.message : 'Не удалось загрузить список заказов');
        }
      } finally {
        if (!cancelled) {
          setOrdersLoading(false);
        }
      }
    }, 300);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [open, orderSearch, projectClientId]);

  const draftPreview = useMemo(() => {
    if (!draft) {
      return {
        addableCount: selectedNodeIds.length,
        regularDuplicates: [] as DuplicateTableRow[],
        ambiguousDuplicates: [] as DuplicateTableRow[],
      };
    }

    const detailByNodeId = new Map(draft.details.map((detail) => [detail.bazisNodeId, detail]));
    const duplicateNodeCounts = countBy(draft.duplicates, (item) => item.bazisNodeId);
    const duplicateOrderDetailCounts = countBy(draft.duplicates, (item) => item.orderDetailId);
    const duplicateNodeIds = new Set(draft.duplicates.map((item) => item.bazisNodeId));
    const regularDuplicates: DuplicateTableRow[] = [];
    const ambiguousDuplicates: DuplicateTableRow[] = [];

    draft.duplicates.forEach((duplicate) => {
      const row: DuplicateTableRow = {
        ...duplicate,
        key: pairKey(duplicate),
        panelTitle: formatPanelTitle(detailByNodeId.get(duplicate.bazisNodeId), duplicate.bazisNodeId),
        matchLabel: duplicate.matchedBy === 'node_map' ? 'тот же узел' : 'по обозначению',
      };
      const ambiguous =
        (duplicateNodeCounts.get(duplicate.bazisNodeId) ?? 0) > 1 ||
        (duplicateOrderDetailCounts.get(duplicate.orderDetailId) ?? 0) > 1;

      if (ambiguous) {
        ambiguousDuplicates.push(row);
      } else {
        regularDuplicates.push(row);
      }
    });

    return {
      addableCount: selectedNodeIds.filter((nodeId) => !duplicateNodeIds.has(nodeId)).length,
      regularDuplicates,
      ambiguousDuplicates,
    };
  }, [draft, selectedNodeIds]);

  const masterDecision = useMemo<DuplicateDecision | undefined>(() => {
    if (draftPreview.regularDuplicates.length === 0) {
      return undefined;
    }

    const values = draftPreview.regularDuplicates.map((row) => duplicateActions[row.key] ?? 'replace');
    if (values.every((value) => value === 'replace')) {
      return 'replace';
    }
    if (values.every((value) => value === 'skip')) {
      return 'skip';
    }
    return undefined;
  }, [draftPreview.regularDuplicates, duplicateActions]);

  const duplicateColumns = useMemo<ColumnsType<DuplicateTableRow>>(
    () => [
      {
        title: 'Панель',
        dataIndex: 'panelTitle',
        key: 'panelTitle',
      },
      {
        title: 'Деталь заказа',
        dataIndex: 'orderDetailId',
        key: 'orderDetailId',
        width: 140,
        render: (value: number) => `#${value}`,
      },
      {
        title: 'Совпадение',
        dataIndex: 'matchLabel',
        key: 'matchLabel',
        width: 180,
      },
      {
        title: 'Действие',
        key: 'decision',
        width: 220,
        render: (_, row) => (
          <Radio.Group
            value={duplicateActions[row.key] ?? 'replace'}
            onChange={(event) => {
              const value = event.target.value as DuplicateDecision;
              setDuplicateActions((current) => ({ ...current, [row.key]: value }));
            }}
          >
            <Radio value="replace">Заменить</Radio>
            <Radio value="skip">Пропустить</Radio>
          </Radio.Group>
        ),
      },
    ],
    [duplicateActions],
  );

  const ambiguousColumns = useMemo<ColumnsType<DuplicateTableRow>>(
    () => [
      {
        title: 'Панель',
        dataIndex: 'panelTitle',
        key: 'panelTitle',
      },
      {
        title: 'Деталь заказа',
        dataIndex: 'orderDetailId',
        key: 'orderDetailId',
        width: 140,
        render: (value: number) => `#${value}`,
      },
      {
        title: 'Совпадение',
        dataIndex: 'matchLabel',
        key: 'matchLabel',
        width: 180,
      },
      {
        title: 'Действие',
        key: 'decision',
        width: 220,
        render: () => (
          <Radio.Group value="skip" disabled>
            <Radio value="replace">Заменить</Radio>
            <Radio value="skip">Пропустить</Radio>
          </Radio.Group>
        ),
      },
    ],
    [],
  );

  const loadDraft = async (targetOrderId: number): Promise<void> => {
    const requestSeq = draftRequestSeqRef.current + 1;
    draftRequestSeqRef.current = requestSeq;
    setDraftLoading(true);
    setDraftErrorText(null);

    try {
      const response = await bazisApi.orderDraft(revisionId, { selectedNodeIds, targetOrderId });
      if (draftRequestSeqRef.current !== requestSeq) {
        return;
      }

      setDraft(response);
      setDuplicateActions(
        Object.fromEntries(
          response.duplicates
            .filter((duplicate) => !isAmbiguousDuplicate(duplicate, response.duplicates))
            .map((duplicate) => [pairKey(duplicate), 'replace' as const]),
        ),
      );
    } catch (error) {
      if (draftRequestSeqRef.current !== requestSeq) {
        return;
      }

      setDraft(null);
      setDuplicateActions({});

      if (isApiError(error, 'BAZIS_UNMAPPED_MATERIALS')) {
        showUnmappedMaterialsWarning(error);
        return;
      }

      setDraftErrorText(error instanceof Error ? error.message : 'Не удалось подготовить предпросмотр');
    } finally {
      if (draftRequestSeqRef.current === requestSeq) {
        setDraftLoading(false);
      }
    }
  };

  const handleOrderChange = (value: number | undefined) => {
    if (value == null) {
      draftRequestSeqRef.current += 1;
      setSelectedOrderId(undefined);
      setSelectedOrder(undefined);
      setDraft(null);
      setDraftLoading(false);
      setDraftErrorText(null);
      setDuplicateActions({});
      return;
    }

    const picked = [selectedOrder, ...orders].find(
      (order): order is OrderListItemDto => Boolean(order) && order.orderId === value,
    );
    setSelectedOrderId(value);
    setSelectedOrder(picked);
    setDraft(null);
    setDuplicateActions({});
    void loadDraft(value);
  };

  const handleSubmit = async () => {
    if (selectedOrderId == null || draft == null || submitLoading) {
      return;
    }

    const duplicateNodeIds = new Set(draft.duplicates.map((duplicate) => duplicate.bazisNodeId));
    const adds = selectedNodeIds.filter((nodeId) => !duplicateNodeIds.has(nodeId));
    const replaces = draftPreview.regularDuplicates
      .filter((row) => (duplicateActions[row.key] ?? 'replace') === 'replace')
      .map(({ bazisNodeId, orderDetailId }) => ({ bazisNodeId, orderDetailId }));
    const skips = [
      ...draftPreview.regularDuplicates
        .filter((row) => (duplicateActions[row.key] ?? 'replace') === 'skip')
        .map(({ bazisNodeId, orderDetailId }) => ({ bazisNodeId, orderDetailId })),
      ...draftPreview.ambiguousDuplicates.map(({ bazisNodeId, orderDetailId }) => ({ bazisNodeId, orderDetailId })),
    ];

    setSubmitLoading(true);
    try {
      const response = await bazisApi.addToOrder(revisionId, {
        orderId: selectedOrderId,
        adds,
        replaces,
        skips,
        idempotencyKey,
      });

      message.success(
        {
          content: (
            <Space size={8} wrap>
              <span>{`В заказ #${response.orderId} добавлено ${response.detailsAdded}, заменено ${response.detailsReplaced}`}</span>
              <a href={`/orders/edit/${response.orderId}`}>Открыть заказ</a>
            </Space>
          ),
        },
      );
      onSuccess?.(response.orderId);
      onClose();
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'BAZIS_ADD_TO_ORDER_CONFLICT') {
          setIdempotencyKey(createUuid());
          message.warning('Данные изменились, обновляю предпросмотр заказа');
          await loadDraft(selectedOrderId);
          return;
        }

        if (error.code === 'BAZIS_UNMAPPED_MATERIALS') {
          setIdempotencyKey(createUuid());
          showUnmappedMaterialsWarning(error);
          return;
        }

        if (error.code === 'BAZIS_IDEMPOTENCY_IN_PROGRESS') {
          setIdempotencyKey(createUuid());
          message.warning('Команда уже обрабатывается, повторите попытку');
          return;
        }

        if (error.code === 'BAZIS_IDEMPOTENCY_FAILED' || error.code === 'BAZIS_IDEMPOTENCY_REUSED') {
          setIdempotencyKey(createUuid());
          message.warning('Подготовлен новый ключ запроса, повторите добавление');
          return;
        }

        message.error(error.message);
        return;
      }

      message.error(error instanceof Error ? error.message : 'Не удалось добавить детали в заказ');
    } finally {
      setSubmitLoading(false);
    }
  };

  return (
    <Modal
      open={open}
      width={1080}
      destroyOnClose={false}
      onCancel={onClose}
      title="В существующий заказ"
      footer={(
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button
            type="primary"
            onClick={() => void handleSubmit()}
            loading={submitLoading}
            disabled={selectedOrderId == null || draftLoading || draft == null}
          >
            Добавить
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text type="secondary">
            {projectClient != null
              ? `Показываю заказы клиента ${projectClient.clientName?.trim() || `#${projectClient.clientId}`}`
              : 'Определяю клиента Базис-проекта…'}
          </Text>
          <Select<number>
            showSearch
            allowClear
            disabled={projectClient == null}
            loading={ordersLoading || clientLoading}
            placeholder="Найдите заказ по номеру или названию"
            style={{ width: '100%' }}
            value={selectedOrderId}
            filterOption={false}
            onSearch={(value) => setOrderSearch(value)}
            onChange={(value) => handleOrderChange(value)}
            options={(
              selectedOrder && !orders.some((order) => order.orderId === selectedOrder.orderId)
                ? [selectedOrder, ...orders]
                : orders
            ).map((order) => ({
              value: order.orderId,
              label: formatOrderOption(order),
            }))}
          />
        </Space>

        {selectedOrderId == null ? (
          <Text type="secondary">Выберите заказ, чтобы загрузить предпросмотр замены и добавления деталей.</Text>
        ) : null}

        {draftLoading ? (
          <Space align="center" size="middle">
            <Spin />
            <Text>Готовлю предпросмотр…</Text>
          </Space>
        ) : null}

        {!draftLoading && draftErrorText ? (
          <Text type="danger">{draftErrorText}</Text>
        ) : null}

        {!draftLoading && draft ? (
          <Space direction="vertical" size="middle" style={{ width: '100%' }}>
            <Text strong>Добавится {draftPreview.addableCount} деталей</Text>

            {draftPreview.regularDuplicates.length > 0 ? (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Space align="center" size="middle" wrap>
                  <Text strong>Найдены совпадения</Text>
                  <Radio.Group
                    value={masterDecision}
                    onChange={(event) => {
                      const value = event.target.value as DuplicateDecision;
                      setDuplicateActions(
                        Object.fromEntries(
                          draftPreview.regularDuplicates.map((row) => [row.key, value]),
                        ),
                      );
                    }}
                  >
                    <Radio value="replace">Заменить все</Radio>
                    <Radio value="skip">Пропустить все</Radio>
                  </Radio.Group>
                </Space>
                <Table<DuplicateTableRow>
                  size="small"
                  pagination={false}
                  rowKey="key"
                  columns={duplicateColumns}
                  dataSource={draftPreview.regularDuplicates}
                />
              </Space>
            ) : null}

            {draftPreview.ambiguousDuplicates.length > 0 ? (
              <Space direction="vertical" size="small" style={{ width: '100%' }}>
                <Text strong>Неоднозначное совпадение — только пропуск</Text>
                <Table<DuplicateTableRow>
                  size="small"
                  pagination={false}
                  rowKey="key"
                  columns={ambiguousColumns}
                  dataSource={draftPreview.ambiguousDuplicates}
                />
              </Space>
            ) : null}
          </Space>
        ) : null}
      </Space>
    </Modal>
  );
};

function showUnmappedMaterialsWarning(error: ApiError): void {
  const details = error.details as
    | { unmappedMaterials?: string[]; materialNames?: string[] }
    | undefined;
  const materialNames = (details?.unmappedMaterials ?? details?.materialNames ?? []).filter(
    (name) => name?.trim(),
  );

  Modal.warning({
    title: 'Не все материалы замаплены',
    content: (
      <Space direction="vertical" size={8}>
        <span>
          Сопоставьте материалы на вкладке «Материалы» этого проекта
          (кнопка «Сопоставить материалы») и повторите.
        </span>
        {materialNames.length > 0 ? (
          <ul style={{ margin: 0, paddingLeft: 20 }}>
            {materialNames.map((name) => (
              <li key={name}>{name}</li>
            ))}
          </ul>
        ) : null}
      </Space>
    ),
  });
}

function countBy<T>(items: T[], keyOf: (item: T) => number): Map<number, number> {
  const result = new Map<number, number>();
  items.forEach((item) => {
    const key = keyOf(item);
    result.set(key, (result.get(key) ?? 0) + 1);
  });
  return result;
}

function isAmbiguousDuplicate(
  candidate: BazisOrderDraftDuplicate,
  duplicates: BazisOrderDraftDuplicate[],
): boolean {
  const sameNode = duplicates.filter((item) => item.bazisNodeId === candidate.bazisNodeId).length;
  const sameOrderDetail = duplicates.filter((item) => item.orderDetailId === candidate.orderDetailId).length;
  return sameNode > 1 || sameOrderDetail > 1;
}

function formatPanelTitle(detail: BazisOrderDraftDetail | undefined, bazisNodeId: number): string {
  const name = detail?.detailName?.trim();
  const designation = detail?.basisDesignation?.trim();
  if (name && designation) {
    return `${name} (${designation})`;
  }
  return name || designation || `Узел #${bazisNodeId}`;
}

function formatOrderOption(order: OrderListItemDto): string {
  const datePart = formatDate(order.orderDate);
  return [order.fullNumber, order.orderName, datePart].filter(Boolean).join(' · ');
}

function formatDate(value: string | null | undefined): string {
  if (!value) {
    return '';
  }

  const [year, month, day] = value.split('-');
  if (!year || !month || !day) {
    return value;
  }

  return `${day}.${month}.${year}`;
}

function pairKey(pair: BazisOrderDraftDuplicate): string {
  return `${pair.bazisNodeId}:${pair.orderDetailId}`;
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
