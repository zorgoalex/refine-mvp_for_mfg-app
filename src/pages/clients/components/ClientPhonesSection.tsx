// Client Phones Section
// Component for managing client phone numbers with CRUD operations

import React, { useState } from "react";
import {
  Card,
  Table,
  Button,
  Space,
  Input,
  Checkbox,
  Modal,
  message,
  Typography,
  Tag,
  Form,
  Select,
} from "antd";
import {
  PlusOutlined,
  DeleteOutlined,
  EditOutlined,
  PhoneOutlined,
  StarFilled,
} from "@ant-design/icons";
import { ClientPhone, PhoneType, PHONE_TYPE_LABELS } from "../../../types/clients";
import { DraggableModalWrapper } from "../../../components/DraggableModalWrapper";

const { Text } = Typography;

const PHONE_TYPE_OPTIONS = Object.entries(PHONE_TYPE_LABELS).map(([value, label]) => ({
  value,
  label,
}));

interface ClientPhonesSectionProps {
  phones: ClientPhone[];
  onPhonesChange: (phones: ClientPhone[]) => void;
  onDeletedPhonesChange?: (deletedIds: number[]) => void;
  deletedPhones?: number[];
  disabled?: boolean;
}

export const ClientPhonesSection: React.FC<ClientPhonesSectionProps> = ({
  phones,
  onPhonesChange,
  onDeletedPhonesChange,
  deletedPhones = [],
  disabled = false,
}) => {
  const [modalOpen, setModalOpen] = useState(false);
  const [editingPhone, setEditingPhone] = useState<ClientPhone | null>(null);
  const [form] = Form.useForm();

  // Generate temp_id for new phones
  const generateTempId = () => Date.now() + Math.random();

  // Handle add new phone
  const handleAdd = () => {
    setEditingPhone(null);
    form.resetFields();
    form.setFieldsValue({ is_primary: false, phone_type: 'mobile' });
    setModalOpen(true);
  };

  // Handle edit phone
  const handleEdit = (phone: ClientPhone) => {
    setEditingPhone(phone);
    form.setFieldsValue({
      phone_number: phone.phone_number,
      phone_type: phone.phone_type,
      is_primary: phone.is_primary,
    });
    setModalOpen(true);
  };

  // Handle delete phone
  const handleDelete = (phone: ClientPhone) => {
    Modal.confirm({
      title: "Удалить телефон?",
      content: `Телефон "${phone.phone_number}" будет удалён.`,
      okText: "Удалить",
      okType: "danger",
      cancelText: "Отмена",
      modalRender: (modal) => (
        <DraggableModalWrapper>{modal}</DraggableModalWrapper>
      ),
      onOk() {
        // Remove from list
        const newPhones = phones.filter((p) => {
          if (phone.phone_id) {
            return p.phone_id !== phone.phone_id;
          }
          return p.temp_id !== phone.temp_id;
        });
        onPhonesChange(newPhones);

        // Track deleted phone if it has a server ID
        if (phone.phone_id && onDeletedPhonesChange) {
          onDeletedPhonesChange([...deletedPhones, phone.phone_id]);
        }

        message.success("Телефон удалён");
      },
    });
  };

  // Handle save phone (create or update)
  const handleSave = async () => {
    try {
      const values = await form.validateFields();
      const phoneData: Partial<ClientPhone> = {
        phone_number: values.phone_number.trim(),
        phone_type: values.phone_type || 'mobile',
        is_primary: values.is_primary || false,
      };

      let newPhones: ClientPhone[];

      if (editingPhone) {
        // Update existing
        newPhones = phones.map((p) => {
          const isMatch = editingPhone.phone_id
            ? p.phone_id === editingPhone.phone_id
            : p.temp_id === editingPhone.temp_id;
          if (isMatch) {
            return { ...p, ...phoneData };
          }
          return p;
        });
        message.success("Телефон обновлён");
      } else {
        // Create new
        const newPhone: ClientPhone = {
          ...phoneData,
          temp_id: generateTempId(),
        } as ClientPhone;
        newPhones = [...phones, newPhone];
        message.success("Телефон добавлен");
      }

      // If setting as primary, unset other primaries
      if (phoneData.is_primary) {
        newPhones = newPhones.map((p) => {
          const isCurrentPhone = editingPhone
            ? editingPhone.phone_id
              ? p.phone_id === editingPhone.phone_id
              : p.temp_id === editingPhone.temp_id
            : p.temp_id === newPhones[newPhones.length - 1].temp_id;

          return {
            ...p,
            is_primary: isCurrentPhone,
          };
        });
      }

      onPhonesChange(newPhones);
      setModalOpen(false);
      form.resetFields();
      setEditingPhone(null);
    } catch (error) {
      // Validation error
    }
  };

  const handleCancel = () => {
    setModalOpen(false);
    form.resetFields();
    setEditingPhone(null);
  };

  const columns = [
    {
      title: "Телефон",
      dataIndex: "phone_number",
      key: "phone_number",
      render: (value: string, record: ClientPhone) => (
        <Space>
          <PhoneOutlined />
          <Text>{value}</Text>
          {record.is_primary && (
            <Tag color="gold" icon={<StarFilled />}>
              Основной
            </Tag>
          )}
        </Space>
      ),
    },
    {
      title: "Тип",
      dataIndex: "phone_type",
      key: "phone_type",
      width: 120,
      render: (value: PhoneType) => PHONE_TYPE_LABELS[value] || value,
    },
    {
      title: "Действия",
      key: "actions",
      width: 100,
      align: "center" as const,
      render: (_: any, record: ClientPhone) => (
        <Space size="small">
          <Button
            type="link"
            icon={<EditOutlined />}
            size="small"
            onClick={() => handleEdit(record)}
            disabled={disabled}
          />
          <Button
            type="link"
            danger
            icon={<DeleteOutlined />}
            size="small"
            onClick={() => handleDelete(record)}
            disabled={disabled}
          />
        </Space>
      ),
    },
  ];

  return (
    <Card
      size="small"
      title="Телефоны"
      extra={
        <Button
          type="primary"
          icon={<PlusOutlined />}
          size="small"
          onClick={handleAdd}
          disabled={disabled}
        >
          Добавить
        </Button>
      }
      style={{ marginTop: 16 }}
    >
      <Table
        dataSource={phones}
        columns={columns}
        rowKey={(record) =>
          record.phone_id?.toString() || record.temp_id?.toString() || ""
        }
        size="small"
        pagination={false}
        locale={{ emptyText: "Нет телефонов" }}
      />

      {/* Phone Modal */}
      <Modal
        title={editingPhone ? "Редактировать телефон" : "Добавить телефон"}
        open={modalOpen}
        onOk={handleSave}
        onCancel={handleCancel}
        okText={editingPhone ? "Сохранить" : "Добавить"}
        cancelText="Отмена"
        width={400}
        modalRender={(modal) => (
          <DraggableModalWrapper open={modalOpen}>{modal}</DraggableModalWrapper>
        )}
      >
        <Form form={form} layout="vertical">
          <Form.Item
            label="Номер телефона"
            name="phone_number"
            rules={[
              { required: true, message: "Введите номер телефона" },
              { min: 7, message: "Минимум 7 символов" },
              { max: 20, message: "Максимум 20 символов" },
              {
                pattern: /^\+?[0-9\s\-\(\)]{7,20}$/,
                message: "Неверный формат номера телефона",
              },
            ]}
          >
            <Input
              placeholder="+7 (XXX) XXX-XX-XX"
              prefix={<PhoneOutlined />}
              autoFocus
            />
          </Form.Item>

          <Form.Item
            label="Тип телефона"
            name="phone_type"
            rules={[{ required: true, message: "Выберите тип телефона" }]}
          >
            <Select options={PHONE_TYPE_OPTIONS} />
          </Form.Item>

          <Form.Item name="is_primary" valuePropName="checked">
            <Checkbox>
              <Space>
                <StarFilled style={{ color: "#faad14" }} />
                Основной номер
              </Space>
            </Checkbox>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
};
