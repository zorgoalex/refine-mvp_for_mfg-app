import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, DateField } from "@refinedev/antd";
import { Col, Descriptions, Row, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { formatNumber } from "../../utils/numberFormat";
import { DISPLAY_DATE_TIME_SECONDS_FORMAT } from "../../utils/dateFormat";
import { useCurrentRecordTabTitle } from "../../utils/recordTitle";

const { Text } = Typography;

export const DowelOrderShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "doweling_order_id" },
  });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  useCurrentRecordTabTitle(record);

  const formatDate = (date: string | null) => {
    if (!date) return "—";
    return dayjs(date).format("DD.MM.YYYY");
  };

  const getPaymentStatusColor = (status?: string) => {
    if (status === "Не оплачен") return "red";
    if (status === "Частично оплачен") return "orange";
    if (status === "Оплачен") return "green";
    return "default";
  };

  const getProductionStatusColor = (status?: string) => {
    if (!status) return "default";
    if (status.toLowerCase().includes("готов") || status.toLowerCase().includes("завершен")) return "green";
    if (status.toLowerCase().includes("процесс") || status.toLowerCase().includes("работ")) return "blue";
    return "default";
  };

  const fileLink = (href?: string | null) =>
    href ? (
      <a href={href} target="_blank" rel="noopener noreferrer">
        {href}
      </a>
    ) : (
      <Text type="secondary">—</Text>
    );

  // Two side-by-side columns of compact Descriptions so the whole card fits without vertical scroll.
  const descProps = { column: 1 as const, size: "small" as const, bordered: true };

  return (
    <Show isLoading={isLoading} title="Просмотр присадки">
      {record && (
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}>
            <Descriptions title="Основная информация" {...descProps}>
              <Descriptions.Item label="ID">{record.doweling_order_id}</Descriptions.Item>
              <Descriptions.Item label="Присадка">{record.doweling_order_name || "—"}</Descriptions.Item>
              <Descriptions.Item label="Заказ">{record.order_name || "—"}</Descriptions.Item>
              <Descriptions.Item label="Клиент">{record.client_name || "—"}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Даты" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="Дата заказа">{formatDate(record.doweling_order_date)}</Descriptions.Item>
              <Descriptions.Item label="Дата выдачи">{formatDate(record.issue_date)}</Descriptions.Item>
              <Descriptions.Item label="Дата оплаты">{formatDate(record.payment_date)}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Производство" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="Материал">{record.material_name || "—"}</Descriptions.Item>
              <Descriptions.Item label="Фрезеровка">{record.milling_type_name || "—"}</Descriptions.Item>
              <Descriptions.Item label="Обкат">{record.edge_type_name || "—"}</Descriptions.Item>
              <Descriptions.Item label="Кол-во деталей">{record.parts_count ?? "—"}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Статусы и ответственные" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="Статус оплаты">
                <Tag color={getPaymentStatusColor(record.payment_status_name)}>
                  {record.payment_status_name || "—"}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Статус производства">
                <Tag color={getProductionStatusColor(record.production_status_name)}>
                  {record.production_status_name || "—"}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Конструктор">{record.design_engineer || "—"}</Descriptions.Item>
              <Descriptions.Item label="Оператор">{record.operator || "—"}</Descriptions.Item>
            </Descriptions>
          </Col>

          <Col xs={24} lg={12}>
            <Descriptions title="Финансы" {...descProps}>
              <Descriptions.Item label="Сумма">{formatNumber(record.total_amount, 0)} ₽</Descriptions.Item>
              <Descriptions.Item label="Скидка">{formatNumber(record.discount, 0)} ₽</Descriptions.Item>
              <Descriptions.Item label="Итого со скидкой">
                <Text strong>{formatNumber(record.final_amount, 0)} ₽</Text>
              </Descriptions.Item>
              <Descriptions.Item label="Оплачено">{formatNumber(record.paid_amount, 0)} ₽</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Файлы" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="CAD-файл">{fileLink(record.link_cad_file)}</Descriptions.Item>
              <Descriptions.Item label="PDF-файл">{fileLink(record.link_pdf_file)}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Служебная информация" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="Версия">{record.version ?? "—"}</Descriptions.Item>
              <Descriptions.Item label="1C-key заказа">{record.order_ref_key_1c || "—"}</Descriptions.Item>
              <Descriptions.Item label="1C-key клиента">{record.client_ref_key_1c || "—"}</Descriptions.Item>
            </Descriptions>

            <Descriptions title="Создание и изменение" {...descProps} style={{ marginTop: 16 }}>
              <Descriptions.Item label="Создан">{record.created_by || "—"}</Descriptions.Item>
              <Descriptions.Item label="Изменён">{record.edited_by || "—"}</Descriptions.Item>
              <Descriptions.Item label="Создано">
                <DateField value={record.created_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
              </Descriptions.Item>
              <Descriptions.Item label="Обновлено">
                <DateField value={record.updated_at} format={DISPLAY_DATE_TIME_SECONDS_FORMAT} />
              </Descriptions.Item>
            </Descriptions>
          </Col>
        </Row>
      )}
    </Show>
  );
};
