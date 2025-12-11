import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, ListButton, RefreshButton } from "@refinedev/antd";
import { Typography, Row, Col, Divider, Card, Statistic, Tag, Space } from "antd";
import {
  DollarOutlined,
  CalendarOutlined,
  LinkOutlined,
  WarningOutlined,
  CheckCircleOutlined,
  UserOutlined,
} from "@ant-design/icons";
import { useNavigate, useLocation } from "react-router-dom";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";

const { Title, Text, Link } = Typography;

export const PaymentsAnalyticsShow: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { queryResult } = useShow({
    meta: { idColumnName: "payment_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  // Текущий URL для возврата
  const currentUrl = location.pathname + location.search;

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

  // Переход к заказу
  const handleGoToOrder = () => {
    if (record?.order_id) {
      navigate(`/orders/show/${record.order_id}`, { state: { backUrl: currentUrl } });
    }
  };

  // Переход к клиенту
  const handleGoToClient = () => {
    if (record?.client_id) {
      navigate(`/clients/show/${record.client_id}`, { state: { backUrl: currentUrl } });
    }
  };

  return (
    <Show
      isLoading={isLoading}
      title="Просмотр платежа"
      goBack="К списку"
      headerButtons={
        <>
          <ListButton>Список</ListButton>
          <RefreshButton>Обновить</RefreshButton>
        </>
      }
    >
      <style>{`
        .stat-normal .ant-statistic-content { font-size: 14px; }
        .stat-normal .ant-statistic-content-prefix { font-size: 14px; }
      `}</style>

      {/* Основная информация о платеже */}
      <Title level={5}>Платёж</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="ID платежа"
              value={record?.payment_id}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Сумма"
              value={record?.amount || 0}
              prefix={<DollarOutlined style={{ fontSize: 14 }} />}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Дата платежа"
              value={formatDate(record?.payment_date)}
              prefix={<CalendarOutlined style={{ fontSize: 14 }} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Тип оплаты"
              value={record?.type_paid_name || "—"}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="№ платежа в заказе"
              value={record?.payment_sequence_number || 1}
            />
          </Card>
        </Col>
      </Row>

      {/* Примечание */}
      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={24} sm={12} md={8} lg={6}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Примечание"
              value={record?.notes || "—"}
              formatter={(value) => <span style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</span>}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Информация о заказе */}
      <Title level={5}>Заказ</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="№ заказа"
              value={record?.order_name || record?.order_id}
              formatter={() => (
                <Link onClick={handleGoToOrder} style={{ cursor: 'pointer', fontSize: 14 }}>
                  {record?.order_name || record?.order_id} <LinkOutlined />
                </Link>
              )}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Дата заказа"
              value={formatDate(record?.order_date)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Приоритет"
              value={record?.priority || "—"}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="План. дата"
              value={formatDate(record?.planned_completion_date)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Дата выполнения"
              value={formatDate(record?.completion_date)}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Клиент */}
      <Title level={5}>Клиент</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="ID клиента"
              value={record?.client_id}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Клиент"
              value={record?.client_name || "—"}
              prefix={<UserOutlined style={{ fontSize: 14 }} />}
              formatter={() => (
                <Link onClick={handleGoToClient} style={{ cursor: 'pointer', fontSize: 14 }}>
                  {record?.client_name || "—"} <LinkOutlined />
                </Link>
              )}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Финансы заказа */}
      <Title level={5}>Финансы заказа</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Сумма заказа"
              value={record?.total_amount || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Итого (со скидкой)"
              value={record?.order_effective_final_amount || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Скидка"
              value={record?.discount || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
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
          <Card size="small" className="stat-normal">
            <Statistic
              title="Накоплено до этого"
              value={record?.cumulative_payment_for_order || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Остаток после этого"
              value={record?.order_balance_after_this_payment || 0}
              prefix={record?.order_balance_after_this_payment > 0 ? <WarningOutlined style={{ fontSize: 14 }} /> : <CheckCircleOutlined style={{ fontSize: 14 }} />}
              valueStyle={{ color: record?.order_balance_after_this_payment > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Всего оплат по заказу"
              value={record?.total_payments_for_order || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Баланс заказа"
              value={record?.order_balance_total || 0}
              prefix={record?.order_balance_total > 0 ? <WarningOutlined style={{ fontSize: 14 }} /> : <CheckCircleOutlined style={{ fontSize: 14 }} />}
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
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Статус оплаты"
              value={record?.payment_status_name || "—"}
              formatter={() => (
                <Tag color={getPaymentStatusColor(record?.payment_status_name)}>
                  {record?.payment_status_name || "—"}
                </Tag>
              )}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Статус заказа"
              value={record?.order_status_name || "—"}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Статус производства"
              value={record?.production_status_name || "—"}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Служебная информация */}
      <Text type="secondary" style={{ fontSize: 12 }}>Служебная информация</Text>
      <Row gutter={[8, 4]} style={{ marginTop: 4 }}>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Версия</Text>
          <div style={{ fontSize: 10 }}>{record?.version || 1}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Создано</Text>
          <div style={{ fontSize: 10 }}>{record?.created_at ? dayjs(record.created_at).format("DD.MM.YYYY HH:mm") : "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Обновлено</Text>
          <div style={{ fontSize: 10 }}>{record?.updated_at ? dayjs(record.updated_at).format("DD.MM.YYYY HH:mm") : "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Ключ 1С (платёж)</Text>
          <div style={{ fontSize: 10 }}>{record?.payment_ref_key_1c || "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Ключ 1С (заказ)</Text>
          <div style={{ fontSize: 10 }}>{record?.order_ref_key_1c || "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Ключ 1С (клиент)</Text>
          <div style={{ fontSize: 10 }}>{record?.client_ref_key_1c || "—"}</div>
        </Col>
      </Row>
    </Show>
  );
};
