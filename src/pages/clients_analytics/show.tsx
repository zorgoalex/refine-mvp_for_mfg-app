import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider, Card, Statistic, Space } from "antd";
import {
  ShoppingCartOutlined,
  DollarOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  PhoneOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";

const { Title, Text } = Typography;

export const ClientsAnalyticsShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "client_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  return (
    <Show isLoading={isLoading} title="Аналитика клиента">
      {/* Основная информация */}
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Title level={5}>ID</Title>
          <TextField value={record?.client_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Клиент</Title>
          <TextField value={record?.client_name} style={{ fontSize: 18, fontWeight: 500 }} />
        </Col>
        <Col span={6}>
          <Title level={5}>Телефон</Title>
          <Space>
            <PhoneOutlined />
            <TextField value={record?.primary_phone || "—"} />
          </Space>
        </Col>
        <Col span={6}>
          <Title level={5}>Активен</Title>
          <Badge
            status={record?.is_active ? "success" : "default"}
            text={record?.is_active ? "Активен" : "Неактивен"}
          />
        </Col>
      </Row>

      {record?.all_phones && record.all_phones !== record.primary_phone && (
        <Row gutter={[16, 16]} style={{ marginTop: 8 }}>
          <Col span={24}>
            <Text type="secondary">Все телефоны: {record.all_phones}</Text>
          </Col>
        </Row>
      )}

      <Divider />

      {/* Статистика по заказам */}
      <Title level={5}>Статистика по заказам</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Всего заказов"
              value={record?.orders_total_count || 0}
              prefix={<ShoppingCartOutlined />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="В работе"
              value={record?.orders_in_progress_count || 0}
              prefix={<ClockCircleOutlined />}
              valueStyle={{ color: record?.orders_in_progress_count > 0 ? '#1890ff' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Завершено"
              value={record?.orders_completed_count || 0}
              prefix={<CheckCircleOutlined />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Деталей всего"
              value={record?.parts_count_sum || 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Площадь, м²"
              value={record?.total_area_sum || 0}
              precision={2}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Финансовая статистика */}
      <Title level={5}>Финансы</Title>
      <Row gutter={[16, 16]}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Сумма заказов"
              value={record?.total_amount_sum || 0}
              prefix={<DollarOutlined />}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Итого (со скидками)"
              value={record?.final_amount_sum || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Скидки"
              value={record?.discount_sum || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Наценки"
              value={record?.surcharge_sum || 0}
              valueStyle={{ color: '#1890ff' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Оплачено"
              value={record?.paid_amount_sum || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Долг"
              value={record?.debt_sum || 0}
              prefix={record?.has_debt ? <WarningOutlined /> : null}
              valueStyle={{ color: record?.debt_sum > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Платежей"
              value={record?.payments_count || 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small">
            <Statistic
              title="Сумма платежей"
              value={record?.payments_total || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Даты */}
      <Title level={5}>История взаимодействия</Title>
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Title level={5}>Первый заказ</Title>
          <TextField value={formatDate(record?.first_order_date)} />
        </Col>
        <Col span={6}>
          <Title level={5}>Последний заказ</Title>
          <TextField value={formatDate(record?.last_order_date)} />
        </Col>
        <Col span={6}>
          <Title level={5}>Дней с последнего заказа</Title>
          <TextField
            value={record?.days_since_last_order ?? "—"}
            style={{
              color: record?.days_since_last_order > 90 ? '#ff4d4f' :
                     record?.days_since_last_order > 30 ? '#faad14' : undefined
            }}
          />
        </Col>
        <Col span={6}>
          <Title level={5}>Последний платёж</Title>
          <TextField value={formatDate(record?.last_payment_date)} />
        </Col>
      </Row>

      <Divider />

      {/* Последний заказ */}
      {record?.last_order_id && (
        <>
          <Title level={5}>Последний заказ</Title>
          <Row gutter={[16, 16]}>
            <Col span={4}>
              <Title level={5}>№ заказа</Title>
              <TextField value={record?.last_order_name || record?.last_order_id} />
            </Col>
            <Col span={4}>
              <Title level={5}>Дата</Title>
              <TextField value={formatDate(record?.last_order_date_exact)} />
            </Col>
            <Col span={4}>
              <Title level={5}>Статус заказа</Title>
              <TextField value={record?.last_order_status_name || "—"} />
            </Col>
            <Col span={4}>
              <Title level={5}>Статус оплаты</Title>
              <TextField value={record?.last_payment_status_name || "—"} />
            </Col>
            <Col span={4}>
              <Title level={5}>Сумма</Title>
              <TextField value={formatNumber(record?.last_order_final_amount || record?.last_order_total_amount || 0, 0)} />
            </Col>
            <Col span={4}>
              <Title level={5}>Оплачено</Title>
              <TextField value={formatNumber(record?.last_order_paid_amount || 0, 0)} />
            </Col>
          </Row>
          <Divider />
        </>
      )}

      {/* Примечание */}
      {record?.notes && (
        <>
          <Row gutter={[16, 16]}>
            <Col span={24}>
              <Title level={5}>Примечание</Title>
              <TextField value={record.notes} />
            </Col>
          </Row>
          <Divider />
        </>
      )}

      {/* Аудит */}
      <Title level={5}>Служебная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={6}>
          <Title level={5}>Ключ 1С</Title>
          <TextField value={record?.ref_key_1c || "—"} />
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
    </Show>
  );
};
