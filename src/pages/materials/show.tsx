import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge, Row, Col, Divider } from "antd";

const { Title } = Typography;

export const MaterialShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "material_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: typeOne } = useOne({
    resource: "material_types",
    id: record?.material_type_id,
    queryOptions: { enabled: !!record?.material_type_id },
  });
  const { data: vendorOne } = useOne({
    resource: "vendors",
    id: record?.vendor_id,
    queryOptions: { enabled: !!record?.vendor_id },
  });
  const { data: supplierOne } = useOne({
    resource: "suppliers",
    id: record?.default_supplier_id,
    queryOptions: { enabled: !!record?.default_supplier_id },
  });
  const { data: unitOne } = useOne({
    resource: "units",
    id: record?.unit_id,
    queryOptions: { enabled: !!record?.unit_id },
  });

  return (
    <Show isLoading={isLoading} title="Просмотр Материала">
      <Title level={5}>Основная информация</Title>
      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>ID</Title>
          <TextField value={record?.material_id} />
        </Col>
        <Col span={8}>
          <Title level={5}>Материал</Title>
          <TextField value={record?.material_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Единица</Title>
          <TextField value={unitOne?.data?.unit_name} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={8}>
          <Title level={5}>Тип материала</Title>
          <TextField value={typeOne?.data?.material_type_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Производитель</Title>
          <TextField value={vendorOne?.data?.vendor_name} />
        </Col>
        <Col span={8}>
          <Title level={5}>Поставщик</Title>
          <TextField value={supplierOne?.data?.supplier_name} />
        </Col>
      </Row>

      <Divider />

      <Row gutter={[16, 16]}>
        <Col span={24}>
          <Title level={5}>Описание</Title>
          <TextField value={record?.description || "-"} />
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
