import { Edit } from "@refinedev/antd";
import {
  IResourceComponentsProps,
  useList,
  useCreate,
  useUpdate,
  useDelete,
} from "@refinedev/core";
import { Form, Input, Checkbox, notification, Spin } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { ClientPhonesSection } from "./components/ClientPhonesSection";
import { ClientPhone } from "../../types/clients";
import { useState, useEffect, useCallback } from "react";

export const ClientEdit: React.FC<IResourceComponentsProps> = () => {
  const { formProps, saveButtonProps, id } = useFormWithHighlight({
    resource: "clients",
    idField: "client_id",
    action: "edit",
  });

  const [phones, setPhones] = useState<ClientPhone[]>([]);
  const [deletedPhones, setDeletedPhones] = useState<number[]>([]);
  const [phonesLoaded, setPhonesLoaded] = useState(false);

  // Fetch client phones
  const { data: phonesData, isLoading: phonesLoading, refetch: refetchPhones } = useList<ClientPhone>({
    resource: "client_phones",
    filters: [
      {
        field: "client_id",
        operator: "eq",
        value: id,
      },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!id,
    },
  });

  // Load phones when data is fetched
  useEffect(() => {
    if (phonesData?.data && !phonesLoaded) {
      setPhones(
        phonesData.data.map((p) => ({
          ...p,
          temp_id: p.phone_id || Date.now() + Math.random(),
        }))
      );
      setPhonesLoaded(true);
    }
  }, [phonesData, phonesLoaded]);

  // Mutations for phones
  const { mutateAsync: createPhone } = useCreate();
  const { mutateAsync: updatePhone } = useUpdate();
  const { mutateAsync: deletePhone } = useDelete();

  // Save phones (called after main form save)
  const savePhones = useCallback(async (clientId: number) => {
    try {
      // Delete removed phones
      for (const phoneId of deletedPhones) {
        await deletePhone({
          resource: "client_phones",
          id: phoneId,
          meta: { idColumnName: "phone_id" },
        });
      }

      // Create or update phones
      for (const phone of phones) {
        const phonePayload = {
          client_id: clientId,
          phone_number: phone.phone_number,
          phone_type: phone.phone_type,
          is_primary: phone.is_primary,
        };

        if (phone.phone_id) {
          // Update existing
          await updatePhone({
            resource: "client_phones",
            id: phone.phone_id,
            values: phonePayload,
            meta: { idColumnName: "phone_id" },
          });
        } else {
          // Create new
          await createPhone({
            resource: "client_phones",
            values: phonePayload,
          });
        }
      }

      // Reset deleted list
      setDeletedPhones([]);

      // Refetch phones
      refetchPhones();
    } catch (error: any) {
      notification.error({
        message: "Ошибка сохранения телефонов",
        description: error?.message || "Неизвестная ошибка",
      });
    }
  }, [phones, deletedPhones, createPhone, updatePhone, deletePhone, refetchPhones]);

  // Override save button to save phones too
  const handleSave = async () => {
    if (saveButtonProps.onClick) {
      // Wait for form save
      await (saveButtonProps.onClick as any)();
    }
    // Save phones after client is saved
    if (id) {
      await savePhones(Number(id));
    }
  };

  return (
    <Edit
      saveButtonProps={{
        ...saveButtonProps,
        onClick: handleSave,
      }}
    >
      <Form {...formProps} layout="vertical">
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
      {phonesLoading ? (
        <Spin style={{ display: "block", marginTop: 16 }} />
      ) : (
        <ClientPhonesSection
          phones={phones}
          onPhonesChange={setPhones}
          onDeletedPhonesChange={setDeletedPhones}
          deletedPhones={deletedPhones}
        />
      )}
    </Edit>
  );
};

