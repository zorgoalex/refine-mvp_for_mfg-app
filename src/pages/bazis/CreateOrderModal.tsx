import React, { useEffect, useMemo, useRef, useState } from 'react';
import { MinusOutlined } from '@ant-design/icons';
import { useSelect } from '@refinedev/antd';
import { Alert, Button, Form, Input, Modal, Select, Space, Typography, message } from 'antd';
import { useLocation, useNavigate } from 'react-router-dom';
import { ApiError } from '../../api/apiError';
import { bazisApi } from '../../api/bazisApi';
import { ordersApi } from '../../api/ordersApi';
import { projectsApi } from '../../api/projectsApi';
import type { OrderListItemDto } from '../../api/types/orderApi.types';
import { DraggableModalWrapper } from '../../components/DraggableModalWrapper';
import { MinimizedModalChip } from '../../components/MinimizedModalChip';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
import { resolveDefaultNewOrderStatusId } from '../../domain/orderStatusDefaults';
import { createBackendSelectProps, useOrderFormData } from '../../hooks/useOrderFormData';
import { RevisionTree } from './RevisionTree';

const { Text } = Typography;

interface CreateOrderModalProps {
  open: boolean;
  revisionId: number | null;
  /** ERP-проект ревизии — для предзаполнения клиента по существующим заказам проекта */
  projectId?: number | null;
  selectedNodeIds: number[];
  onClose: () => void;
}

interface CreateOrderFormValues {
  clientId?: number;
  orderName?: string;
  orderStatusId?: number;
}

export const CreateOrderModal: React.FC<CreateOrderModalProps> = ({
  open,
  revisionId,
  projectId,
  selectedNodeIds,
  onClose,
}) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { isActive: isTabActive } = useKeepAlive();
  const [minimized, setMinimized] = useState(false);
  const [form] = Form.useForm<CreateOrderFormValues>();
  const [checkedKeys, setCheckedKeys] = useState<number[]>([]);
  const [submitLoading, setSubmitLoading] = useState(false);
  const [defaultOrderNameLoading, setDefaultOrderNameLoading] = useState(false);
  const [idempotencyKey, setIdempotencyKey] = useState<string>(createUuid);
  const prevOpenRef = useRef(false);
  const orderFormData = useOrderFormData();
  const useBackendReferences = orderFormData.enabled;

  const { selectProps: clientSelectProps } = useSelect({
    resource: 'clients',
    optionLabel: 'client_name',
    optionValue: 'client_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    queryOptions: { enabled: open && !useBackendReferences },
  });

  const { selectProps: orderStatusSelectProps } = useSelect({
    resource: 'order_statuses',
    optionLabel: 'order_status_name',
    optionValue: 'order_status_id',
    filters: [{ field: 'is_active', operator: 'eq', value: true }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'order_status_id', order: 'asc' }],
    queryOptions: { enabled: open && !useBackendReferences },
  });

  const resolvedClientProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.clients, orderFormData.isLoading)
    : clientSelectProps;
  const resolvedOrderStatusProps = useBackendReferences
    ? createBackendSelectProps(orderFormData.references.orderStatuses, orderFormData.isLoading)
    : orderStatusSelectProps;

  const fallbackOrderStatus = useBackendReferences
    ? orderFormData.references.defaultOrderStatus
    : resolveDefaultNewOrderStatusId(orderStatusSelectProps.options);

  useEffect(() => {
    if (!isTabActive && open && !minimized) {
      setMinimized(true);
    }
  }, [isTabActive, minimized, open]);

  useEffect(() => {
    if (open && !prevOpenRef.current) {
      setMinimized(false);
      setCheckedKeys(selectedNodeIds);
      setIdempotencyKey(createUuid());
      form.resetFields();
      form.setFieldsValue({
        orderStatusId: orderFormData.references.defaultOrderStatus ?? fallbackOrderStatus,
      });
      void suggestNextOrderName(form, setDefaultOrderNameLoading);
      void suggestClientFromProject(form, projectId);
    }

    prevOpenRef.current = open;
  }, [
    fallbackOrderStatus,
    form,
    open,
    projectId,
    orderFormData.references.defaultOrderStatus,
    selectedNodeIds,
  ]);

  useEffect(() => {
    if (
      open
      && fallbackOrderStatus != null
      && form.getFieldValue('orderStatusId') == null
    ) {
      form.setFieldValue('orderStatusId', fallbackOrderStatus);
    }
  }, [fallbackOrderStatus, form, open]);

  const referenceErrorText = useMemo(() => {
    if (useBackendReferences && orderFormData.error) {
      return orderFormData.error.message;
    }

    return null;
  }, [orderFormData.error, useBackendReferences]);

  const handleSubmit = async () => {
    if (revisionId == null) {
      message.error('Ревизия не выбрана');
      return;
    }

    if (checkedKeys.length === 0) {
      message.warning('Выберите хотя бы одну панель');
      return;
    }

    const values = await form.validateFields();
    if (values.clientId == null || values.orderStatusId == null || !values.orderName?.trim()) {
      return;
    }

    setSubmitLoading(true);
    try {
      const response = await bazisApi.createOrder(revisionId, {
        clientId: values.clientId,
        orderName: values.orderName.trim(),
        orderStatusId: values.orderStatusId,
        selectedNodeIds: checkedKeys,
        idempotencyKey,
      });
      message.success(`Заказ ${response.orderName} создан`);
      onClose();
      navigate(`/orders/edit/${response.orderId}`);
    } catch (error) {
      if (error instanceof ApiError) {
        if (error.code === 'ORDER_NAME_DUPLICATE') {
          const details = error.details as { existingOrderId?: number; suggestedOrderName?: string | null } | undefined;
          const suggested = details?.suggestedOrderName;
          // Неудачная попытка пометила idempotency-ключ failed — повтор требует нового.
          setIdempotencyKey(createUuid());
          if (suggested) {
            form.setFieldsValue({ orderName: suggested });
            message.warning(`Номер занят заказом #${details?.existingOrderId ?? '—'} — подставлен свободный номер ${suggested}, нажмите «Создать» ещё раз`);
          } else {
            message.warning(`Номер занят заказом #${details?.existingOrderId ?? '—'} — укажите другой номер`);
          }
          return;
        }
        if (error.code === 'BAZIS_IDEMPOTENCY_IN_PROGRESS') {
          message.warning('Команда выполняется, повторите через минуту');
          return;
        }
        if (error.code === 'BAZIS_IDEMPOTENCY_FAILED' || error.code === 'BAZIS_IDEMPOTENCY_REUSED') {
          message.error('Закройте и откройте окно заново');
          return;
        }
        if (error.code === 'BAZIS_NO_PANELS') {
          message.warning('В выбранных узлах нет панелей');
          return;
        }
        message.error(error.message);
        return;
      }

      message.error(error instanceof Error ? error.message : 'Не удалось создать заказ');
    } finally {
      setSubmitLoading(false);
    }
  };

  const handleCancelEvent = (event: React.MouseEvent | React.KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('.ant-modal-close')) {
      onClose();
      return;
    }
    setMinimized(true);
  };

  return (
    <>
      <Modal
      open={open && !minimized}
      onCancel={handleCancelEvent}
      destroyOnClose={false}
      width={980}
      title={(
        <Space size={8}>
          <span>Создать заказ из ревизии</span>
          <Button
            type="text"
            size="small"
            icon={<MinusOutlined />}
            title="Свернуть"
            onClick={() => setMinimized(true)}
          />
        </Space>
      )}
      modalRender={(modal) => <DraggableModalWrapper open={open && !minimized}>{modal}</DraggableModalWrapper>}
      footer={(
        <Space>
          <Button onClick={onClose}>Закрыть</Button>
          <Button type="primary" onClick={() => void handleSubmit()} loading={submitLoading} disabled={revisionId == null}>
            Создать заказ
          </Button>
        </Space>
      )}
    >
      <Space direction="vertical" size="middle" style={{ width: '100%' }}>
        {referenceErrorText ? <Alert type="warning" showIcon message={referenceErrorText} /> : null}

        <Form form={form} layout="vertical">
          <Space align="start" size="middle" style={{ width: '100%', display: 'flex' }}>
            <Form.Item
              label="Клиент"
              name="clientId"
              style={{ minWidth: 280, flex: 1 }}
              rules={[{ required: true, message: 'Выберите клиента' }]}
            >
              <Select
                {...resolvedClientProps}
                showSearch
                allowClear
                placeholder="Клиент"
                optionFilterProp="label"
              />
            </Form.Item>

            <Form.Item
              label="Номер заказа"
              name="orderName"
              style={{ minWidth: 220, flex: 1 }}
              rules={[{ required: true, message: 'Укажите номер заказа' }]}
              extra={defaultOrderNameLoading ? 'Подбираю следующий номер…' : undefined}
            >
              <Input placeholder="Например, 1259" />
            </Form.Item>

            <Form.Item
              label="Статус заказа"
              name="orderStatusId"
              style={{ minWidth: 220, flex: 1 }}
              rules={[{ required: true, message: 'Выберите статус заказа' }]}
            >
              <Select
                {...resolvedOrderStatusProps}
                showSearch
                allowClear
                placeholder="Статус заказа"
                optionFilterProp="label"
              />
            </Form.Item>
          </Space>
        </Form>

        <Space direction="vertical" size={4} style={{ width: '100%' }}>
          <Text strong>Выбор узлов</Text>
          <Text type="secondary">
            Выбрано узлов: {checkedKeys.length}. Отмечайте панели или сборки, которые должны попасть в заказ.
          </Text>
        </Space>

        {revisionId != null ? (
          <RevisionTree
            revisionId={revisionId}
            checkedKeys={checkedKeys}
            onCheckedKeysChange={setCheckedKeys}
          />
        ) : (
          <Alert type="warning" showIcon message="Сначала выберите ревизию" />
        )}
      </Space>
    </Modal>
      {open && minimized ? (
        <MinimizedModalChip
          title="Создать заказ из ревизии"
          slot={1}
          onRestore={() => {
            if (location.pathname !== '/bazis') {
              navigate('/bazis');
            }
            setMinimized(false);
          }}
          onClose={onClose}
        />
      ) : null}
    </>
  );
};

async function suggestClientFromProject(
  form: ReturnType<typeof Form.useForm<CreateOrderFormValues>>[0],
  projectId: number | null | undefined,
): Promise<void> {
  if (projectId == null) {
    return;
  }

  try {
    // Клиент самого ERP-проекта (обязательное поле проекта) — работает и для
    // свежесозданных проектов без заказов. Fallback — клиент последнего заказа.
    let clientId: number | undefined;
    try {
      clientId = (await projectsApi.getById(projectId)).clientId ?? undefined;
    } catch {
      clientId = undefined;
    }

    if (clientId == null) {
      const response = await ordersApi.list({
        page: 1,
        pageSize: 1,
        projectId,
        sortBy: 'orderDate',
        sortOrder: 'desc',
      });
      clientId = response.data[0]?.clientId;
    }

    if (clientId == null) {
      return;
    }

    if (form.getFieldValue('clientId') == null) {
      form.setFieldsValue({ clientId });
    }
  } catch {
    // Non-blocking hint only.
  }
}

async function suggestNextOrderName(
  form: ReturnType<typeof Form.useForm<CreateOrderFormValues>>[0],
  setLoading: (loading: boolean) => void,
): Promise<void> {
  setLoading(true);
  try {
    const response = await ordersApi.list({
      page: 1,
      pageSize: 20,
      sortBy: 'orderDate',
      sortOrder: 'desc',
    });

    const next = buildNextOrderName(response.data);
    if (!next) {
      return;
    }

    const currentValue = form.getFieldValue('orderName');
    if (!currentValue) {
      form.setFieldsValue({ orderName: next });
    }
  } catch {
    // Non-blocking hint only.
  } finally {
    setLoading(false);
  }
}

function buildNextOrderName(items: OrderListItemDto[]): string | null {
  const numbers = items.flatMap((item) => {
    const trimmed = item.orderName.trim();
    return /^\d+$/.test(trimmed) ? [Number(trimmed)] : [];
  });

  if (numbers.length === 0) {
    return null;
  }

  return String(Math.max(...numbers) + 1);
}

function createUuid(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID();
  }

  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
