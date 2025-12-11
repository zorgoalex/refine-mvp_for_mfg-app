import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField, ListButton, RefreshButton } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider, Card, Statistic, Space, Button } from "antd";
import {
  ShoppingCartOutlined,
  DollarOutlined,
  ClockCircleOutlined,
  CheckCircleOutlined,
  WarningOutlined,
  PhoneOutlined,
  LinkOutlined,
} from "@ant-design/icons";
import { useNavigate, useLocation } from "react-router-dom";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";

const { Title, Text, Link } = Typography;

export const ClientsAnalyticsShow: React.FC<IResourceComponentsProps> = () => {
  const navigate = useNavigate();
  const location = useLocation();
  const { queryResult } = useShow({
    meta: { idColumnName: "client_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  // Текущий URL для возврата
  const currentUrl = location.pathname + location.search;

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  // Переход к клиенту
  const handleGoToClient = () => {
    if (record?.client_id) {
      navigate(`/clients/show/${record.client_id}`, { state: { backUrl: currentUrl } });
    }
  };

  // Переход к последнему заказу
  const handleGoToLastOrder = () => {
    if (record?.last_order_id) {
      navigate(`/orders/show/${record.last_order_id}`, { state: { backUrl: currentUrl } });
    }
  };

  return (
    <Show
      isLoading={isLoading}
      title="Аналитика клиента"
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
      {/* Основная информация */}
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={4}>
          <Title level={5}>ID</Title>
          <TextField value={record?.client_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Клиент</Title>
          <Link
            onClick={handleGoToClient}
            style={{ fontSize: 18, fontWeight: 500, cursor: 'pointer' }}
          >
            {record?.client_name} <LinkOutlined />
          </Link>
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
          <Card size="small" className="stat-normal">
            <Statistic
              title="Всего заказов"
              value={record?.orders_total_count || 0}
              prefix={<ShoppingCartOutlined style={{ fontSize: 14 }} />}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="В работе"
              value={record?.orders_in_progress_count || 0}
              prefix={<ClockCircleOutlined style={{ fontSize: 14 }} />}
              valueStyle={{ color: record?.orders_in_progress_count > 0 ? '#1890ff' : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Завершено"
              value={record?.orders_completed_count || 0}
              prefix={<CheckCircleOutlined style={{ fontSize: 14 }} />}
              valueStyle={{ color: '#52c41a' }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Деталей всего"
              value={record?.parts_count_sum || 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
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
          <Card size="small" className="stat-normal">
            <Statistic
              title="Сумма заказов"
              value={record?.total_amount_sum || 0}
              prefix={<DollarOutlined style={{ fontSize: 14 }} />}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Итого (со скидками)"
              value={record?.final_amount_sum || 0}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Скидки"
              value={record?.discount_sum || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Наценки"
              value={record?.surcharge_sum || 0}
              valueStyle={{ color: '#1890ff' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Оплачено"
              value={record?.paid_amount_sum || 0}
              valueStyle={{ color: '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Долг"
              value={record?.debt_sum || 0}
              prefix={record?.has_debt ? <WarningOutlined style={{ fontSize: 14 }} /> : null}
              valueStyle={{ color: record?.debt_sum > 0 ? '#ff4d4f' : '#52c41a' }}
              formatter={(value) => formatNumber(value as number, 0)}
            />
          </Card>
        </Col>
      </Row>

      <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Платежей"
              value={record?.payments_count || 0}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
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
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Первый заказ"
              value={formatDate(record?.first_order_date)}
              formatter={(value) => value}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Последний заказ"
              value={formatDate(record?.last_order_date)}
              formatter={(value) => value}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Дней с последнего заказа"
              value={record?.days_since_last_order ?? "—"}
              valueStyle={{
                color: record?.days_since_last_order > 90 ? '#ff4d4f' :
                       record?.days_since_last_order > 30 ? '#faad14' : undefined
              }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={6} lg={4}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Последний платёж"
              value={formatDate(record?.last_payment_date)}
              formatter={(value) => value}
            />
          </Card>
        </Col>
      </Row>

      <Divider />

      {/* Последний заказ */}
      {record?.last_order_id && (
        <>
          <Title level={5}>Последний заказ</Title>
          <Row gutter={[16, 16]}>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="№ заказа"
                  value={record?.last_order_name || record?.last_order_id}
                  formatter={() => (
                    <Link onClick={handleGoToLastOrder} style={{ cursor: 'pointer', fontSize: 14 }}>
                      {record?.last_order_name || record?.last_order_id} <LinkOutlined />
                    </Link>
                  )}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="Дата"
                  value={formatDate(record?.last_order_date_exact)}
                  formatter={(value) => value}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="Статус заказа"
                  value={record?.last_order_status_name || "—"}
                  formatter={(value) => value}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="Статус оплаты"
                  value={record?.last_payment_status_name || "—"}
                  formatter={(value) => value}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="Сумма"
                  value={record?.last_order_final_amount || record?.last_order_total_amount || 0}
                  formatter={(value) => formatNumber(value as number, 0)}
                />
              </Card>
            </Col>
            <Col xs={12} sm={8} md={6} lg={4}>
              <Card size="small" className="stat-normal">
                <Statistic
                  title="Оплачено"
                  value={record?.last_order_paid_amount || 0}
                  formatter={(value) => formatNumber(value as number, 0)}
                />
              </Card>
            </Col>
          </Row>
          <Divider />
        </>
      )}

      {/* Примечание */}
      <Title level={5}>Примечание</Title>
      <Row gutter={[16, 16]}>
        <Col xs={24} sm={12} md={8} lg={6}>
          <Card size="small" className="stat-normal">
            <Statistic
              title="Заметка"
              value={record?.notes || "—"}
              formatter={(value) => <span style={{ fontSize: 14, whiteSpace: 'pre-wrap' }}>{value}</span>}
            />
          </Card>
        </Col>
      </Row>
      <Divider />

      {/* Аудит */}
      <Text type="secondary" style={{ fontSize: 12 }}>Служебная информация</Text>
      <Row gutter={[8, 4]} style={{ marginTop: 4 }}>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Ключ 1С</Text>
          <div style={{ fontSize: 10 }}>{record?.ref_key_1c || "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Создано</Text>
          <div style={{ fontSize: 10 }}>{record?.created_at ? dayjs(record.created_at).format("DD.MM.YYYY HH:mm") : "—"}</div>
        </Col>
        <Col span={4}>
          <Text type="secondary" style={{ fontSize: 10 }}>Обновлено</Text>
          <div style={{ fontSize: 10 }}>{record?.updated_at ? dayjs(record.updated_at).format("DD.MM.YYYY HH:mm") : "—"}</div>
        </Col>
      </Row>
    </Show>
  );
};
