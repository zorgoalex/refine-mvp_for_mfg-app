import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const TransactionDirectionShow: React.FC<
  IResourceComponentsProps
> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "direction_type_id" },
  });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading} title="Просмотр направления движения">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.direction_type_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Код направления</Title>
          <TextField value={record?.direction_code} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название направления</Title>
          <TextField value={record?.direction_name} />
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

