import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { useEffect, useState } from 'react';
import { bitrix24Api, type Bitrix24IncomingPayment } from '../../api/bitrix24Api';
import { BitrixPaymentAuthorship } from '../../components/bitrix24/BitrixAuthorship';
import { can } from '../../utils/permissions';
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Row, Col, Divider } from "antd";
import { formatNumber } from "../../utils/numberFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";

const { Title } = Typography;

export const PaymentShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "payment_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;
  const [sourcePayment, setSourcePayment] = useState<Bitrix24IncomingPayment | null>(null);
  const [sourceStatus, setSourceStatus] = useState<'idle' | 'loading' | 'error'>('idle');
  const canViewFinancials = can('orders.view_financials') && can('bitrix24.requests.view');
  useEffect(() => {
    let cancelled = false;
    setSourcePayment(null);
    setSourceStatus('idle');
    if (record?.order_id && canViewFinancials) {
      setSourceStatus('loading');
      void bitrix24Api.getMappedOrderPayments(Number(record.order_id)).then(view => {
        if (cancelled) return;
        setSourcePayment(view.linked ? view.payments.find(payment => payment.erpPaymentId === Number(record.payment_id)) ?? null : null);
        setSourceStatus('idle');
      }).catch(() => { if (!cancelled) setSourceStatus('error'); });
    }
    return () => { cancelled = true; };
  }, [record?.order_id, record?.payment_id, canViewFinancials]);

  useCurrentRecordTabTitle(record);

  const { data: orderOne } = useOne({
    resource: "orders",
    id: record?.order_id,
    queryOptions: { enabled: !!record?.order_id },
  });
  const { data: typeOne } = useOne({
    resource: "payment_types",
    id: record?.type_paid_id,
    queryOptions: { enabled: !!record?.type_paid_id },
  });

  return (
    <Show isLoading={isLoading} title="Просмотр Платежа">
      <Title level={5}>Основная информация</Title>
      {sourceStatus === 'loading' && <p>Загрузка авторства Bitrix…</p>}
      {sourceStatus === 'error' && <p role="status">Не удалось загрузить авторство Bitrix. Обновите страницу.</p>}
      {sourcePayment && <section aria-label="Авторство оплаты Bitrix"><BitrixPaymentAuthorship payment={sourcePayment} /><Divider /></section>}
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.payment_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Заказ</Title>
          <TextField value={orderOne?.data?.order_name ?? record?.order_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Тип оплаты</Title>
          <TextField
            value={typeOne?.data?.type_paid_name ?? record?.type_paid_id}
          />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Сумма</Title>
          <TextField value={formatNumber(record?.amount, 0)} />
        </Col>
        <Col span={8}>
          <Title level={5}>Дата платежа</Title>
          <DateField value={record?.payment_date} format="DD.MM.YYYY" />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Title level={5}>Примечание</Title>
          <TextField value={record?.notes || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Ключ 1C</Title>
          <TextField value={record?.ref_key_1c} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Создан</Title>
          <TextField value={record?.created_by || "-"} />
        </Col>
        <Col span={8}>
          <Title level={5}>Изменён</Title>
          <TextField value={record?.edited_by || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Создано</Title>
          <DateField value={record?.created_at} format="DD.MM.YYYY HH:mm:ss" />
        </Col>
        <Col span={8}>
          <Title level={5}>Обновлено</Title>
          <DateField value={record?.updated_at} format="DD.MM.YYYY HH:mm:ss" />
        </Col>
      </Row>
    </Show>
  );
};
