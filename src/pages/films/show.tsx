import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const FilmShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "film_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: typeOne } = useOne({ resource: "film_types", id: record?.film_type_id, queryOptions: { enabled: !!record?.film_type_id } });
  const { data: vendorOne } = useOne({ resource: "vendors", id: record?.vendor_id, queryOptions: { enabled: !!record?.vendor_id } });

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Film ID</Title>
      <TextField value={record?.film_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.film_name} />
      <Title level={5}>Film Type</Title>
      <TextField value={typeOne?.data?.film_type_name} />
      <Title level={5}>Производитель</Title>
      <TextField value={vendorOne?.data?.vendor_name} />
      <Title level={5}>Texture</Title>
      <TextField value={String(record?.film_texture)} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Активен</Title>
      <Badge status={record?.is_active ? "success" : "default"} text={record?.is_active ? "Активен" : "Неактивен"} />
      <Title level={5}>Создано</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Создано пользователем</Title>
      <TextField value={record?.created_by || "-"} />
      <Title level={5}>Обновлено</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Обновлено пользователем</Title>
      <TextField value={record?.edited_by || "-"} />
    </Show>
  );
};

