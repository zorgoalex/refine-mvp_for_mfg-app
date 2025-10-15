import { useShow, IResourceComponentsProps } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const FilmShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "film_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Film ID</Title>
      <TextField value={record?.film_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.film_name} />
      <Title level={5}>Film Type ID</Title>
      <TextField value={record?.film_type_id} />
      <Title level={5}>Film Vendor ID</Title>
      <TextField value={record?.film_vendor_id} />
      <Title level={5}>Texture</Title>
      <TextField value={String(record?.film_texture)} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
