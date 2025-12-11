import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Row, Col, Divider, Card, Statistic, Tag, Space, Button } from "antd";
import {
  DollarOutlined,
  ShoppingCartOutlined,
  UserOutlined,
  CalendarOutlined,
  LinkOutlined,
  WarningOutlined,
  CheckCircleOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";

const { Title, Text } = Typography;

export const PaymentsAnalyticsShow: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const { queryResult } = useShow({
    meta: { idColumnName: "payment_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  // Цвет для статуса оплаты
  const getPaymentStatusColor = (status: string | null) => {
    if (status === 'Не оплачен') return 'red';
    if (status === 'Частично оплачен') return 'orange';
    if (status === 'Оплачен') return 'green';
    return 'default';
  };

  const handleGoToOrder = () => {
    if (record?.order_id) {
      navigate(`/orders/show/${record.order_id}`);
    }
  };

  return (
    <Show isLoading={isLoading} title="Просмотр платежа">
      {/* Основная информация о платеже */}
      <Title level={5}>Платёж</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="ID платежа"
              value={record?.payment_id}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Сумма"
              value={record?.amount || 0}
              prefix={<DollarOutlined />}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Дата платежа"
              value={formatDate(record?.payment_date)}
              prefix={<CalendarOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Тип оплаты"
              value={record?.type_paid_name || "—"}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="№ платежа в заказе"
              value={record?.payment_sequence_number || 1}
            />
          </Card>
        </Col>
      </Row>

      {record?.notes && (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Title level={5}>Примечание</Title>
            <TextField value={record.notes} />
          </Col>
        </Row>
      )}

      <Divider />

      {/* Информация о заказе */}
      <Title level={5}>
        <Space>
          Заказ
          <Button
            type="link"
            icon={<LinkOutlined />}
            onClick={handleGoToOrder}
            style={{ padding: 0 }}
          >
            Перейти к заказу
          </Button>
        </Space>
      </Title>
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Title level={5}>№ заказа</Title>
          <TextField value={record?.order_name} style={{ fontSize: 16, fontWeight: 500 }} />
        </Col>
        <Col span={4}>
          <Title level={5}>ID заказа</Title>
          <TextField value={record?.order_id} />
        </Col>
        <Col span={4}>
          <Title level={5}>Дата заказа</Title>
          <TextField value={formatDate(record?.order_date)} />
        </Col>
        <Col span={4}>
          <Title level={5}>Приоритет</Title>
          <TextField value={record?.priority || "—"} />
        </Col>
        <Col span={4}>
          <Title level={5}>План. дата</Title>
          <TextField value={formatDate(record?.planned_completion_date)} />
        </Col>
        <Col span={4}>
          <Title level={5}>Дата выполнения</Title>
          <TextField value={formatDate(record?.completion_date)} />
        </Col>
      </Row>

      <Divider />

      {/* Клиент */}
      <Title level={5}>Клиент</Title>
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Title level={5}>ID клиента</Title>
          <TextField value={record?.client_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Клиент</Title>
          <Space>
            <UserOutlined />
            <TextField value={record?.client_name} style={{ fontSize: 16 }} />
          </Space>
        </Col>
      </Row>

      <Divider />

      {/* Финансы заказа */}
      <Title level={5}>Финансы заказа</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Сумма заказа"
              value={record?.total_amount || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Итого (со скидкой)"
              value={record?.order_effective_final_amount || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Скидка"
              value={record?.discount || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Наценка"
              value={record?.surcharge || 0}
              valueStyle={{ color: '#1890ff' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Аналитика платежей по заказу */}
      <Title level={5}>Аналитика платежей по заказу</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Накоплено до этого"
              value={record?.cumulative_payment_for_order || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Остаток после этого"
              value={record?.order_balance_after_this_payment || 0}
              prefix={record?.order_balance_after_this_payment > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
              valueStyle={{ color: record?.order_balance_after_this_payment > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Всего оплат по заказу"
              value={record?.total_payments_for_order || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Баланс заказа"
              value={record?.order_balance_total || 0}
              prefix={record?.order_balance_total > 0 ? <WarningOutlined /> : <CheckCircleOutlined />}
              valueStyle={{ color: record?.order_balance_total > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
      </Row>

      {record?.paid_amount_mismatch !== 0 && record?.paid_amount_mismatch !== null && (
        <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
          <Col span={24}>
            <Text type="warning">
              <WarningOutlined /> Расхождение paid_amount: {formatNumber(record?.paid_amount_mismatch || 0, 0)}
            </Text>
          </Col>
        </Row>
      )}

      <Divider />

      {/* Статусы */}
      <Title level={5}>Статусы</Title>
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Title level={5}>Статус оплаты</Title>
          <Tag color={getPaymentStatusColor(record?.payment_status_name)}>
            {record?.payment_status_name || "—"}
          </Tag>
        </Col>
        <Col span={6}>
          <Title level={5}>Статус заказа</Title>
          <TextField value={record?.order_status_name || "—"} />
        </Col>
        <Col span={6}>
          <Title level={5}>Статус производства</Title>
          <TextField value={record?.production_status_name || "—"} />
        </Col>
      </Row>

      <Divider />

      {/* Служебная информация */}
      <Title level={5}>Служебная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Title level={5}>Версия</Title>
          <TextField value={record?.version || 1} />
        </Col>
        <Col span={6}>
          <Title level={5}>Создано</Title>
          <DateField value={record?.created_at} format="DD.MM.YYYY HH:mm" />
        </Col>
        <Col span={6}>
          <Title level={5}>Обновлено</Title>
          <DateField value={record?.updated_at} format="DD.MM.YYYY HH:mm" />
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col span={6}>
          <Title level={5}>Ключ 1С (платёж)</Title>
          <TextField value={record?.payment_ref_key_1c || "—"} />
        </Col>
        <Col span={6}>
          <Title level={5}>Ключ 1С (заказ)</Title>
          <TextField value={record?.order_ref_key_1c || "—"} />
        </Col>
        <Col span={6}>
          <Title level={5}>Ключ 1С (клиент)</Title>
          <TextField value={record?.client_ref_key_1c || "—"} />
        </Col>
      </Row>
    </Show>
  );
};
