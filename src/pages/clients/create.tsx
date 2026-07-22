import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps, useCreate, useNavigation } from "@refinedev/core";
import { Form, Input, Checkbox, notification, Radio } from "antd";
import { ClientPhonesSection } from "./components/ClientPhonesSection";
import { ClientPhone } from "../../types/clients";
import { ReferenceSortOrderFormItem } from "../../components/ReferenceSortOrder";
import { useState } from "react";

export const ClientCreate: React.FC<IResourceComponentsProps> = () => {
  const { list } = useNavigation();
  const [phones, setPhones] = useState<ClientPhone[]>([]);

  const { formProps, saveButtonProps } = useForm({
    resource: "clients",
    action: "create",
    redirect: false,
    successNotification: false,
    onMutationSuccess: async (data) => {
      const clientId = data?.data?.client_id;
      try {
        if (clientId && phones.length > 0) {
          await savePhones(clientId);
        }
        notification.success({
          message: "Клиент создан",
        });
        list("clients");
      } catch (error: any) {
        notification.error({
          message: "Клиент создан, но телефоны не сохранены",
          description:
            error?.message ||
            `Клиент #${clientId} создан. Исправьте телефон и повторите сохранение в карточке клиента.`,
        });
      }
    },
  });

  // Mutation for creating phones
  const { mutateAsync: createPhone } = useCreate();

  // Save phones after client is created
  const savePhones = async (clientId: number) => {
    for (const phone of phones) {
      await createPhone({
        resource: "client_phones",
        values: {
          client_id: clientId,
          phone_number: phone.phone_number,
          phone_type: phone.phone_type,
          is_primary: phone.is_primary,
          ref_key_1c: phone.ref_key_1c ?? null,
        },
        successNotification: false,
      });
    }
  };

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true, person_type: "individual" }}
      >
        <Form.Item
          label="Название клиента"
          name="client_name"
          rules={[
            {
              required: true,
              message: "Введите название клиента",
            },
          ]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          label="Тип лица"
          name="person_type"
          rules={[{ required: true, message: "Выберите тип лица" }]}
        >
          <Radio.Group>
            <Radio value="individual">Физическое лицо</Radio>
            <Radio value="legal">Юридическое лицо</Radio>
          </Radio.Group>
        </Form.Item>
        <Form.Item label="Примечание" name="notes">
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox>Активен</Checkbox>
        </Form.Item>
        <Form.Item label="Ключ 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
        <ReferenceSortOrderFormItem />
      </Form>

      {/* Phones Section */}
      <ClientPhonesSection
        phones={phones}
        onPhonesChange={setPhones}
      />
    </Create>
  );
};
