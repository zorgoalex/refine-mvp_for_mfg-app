import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Row, Col, Divider, Tag } from "antd";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";

const { Title, Text } = Typography;

export const DowelOrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "doweling_order_id" },
  });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  const getPaymentStatusColor = (status?: string) => {
    if (status === 'Не оплачен') return 'red';
    if (status === 'Частично оплачен') return 'orange';
    if (status === 'Оплачен') return 'green';
    return 'default';
  };

  const getProductionStatusColor = (status?: string) => {
    if (!status) return 'default';
    if (status.toLowerCase().includes('готов') || status.toLowerCase().includes('завершен')) return 'green';
    if (status.toLowerCase().includes('процесс') || status.toLowerCase().includes('работ')) return 'blue';
    return 'default';
  };

  return (
    <Show isLoading={isLoading} title="Просмотр присадки">
      {record && (
        <>
          <Title level={5}>Основная информация</Title>
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>ID</Title>
              <TextField value={record.doweling_order_id} />
            </Col>
            <Col span={6}>
              <Title level={5}>Присадка</Title>
              <TextField value={record.doweling_order_name} />
            </Col>
            <Col span={6}>
              <Title level={5}>Заказ</Title>
              <TextField value={record.order_name} />
            </Col>
            <Col span={6}>
              <Title level={5}>Клиент</Title>
              <TextField value={record.client_name} />
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Даты</Title>
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>Дата заказа</Title>
              <Text>{formatDate(record.doweling_order_date)}</Text>
            </Col>
            <Col span={6}>
              <Title level={5}>Дата выдачи</Title>
              <Text>{formatDate(record.issue_date)}</Text>
            </Col>
            <Col span={6}>
              <Title level={5}>Дата оплаты</Title>
              <Text>{formatDate(record.payment_date)}</Text>
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Производство</Title>
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>Материал</Title>
              <TextField value={record.material_name || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>Фрезеровка</Title>
              <TextField value={record.milling_type_name || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>Обкат</Title>
              <TextField value={record.edge_type_name || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>Кол-во деталей</Title>
              <TextField value={record.parts_count || "—"} />
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Статусы</Title>
          <Row gutter={[16, 16]}>
            <Col span={8}>
              <Title level={5}>Статус оплаты</Title>
              <Tag color={getPaymentStatusColor(record.payment_status_name)}>
                {record.payment_status_name || "—"}
              </Tag>
            </Col>
            <Col span={8}>
              <Title level={5}>Статус производства</Title>
              <Tag color={getProductionStatusColor(record.production_status_name)}>
                {record.production_status_name || "—"}
              </Tag>
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Финансы</Title>
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>Сумма</Title>
              <Text>{formatNumber(record.total_amount, 0)} ₽</Text>
            </Col>
            <Col span={6}>
              <Title level={5}>Скидка</Title>
              <Text>{formatNumber(record.discount, 0)} ₽</Text>
            </Col>
            <Col span={6}>
              <Title level={5}>Итого со скидкой</Title>
              <Text strong>{formatNumber(record.discounted_amount, 0)} ₽</Text>
            </Col>
            <Col span={6}>
              <Title level={5}>Оплачено</Title>
              <Text>{formatNumber(record.paid_amount, 0)} ₽</Text>
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Файлы</Title>
          <Row gutter={[16, 16]}>
            <Col span={12}>
              <Title level={5}>Ссылка на CAD-файл</Title>
              {record.link_cad_file ? (
                <a href={record.link_cad_file} target="_blank" rel="noopener noreferrer">
                  {record.link_cad_file}
                </a>
              ) : (
                <Text type="secondary">—</Text>
              )}
            </Col>
            <Col span={12}>
              <Title level={5}>Ссылка на PDF-файл</Title>
              {record.link_pdf_file ? (
                <a href={record.link_pdf_file} target="_blank" rel="noopener noreferrer">
                  {record.link_pdf_file}
                </a>
              ) : (
                <Text type="secondary">—</Text>
              )}
            </Col>
          </Row>

          <Divider />

          <Title level={5}>Служебная информация</Title>
          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>Версия</Title>
              <TextField value={record.version || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>1C-key заказа</Title>
              <TextField value={record.order_ref_key_1c || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>1C-key клиента</Title>
              <TextField value={record.client_ref_key_1c || "—"} />
            </Col>
          </Row>

          <Divider />

          <Row gutter={[16, 16]}>
            <Col span={6}>
              <Title level={5}>Создан</Title>
              <TextField value={record.created_by || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>Изменён</Title>
              <TextField value={record.edited_by || "—"} />
            </Col>
            <Col span={6}>
              <Title level={5}>Создано</Title>
              <DateField value={record.created_at} format="YYYY-MM-DD HH:mm:ss" />
            </Col>
            <Col span={6}>
              <Title level={5}>Обновлено</Title>
              <DateField value={record.updated_at} format="YYYY-MM-DD HH:mm:ss" />
            </Col>
          </Row>
        </>
      )}
    </Show>
  );
};
