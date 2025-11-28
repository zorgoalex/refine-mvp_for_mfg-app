import { Create, useForm } from "@refinedev/antd";
import { IResourceComponentsProps, useCreate, useNavigation } from "@refinedev/core";
import { Form, Input, Checkbox, notification } from "antd";
import { ClientPhonesSection } from "./components/ClientPhonesSection";
import { ClientPhone } from "../../types/clients";
import { useState } from "react";

export const ClientCreate: React.FC<IResourceComponentsProps> = () => {
  const { list } = useNavigation();
  const [phones, setPhones] = useState<ClientPhone[]>([]);

  const { formProps, saveButtonProps, form } = useForm({
    resource: "clients",
    action: "create",
    redirect: false,
    onMutationSuccess: async (data) => {
      const clientId = data?.data?.client_id;
      if (clientId && phones.length > 0) {
        // Save phones after client is created
        await savePhones(clientId);
      }
      // Navigate to list
      list("clients");
    },
  });

  // Mutation for creating phones
  const { mutateAsync: createPhone } = useCreate();

  // Save phones after client is created
  const savePhones = async (clientId: number) => {
    try {
      for (const phone of phones) {
        await createPhone({
          resource: "client_phones",
          values: {
            client_id: clientId,
            phone_number: phone.phone_number,
            phone_type: phone.phone_type,
            is_primary: phone.is_primary,
          },
        });
      }
    } catch (error: any) {
      notification.error({
        message: "Ошибка сохранения телефонов",
        description: error?.message || "Неизвестная ошибка",
      });
    }
  };

  return (
    <Create saveButtonProps={saveButtonProps}>
      <Form
        {...formProps}
        layout="vertical"
        initialValues={{ is_active: true }}
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
        <Form.Item label="Примечание" name="notes">
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Checkbox>Активен</Checkbox>
        </Form.Item>
        <Form.Item label="Ключ 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>

      {/* Phones Section */}
      <ClientPhonesSection
        phones={phones}
        onPhonesChange={setPhones}
      />
    </Create>
  );
};

