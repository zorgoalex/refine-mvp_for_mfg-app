import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const FilmShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "film_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: typeOne } = useOne({
    resource: "film_types",
    id: record?.film_type_id,
    queryOptions: { enabled: !!record?.film_type_id },
  });
  const { data: vendorOne } = useOne({
    resource: "vendors",
    id: record?.vendor_id,
    queryOptions: { enabled: !!record?.vendor_id },
  });

  return (
    <Show isLoading={isLoading} title="Просмотр Плёнки">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.film_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Название</Title>
          <TextField value={record?.film_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Фактура</Title>
          <TextField value={String(record?.film_texture)} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Тип плёнки</Title>
          <TextField value={typeOne?.data?.film_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Поставщик плёнки</Title>
          <TextField value={vendorOne?.data?.vendor_name} />
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

