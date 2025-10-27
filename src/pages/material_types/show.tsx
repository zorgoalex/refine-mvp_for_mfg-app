import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField, DateField } from "@refinedev/antd";
import { Typography, Badge } from "antd";

const { Title } = Typography;

export const MaterialTypeShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({ meta: { idColumnName: "material_type_id" } });
  const { data, isLoading } = queryResult;
  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Material Type ID</Title>
      <TextField value={record?.material_type_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.material_type_name} />
      <Title level={5}>Description</Title>
      <TextField value={record?.description} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
      <Title level={5}>Активен</Title>
      <Badge
        status={record?.is_active ? "success" : "default"}
        text={record?.is_active ? "Активен" : "Неактивен"}
      />
      <Title level={5}>Создан</Title>
      <TextField value={record?.created_by || "-"} />
      <Title level={5}>Изменён</Title>
      <TextField value={record?.edited_by || "-"} />
      <Title level={5}>Создано</Title>
      <DateField value={record?.created_at} format="YYYY-MM-DD HH:mm:ss" />
      <Title level={5}>Обновлено</Title>
      <DateField value={record?.updated_at} format="YYYY-MM-DD HH:mm:ss" />
    </Show>
  );
};
