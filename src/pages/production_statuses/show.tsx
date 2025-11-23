import { IResourceComponentsProps, useShow } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const ProductionStatusShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "production_status_id" },
  });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading} title="Просмотр Статуса производства">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.production_status_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Статус производства</Title>
          <TextField value={record?.production_status_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Сортировка по умолчанию</Title>
          <TextField value={record?.sort_order} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Цвет статуса</Title>
          <TextField value={record?.color} />
        </Col>
        <Col span={8}>
          <Title level={5}>1C-key</Title>
          <TextField value={record?.ref_key_1c} />
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

