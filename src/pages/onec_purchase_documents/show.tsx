import { Show } from '@refinedev/antd';
import type { IResourceComponentsProps } from '@refinedev/core';
import { Alert, Button, Descriptions, Drawer, Popconfirm, Space, Spin, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { ApiError, isApiError } from '../../api/apiError';
import { onecDocumentsApi } from '../../api/onecDocumentsApi';
import { ordersApi } from '../../api/ordersApi';
import type { OnecAllocationDto, OnecDocumentCardDto, OnecDocumentLineDto, OnecDocumentsTab } from '../../api/types/onecDocumentsApi.types';
import { Table } from '../../ui/tooltipDelay';
import { formatDate, formatDateTime } from '../../utils/dateFormat';
import {
  onecDocKindLabel,
  onecDocumentStatusLabel,
  onecDocumentStatusTagColor,
  orderResourceRequirementsOnecFilterPath,
} from '../order_resource_requirements/onecDocKind';
import { AllocationModal } from './AllocationModal';
import { AllocationSuggestionPanel } from './AllocationSuggestionPanel';
import { canAddOnecAllocation, formatOnecAmount, formatOnecQuantity, onecAllocationErrorMessage, onecAllocationOriginLabel } from './onecDocumentsHelpers';
import { useOnecDocumentsPermissions } from './onecDocumentsPermissions';

type LoadState =
  | { status: 'loading' }
  | { status: 'disabled' }
  | { status: 'notfound' }
  | { status: 'error'; message: string }
  | { status: 'ready'; data: OnecDocumentCardDto; amountsVisible: boolean; supplyWorkspace: boolean };

const BACK_TO_LIST = <Link to="/procurement/onec-documents">Вернуться к списку</Link>;

/**
 * Карточка документа 1С: шапка, строки с сопоставлением номенклатуры и
 * распределением по заказам. До фазы 4 (ETL) документов ещё нет — сюда можно
 * попасть только по прямой ссылке на несуществующий id (404).
 */
export const OnecPurchaseDocumentShow: React.FC<IResourceComponentsProps> = () => {
  const { documentId: documentIdParam } = useParams<{ documentId: string }>();
  const documentId = Number(documentIdParam);
  const isValidId = Number.isFinite(documentId) && documentId > 0;
  const [state, setState] = useState<LoadState>({ status: isValidId ? 'loading' : 'notfound' });
  const [revision, setRevision] = useState(0);
  const { canManage, canSeeAmounts, loading: permissionsLoading } = useOnecDocumentsPermissions();
  const [allocationLineId, setAllocationLineId] = useState<number | null>(null);
  const [removingAllocationId, setRemovingAllocationId] = useState<number | null>(null);
  const [suggestOpen, setSuggestOpen] = useState(false);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  useEffect(() => {
    if (!isValidId) {
      setState({ status: 'notfound' });
      return;
    }
    let active = true;
    setState((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    onecDocumentsApi.getCard(documentId)
      .then((response) => {
        if (!active) return;
        setState({ status: 'ready', data: response.data, amountsVisible: response.amountsVisible, supplyWorkspace: response.capabilities?.supplyWorkspace === true });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isApiError(error, 'PROCUREMENT_DISABLED')) {
          setState({ status: 'disabled' });
          return;
        }
        if (isApiError(error, 'PERMISSION_DENIED') || isApiError(error, 'AUTH_REQUIRED')) {
          setState({ status: 'error', message: 'Недостаточно прав для просмотра документа.' });
          return;
        }
        if (error instanceof ApiError && error.status === 404) {
          setState({ status: 'notfound' });
          return;
        }
        setState({ status: 'error', message: error instanceof Error ? error.message : 'Не удалось загрузить документ' });
      });
    return () => {
      active = false;
    };
  }, [documentId, isValidId, revision]);

  const handleRemove = async (line: OnecDocumentLineDto, allocation: OnecAllocationDto) => {
    if (state.status !== 'ready') return;
    setRemovingAllocationId(allocation.allocationId);
    try {
      // Версия закупа приходит вместе с распределением: работает и для материала, которого
      // уже нет в потребности заказа (иначе снять такую оплату было бы нельзя).
      await onecDocumentsApi.removeAllocation(state.data.documentId, line.lineId, allocation.allocationId, {
        expectedVersion: allocation.procurementVersion,
      });
      message.success('Распределение снято');
    } catch (error) {
      message.error(onecAllocationErrorMessage(error instanceof ApiError ? error : undefined));
    } finally {
      setRemovingAllocationId(null);
      refresh();
    }
  };

  return (
    <Show title="Документ 1С" canDelete={false} canEdit={false} headerButtons={() => null}>
      {state.status === 'loading' && <Spin />}
      {state.status === 'disabled' && (
        <Alert showIcon type="info" message="Документы 1С пока не включены" description={BACK_TO_LIST} />
      )}
      {state.status === 'notfound' && (
        <Alert showIcon type="error" message="Документ не найден или недоступен" description={BACK_TO_LIST} />
      )}
      {state.status === 'error' && (
        <Alert showIcon type="error" message="Не удалось открыть документ" description={<>{state.message} {BACK_TO_LIST}</>} />
      )}
      {state.status === 'ready' && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <DocumentHeader data={state.data} amountsVisible={state.amountsVisible} />
          {/* Только при включённом экране снабжения (capability; старый backend без поля — выключено, CR1-3). */}
          {state.supplyWorkspace && canSuggestAllocations(state.data) && canManage && !permissionsLoading && (
            <Button onClick={() => setSuggestOpen(true)}>Подобрать заказы</Button>
          )}
          <Table<OnecDocumentLineDto>
            rowKey="lineId"
            size="small"
            dataSource={state.data.lines}
            pagination={false}
          >
            <Table.Column<OnecDocumentLineDto> key="lineNo" title="№" width={50} render={(_, row) => row.lineNo} />
            <Table.Column<OnecDocumentLineDto>
              key="nomenclature"
              title="Номенклатура 1С"
              render={(_, row) => row.nomenclatureName ?? '—'}
            />
            <Table.Column<OnecDocumentLineDto>
              key="material"
              title="Материал ERP"
              render={(_, row) => (row.material ? row.material.name : <Tag>не сопоставлено</Tag>)}
            />
            <Table.Column<OnecDocumentLineDto>
              key="quantity"
              title="Количество"
              align="right"
              render={(_, row) => formatOnecQuantity(row.quantity, row.unitCode, row.unitName)}
            />
            {state.amountsVisible && (
              <Table.Column<OnecDocumentLineDto>
                key="price"
                title="Цена / Сумма"
                align="right"
                render={(_, row) => (
                  <Space direction="vertical" size={0}>
                    <span>{row.price != null ? formatOnecAmount(row.price, state.data.currency) : '—'}</span>
                    <Typography.Text type="secondary" style={{ fontSize: 12 }}>{formatOnecAmount(row.amount, state.data.currency)}</Typography.Text>
                  </Space>
                )}
              />
            )}
            <Table.Column<OnecDocumentLineDto>
              key="progress"
              title="Распределено / остаток"
              align="right"
              render={(_, row) => (
                <span>
                  {row.allocated ?? '—'} / {row.remaining ?? '—'}
                </span>
              )}
            />
            <Table.Column<OnecDocumentLineDto>
              key="allocations"
              title="Заказы"
              render={(_, row) => (
                <Space direction="vertical" size={4} style={{ width: '100%' }}>
                  {row.allocations.map((allocation) => (
                    <Space key={allocation.allocationId} size={6} wrap>
                      <Link to={`/order-resource-requirements/show/${allocation.orderId}`}>
                        {allocation.orderName || `#${allocation.orderId}`}
                      </Link>
                      <span>
                        {allocation.role === 'receipt' ? formatOnecQuantity(allocation.quantity ?? 0, row.unitCode, row.unitName) : formatOnecAmount(allocation.amount, state.data.currency)}
                      </span>
                      <Tag style={{ marginInlineEnd: 0 }}>{onecAllocationOriginLabel(allocation.origin)}</Tag>
                      {canManage && (
                        <Popconfirm
                          title="Снять распределение?"
                          okText="Снять"
                          cancelText="Отмена"
                          onConfirm={() => void handleRemove(row, allocation)}
                        >
                          <Typography.Link disabled={removingAllocationId === allocation.allocationId} type="danger">
                            {removingAllocationId === allocation.allocationId ? 'Снимаю…' : 'Убрать'}
                          </Typography.Link>
                        </Popconfirm>
                      )}
                    </Space>
                  ))}
                  {row.hiddenAllocationsCount > 0 && (
                    <Typography.Text type="secondary">ещё {row.hiddenAllocationsCount} вне вашего доступа</Typography.Text>
                  )}
                  {canAddOnecAllocation({
                    tab: documentTab(state.data),
                    posted: state.data.posted,
                    deletedInOnec: state.data.deletedInOnec,
                    lineMapped: row.material != null,
                    remaining: row.remaining,
                    canManage,
                    canSeeAmounts,
                  }) && !permissionsLoading && (
                    <Typography.Link onClick={() => setAllocationLineId(row.lineId)}>+ Заказ</Typography.Link>
                  )}
                </Space>
              )}
            />
          </Table>
          <OrdersSummary data={state.data} documentId={documentId} />
        </Space>
      )}

      {state.status === 'ready' && allocationLineId != null && (
        <AllocationModal
          open
          document={state.data}
          line={state.data.lines.find((candidate) => candidate.lineId === allocationLineId)!}
          tab={documentTab(state.data)}
          onClose={() => setAllocationLineId(null)}
          onSuccess={() => {
            setAllocationLineId(null);
            refresh();
          }}
        />
      )}

      {state.status === 'ready' && (
        <Drawer
          title="Подобрать заказы"
          open={suggestOpen}
          onClose={() => setSuggestOpen(false)}
          width={960}
          destroyOnClose
        >
          <AllocationSuggestionPanel
            documentId={state.data.documentId}
            onDone={() => {
              setSuggestOpen(false);
              refresh();
            }}
          />
        </Drawer>
      )}
    </Show>
  );
};

/** Кнопка «Подобрать заказы» — только для проведённого и не удалённого в 1С прихода. */
function canSuggestAllocations(data: OnecDocumentCardDto): boolean {
  return data.kind === 'purchase_receipt' && data.posted && !data.deletedInOnec;
}

function DocumentHeader({ data, amountsVisible }: { data: OnecDocumentCardDto; amountsVisible: boolean }) {
  return (
    <Descriptions bordered size="small" column={2}>
      <Descriptions.Item label="Документ">
        №{data.number} · {onecDocKindLabel(data.kind)}
      </Descriptions.Item>
      <Descriptions.Item label="Дата">{formatDate(data.date)}</Descriptions.Item>
      <Descriptions.Item label="Контрагент">{data.counterpartyName ?? '—'}</Descriptions.Item>
      <Descriptions.Item label="Поставщик">{data.supplierName ?? '—'}</Descriptions.Item>
      {amountsVisible && (
        <Descriptions.Item label="Сумма">{formatOnecAmount(data.amount, data.currency)}</Descriptions.Item>
      )}
      <Descriptions.Item label="Статус">
        <Tag color={onecDocumentStatusTagColor(data.posted, data.deletedInOnec)}>
          {onecDocumentStatusLabel(data.posted, data.deletedInOnec)}
        </Tag>
      </Descriptions.Item>
      <Descriptions.Item label="Источник">{data.sourceCode}</Descriptions.Item>
      <Descriptions.Item label="Загружен">{formatDateTime(data.loadedAt)}</Descriptions.Item>
    </Descriptions>
  );
}

/** «Заказы, для которых закуплено»: те же распределения, сгруппированные по заказу, а не по строке. */
function OrdersSummary({ data, documentId }: { data: OnecDocumentCardDto; documentId: number }) {
  const byOrder = new Map<number, { orderName: string; items: Array<{ line: OnecDocumentLineDto; allocation: OnecAllocationDto }> }>();
  data.lines.forEach((line) => {
    line.allocations.forEach((allocation) => {
      const entry = byOrder.get(allocation.orderId) ?? { orderName: allocation.orderName, items: [] };
      entry.items.push({ line, allocation });
      byOrder.set(allocation.orderId, entry);
    });
  });
  if (byOrder.size === 0) {
    return (
      <div>
        <Typography.Title level={5}>Заказы, для которых закуплено</Typography.Title>
        <Typography.Text type="secondary">Документ пока не привязан ни к одному заказу.</Typography.Text>
      </div>
    );
  }
  return (
    <div>
      <Space size={12} align="baseline" wrap>
        <Typography.Title level={5} style={{ marginBottom: 0 }}>Заказы, для которых закуплено</Typography.Title>
        <Link to={orderResourceRequirementsOnecFilterPath(documentId)}>Показать заказы в потребностях</Link>
      </Space>
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        {[...byOrder.entries()].map(([orderId, entry]) => (
          <div key={orderId}>
            <Link to={`/order-resource-requirements/show/${orderId}`}>{entry.orderName || `#${orderId}`}</Link>
            <ul style={{ margin: '4px 0 0', paddingLeft: 20 }}>
              {entry.items.map(({ line, allocation }) => (
                <li key={allocation.allocationId}>
                  {line.material?.name ?? line.nomenclatureName ?? '—'} ·{' '}
                  {allocation.role === 'receipt'
                    ? formatOnecQuantity(allocation.quantity ?? 0, line.unitCode, line.unitName)
                    : formatOnecAmount(allocation.amount, data.currency)}
                  {' '}
                  <Tag style={{ marginInlineEnd: 0 }}>{onecAllocationOriginLabel(allocation.origin)}</Tag>
                </li>
              ))}
            </ul>
          </div>
        ))}
      </Space>
    </div>
  );
}

function documentTab(data: OnecDocumentCardDto): OnecDocumentsTab {
  return data.kind === 'purchase_receipt' ? 'receipts' : 'payments';
}

