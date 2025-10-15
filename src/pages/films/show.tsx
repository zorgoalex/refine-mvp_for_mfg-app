import { useShow, IResourceComponentsProps, useOne } from "@refinedev/core";
import { Show, TextField } from "@refinedev/antd";
import { Typography } from "antd";

const { Title } = Typography;

export const FilmShow: React.FC<IResourceComponentsProps> = () => {
  const { queryResult } = useShow({
    meta: { idColumnName: "film_id" },
  });
  const { data, isLoading } = queryResult;

  const record = data?.data;
  const { data: typeOne } = useOne({ resource: "film_types", id: record?.film_type_id, queryOptions: { enabled: !!record?.film_type_id } });
  const { data: vendorOne } = useOne({ resource: "film_vendors", id: record?.film_vendor_id, queryOptions: { enabled: !!record?.film_vendor_id } });

  return (
    <Show isLoading={isLoading}>
      <Title level={5}>Film ID</Title>
      <TextField value={record?.film_id} />
      <Title level={5}>Name</Title>
      <TextField value={record?.film_name} />
      <Title level={5}>Film Type</Title>
      <TextField value={typeOne?.data?.film_type_name} />
      <Title level={5}>Film Vendor</Title>
      <TextField value={vendorOne?.data?.film_vendor_name} />
      <Title level={5}>Texture</Title>
      <TextField value={String(record?.film_texture)} />
      <Title level={5}>Ref Key 1C</Title>
      <TextField value={record?.ref_key_1c} />
    </Show>
  );
};
