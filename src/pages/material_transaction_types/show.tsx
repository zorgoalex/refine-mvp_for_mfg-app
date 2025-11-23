import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Tag, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const MaterialTransactionTypeShow: React.FC<
  IResourceComponentsProps
> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "transaction_type_id" },
  });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading} title="Просмотр Типа операции с материалами">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.transaction_type_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Тип операции</Title>
          <TextField value={record?.transaction_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Направление движения</Title>
          <TextField value={record?.direction?.direction_name || "-"} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Влияет на склад</Title>
          <Tag color={record?.affects_stock ? "green" : "default"}>
            {record?.affects_stock ? "Да" : "Нет"}
          </Tag>
        </Col>
        <Col span={8}>
          <Title level={5}>Требует документа</Title>
          <Tag color={record?.requires_document ? "blue" : "default"}>
            {record?.requires_document ? "Да" : "Нет"}
          </Tag>
        </Col>
        <Col span={8}>
          <Title level={5}>Сортировка по умолчанию</Title>
          <TextField value={record?.sort_order} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Title level={5}>Описание</Title>
          <TextField value={record?.description} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Активен</Title>
          <Badge
            status={record?.is_active ? "success" : "default"}
            text={record?.is_active ? "Активен" : "Неактивен"}
          />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Создано</Title>
          <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
        </Col>
        <Col span={8}>
          <Title level={5}>Обновлено</Title>
          <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
        </Col>
      </Row>
    </Show>
  );
};

