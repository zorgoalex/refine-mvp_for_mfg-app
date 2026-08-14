import { Edit } from "@refinedev/antd";
import { IResourceComponentsProps } from "@refinedev/core";
import { Form, Input, InputNumber, Checkbox, Card } from "antd";
import { useParams } from "react-router-dom";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { MillingExtraResourcesEditor } from "./MillingExtraResourcesEditor";

export const MillingTypeEdit: React.FC<IResourceComponentsProps> = () => {
  const { id } = useParams();
  const millingTypeId = Number(id);
  const { formProps, saveButtonProps } = useFormWithHighlight({
    resource: "milling_types",
    idField: "milling_type_id",
    action: "edit",
  });

  return (
    <Edit saveButtonProps={saveButtonProps}>
      <Form {...formProps} layout="vertical">
        <Form.Item
          label="Name"
          name="milling_type_name"
          rules={[
            {
              required: true,
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item label="Cost per sqm" name="cost_per_sqm">
          <InputNumber min={0} step={0.01} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Порядок сортировки" name="sort_order" rules={[{ required: true }]}>
          <InputNumber min={1} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item label="Description" name="description">
          <Input.TextArea rows={3} />
        </Form.Item>
        <Form.Item label="Active" name="is_active" valuePropName="checked">
          <Checkbox />
        </Form.Item>
        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
      {Number.isInteger(millingTypeId) && millingTypeId > 0 ? (
        <Card size="small" title="Доп. ресурсы" style={{ marginTop: 16 }}>
          <MillingExtraResourcesEditor millingTypeId={millingTypeId} showMillingColumn={false} />
        </Card>
      ) : null}
    </Edit>
  );
};
