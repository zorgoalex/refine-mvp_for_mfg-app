import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useInvalidate } from '@refinedev/core';
import { Alert, Button, Space, Tag, Typography, message } from 'antd';
import { LinkOutlined, ReloadOutlined, WalletOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { Table } from '../../../../ui/tooltipDelay';
import {
  bitrix24Api,
  type Bitrix24IncomingPayment,
  type Bitrix24MappedOrderPayments,
} from '../../../../api/bitrix24Api';
import { formatNumber } from '../../../../utils/numberFormat';
import { can } from '../../../../utils/permissions';

const { Text, Title } = Typography;

interface BitrixOrderPaymentsPanelProps {
  orderId: number;
}

export const BitrixOrderPaymentsPanel: React.FC<BitrixOrderPaymentsPanelProps> = ({
  orderId,
}) => {
  const invalidate = useInvalidate();
  const [view, setView] = useState<Bitrix24MappedOrderPayments | null>(null);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [materializing, setMaterializing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canMaterialize = can('bitrix24.payments.materialize');

  const load = useCallback(async () => {
    setError(null);
    try {
      const result = await bitrix24Api.getMappedOrderPayments(orderId);
      setView(result);
      setSelectedIds((current) => result.linked
        ? current.filter((id) => result.payments.some((payment) => payment.bitrixPaymentId === id))
        : []);
    } catch (requestError) {
      setError(requestError instanceof Error ? requestError.message : 'Не удалось загрузить оплаты Bitrix');
    } finally {
      setLoading(false);
    }
  }, [orderId]);

  useEffect(() => {
    setLoading(true);
    void load();
  }, [load]);

  const selectableIds = useMemo(() => view?.linked
    ? view.payments
        .filter((payment) => payment.paid && payment.state !== 'deleted' && payment.erpPaymentId === null)
        .map((payment) => payment.bitrixPaymentId)
    : [], [view]);

  const refresh = async () => {
    setRefreshing(true);
    setError(null);
    try {
      const result = await bitrix24Api.reconcileMappedOrderPayments(orderId);
      setView(result);
      setSelectedIds([]);
      message.success('Оплаты из Bitrix обновлены');
    } catch (requestError) {
      const text = requestError instanceof Error ? requestError.message : 'Не удалось обновить оплаты Bitrix';
      setError(text);
      message.error(text);
    } finally {
      setRefreshing(false);
    }
  };

  const materialize = async () => {
    if (!view?.linked || selectedIds.length === 0) return;
    setMaterializing(true);
    setError(null);
    try {
      await bitrix24Api.materializeMappedOrderPayments(orderId, {
        bitrixPaymentIds: selectedIds,
        expectedOrderVersion: view.orderVersion,
      });
      await Promise.all([
        invalidate({ resource: 'orders', invalidates: ['list', 'detail'], id: orderId }),
        invalidate({ resource: 'orders_view', invalidates: ['list', 'detail'], id: orderId }),
        invalidate({ resource: 'payments', invalidates: ['list'] }),
      ]);
      setSelectedIds([]);
      await load();
      message.success('Выбранные оплаты перенесены в ERP');
    } catch (requestError) {
      const text = requestError instanceof Error ? requestError.message : 'Не удалось перенести оплаты в ERP';
      setError(text);
      message.error(text);
    } finally {
      setMaterializing(false);
    }
  };

  if (loading && view === null) {
    return <Text type="secondary">Загрузка оплат Bitrix…</Text>;
  }
  if (view && !view.linked) return null;
  if (!view?.linked) {
    return error ? <Alert type="error" showIcon message={error} /> : null;
  }

  return (
    <section
      aria-labelledby="bitrix-order-payments-title"
      style={{
        marginTop: 16,
        padding: 16,
        borderRadius: 10,
        background: 'var(--app-surface)',
        boxShadow: '0 0 0 1px rgba(0,0,0,0.06), 0 2px 4px rgba(0,0,0,0.04)',
      }}
    >
      <Space direction="vertical" size={12} style={{ width: '100%' }}>
        <Space wrap style={{ width: '100%', justifyContent: 'space-between' }}>
          <div>
            <Title
              id="bitrix-order-payments-title"
              level={5}
              style={{ margin: 0, textWrap: 'balance' }}
            >
              Оплаты из Bitrix
            </Title>
            <Text type="secondary" style={{ textWrap: 'pretty' }}>
              Последняя сверка: {view.lastReconciledAt
                ? dayjs(view.lastReconciledAt).format('DD.MM.YYYY HH:mm')
                : 'ещё не выполнялась'}
            </Text>
          </div>
          <Space wrap>
            <Button
              icon={<ReloadOutlined />}
              loading={refreshing}
              onClick={() => void refresh()}
              style={{ minHeight: 40 }}
            >
              Обновить из Bitrix
            </Button>
            <Button
              type="primary"
              icon={<WalletOutlined />}
              disabled={!canMaterialize || selectedIds.length === 0}
              loading={materializing}
              onClick={() => void materialize()}
              style={{ minHeight: 40 }}
            >
              Перенести выбранные в ERP
            </Button>
            <Button
              href={view.bitrixUrl}
              target="_blank"
              rel="noreferrer"
              icon={<LinkOutlined />}
              style={{ minHeight: 40 }}
            >
              Сделка
            </Button>
          </Space>
        </Space>

        {error && <Alert type="error" showIcon message={error} />}
        {!canMaterialize && (
          <Alert
            type="info"
            showIcon
            message="Оплаты доступны для просмотра. Для переноса требуется право materialize."
          />
        )}

        <Table<Bitrix24IncomingPayment>
          rowKey="bitrixPaymentId"
          size="small"
          bordered
          pagination={false}
          dataSource={view.payments}
          locale={{ emptyText: 'В Bitrix нет ручных оплат' }}
          rowSelection={canMaterialize ? {
            selectedRowKeys: selectedIds,
            onChange: (keys) => setSelectedIds(keys.map(String)),
            getCheckboxProps: (payment) => ({
              disabled: !selectableIds.includes(payment.bitrixPaymentId),
              'aria-label': `Выбрать оплату Bitrix ${payment.bitrixPaymentId}`,
            }),
          } : undefined}
          columns={[
            {
              title: 'ID',
              dataIndex: 'bitrixPaymentId',
              width: 90,
              render: (value: string) => <Text style={{ fontVariantNumeric: 'tabular-nums' }}>#{value}</Text>,
            },
            {
              title: 'Система',
              dataIndex: 'paySystemName',
              render: (_: unknown, payment) => (
                <Space direction="vertical" size={2}>
                  <Text>{payment.paySystemName || `ID ${payment.paySystemId ?? '—'}`}</Text>
                  {payment.mappedTypePaidId === null && <Tag color="error">Не сопоставлена</Tag>}
                </Space>
              ),
            },
            {
              title: 'Источник',
              dataIndex: 'source',
              width: 110,
              render: (value: Bitrix24IncomingPayment['source']) => (
                <Tag color={value === 'widget' ? 'blue' : 'default'}>
                  {value === 'widget' ? 'Виджет' : 'Bitrix'}
                </Tag>
              ),
            },
            {
              title: 'Дата',
              dataIndex: 'paymentDate',
              width: 110,
              render: (value: string | null) => value ? dayjs(value).format('DD.MM.YYYY') : '—',
            },
            {
              title: 'Сумма',
              dataIndex: 'amount',
              width: 140,
              align: 'right',
              render: (value: number, payment) => (
                <Text style={{ fontVariantNumeric: 'tabular-nums' }}>
                  {formatNumber(value, 2)} {payment.currencyId || '—'}
                </Text>
              ),
            },
            {
              title: 'Состояние',
              key: 'state',
              width: 160,
              render: (_: unknown, payment) => paymentState(payment),
            },
          ]}
        />
      </Space>
    </section>
  );
};

function paymentState(payment: Bitrix24IncomingPayment) {
  if (payment.state === 'deleted' || !payment.paid) return <Tag>Удалён / не проведён</Tag>;
  if (payment.erpPaymentId !== null) return <Tag color="success">ERP #{payment.erpPaymentId}</Tag>;
  if (payment.currencyId !== 'KZT') return <Tag color="error">Валюта {payment.currencyId || '—'}</Tag>;
  if (payment.mappedTypePaidId === null) return <Tag color="warning">Нужно сопоставление</Tag>;
  return <Tag color="processing">Готов к переносу</Tag>;
}
