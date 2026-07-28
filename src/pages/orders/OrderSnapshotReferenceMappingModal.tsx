import React, { useMemo } from "react";
import { Alert, Modal, Select, Space, Table, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import type {
  ImportOrderSnapshotUnmappedReference,
  OrderSnapshotReferenceEntityType,
} from "../../api/types/orderApi.types";
import { useOrderFormData, type ReferenceOption } from "../../hooks/useOrderFormData";
import {
  snapshotReferenceMappingKey,
  type SnapshotUnmappedReferenceRow,
} from "./orderSnapshotReferenceMapping";

const { Text } = Typography;

interface OrderSnapshotReferenceMappingModalProps {
  open: boolean;
  rows: SnapshotUnmappedReferenceRow[];
  values: Record<string, number | null>;
  confirmLoading: boolean;
  onChange: (mappingKey: string, targetId: number | null) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

interface TargetOption {
  value: number;
  label: string;
  code: string | null;
}

const ENTITY_LABELS: Record<OrderSnapshotReferenceEntityType, string> = {
  material: "Материал",
  sheetMaterialType: "Листовой материал",
  millingType: "Фрезеровка",
  edgeType: "Кромка",
  film: "Пленка",
  filmType: "Тип пленки",
  unit: "Ед. изм.",
  materialType: "Тип материала",
  supplier: "Поставщик",
  vendor: "Производитель",
  orderStatus: "Статус заказа",
  paymentStatus: "Статус оплаты",
  paymentType: "Тип оплаты",
  productionStatus: "Статус производства",
  workshop: "Цех",
  employee: "Сотрудник",
  resourceRequirementStatus: "Статус потребности",
};

export const OrderSnapshotReferenceMappingModal: React.FC<OrderSnapshotReferenceMappingModalProps> = ({
  open,
  rows,
  values,
  confirmLoading,
  onChange,
  onCancel,
  onSubmit,
}) => {
  const orderFormData = useOrderFormData(open);

  const formOptionsByType = useMemo(
    () => ({
      material: toTargetOptions(orderFormData.references.materials),
      sheetMaterialType: toTargetOptions(orderFormData.references.sheetMaterialTypes),
      millingType: toTargetOptions(orderFormData.references.millingTypes),
      edgeType: toTargetOptions(orderFormData.references.edgeTypes),
      film: toTargetOptions(orderFormData.references.films),
      unit: toUnitOptions(orderFormData.data?.units ?? []),
      orderStatus: toStatusOptions(orderFormData.data?.orderStatuses ?? []),
      paymentStatus: toStatusOptions(orderFormData.data?.paymentStatuses ?? []),
      paymentType: toTargetOptions(orderFormData.references.paymentTypes),
      productionStatus: toStatusOptions(orderFormData.data?.productionStatuses ?? []),
      workshop: toTargetOptions(orderFormData.references.workshops),
      employee: toTargetOptions(orderFormData.references.employees),
    }),
    [orderFormData.data, orderFormData.references],
  );

  const columns = useMemo<ColumnsType<SnapshotUnmappedReferenceRow>>(
    () => [
      {
        title: "Справочник",
        dataIndex: "entityType",
        key: "entityType",
        width: 150,
        render: (value: OrderSnapshotReferenceEntityType) => ENTITY_LABELS[value] ?? value,
      },
      {
        title: "Значение JSON",
        dataIndex: "sourceName",
        key: "sourceName",
        render: (_, record) => (
          <Space direction="vertical" size={0}>
            <Text>{record.sourceName}</Text>
            <Text type="secondary">sourceId: {record.sourceId}</Text>
          </Space>
        ),
      },
      {
        title: "Файлы",
        dataIndex: "fileNames",
        key: "fileNames",
        width: 220,
        render: (fileNames: string[]) => <Text type="secondary">{fileNames.join(", ")}</Text>,
      },
      {
        title: "Исп.",
        dataIndex: "usageCount",
        key: "usageCount",
        width: 70,
      },
      {
        title: "Соответствие ERP",
        key: "target",
        width: 300,
        render: (_, record) => {
          const mappingKey = snapshotReferenceMappingKey(record);
          const options = optionsFor(record, formOptionsByType);

          return (
            <Select
              style={{ width: "100%" }}
              showSearch
              optionFilterProp="label"
              placeholder="Выберите значение"
              loading={orderFormData.isLoading}
              value={values[mappingKey] ?? undefined}
              options={options.map((option) => ({
                value: option.value,
                label: option.code ? `${option.label} (${option.code})` : option.label,
              }))}
              onChange={(value) => onChange(mappingKey, Number(value))}
            />
          );
        },
      },
    ],
    [formOptionsByType, onChange, orderFormData.isLoading, values],
  );

  return (
    <Modal
      title="Ручное сопоставление справочников"
      open={open}
      width={980}
      okText="Импортировать"
      cancelText="Отмена"
      confirmLoading={confirmLoading}
      onOk={onSubmit}
      onCancel={onCancel}
      destroyOnClose
    >
      <Space direction="vertical" size="middle" style={{ width: "100%" }}>
        {orderFormData.error ? (
          <Alert type="warning" showIcon message={orderFormData.error.message} />
        ) : null}
        <Alert
          type="info"
          showIcon
          message="Автоматическое сопоставление найдено не для всех справочников. Выберите существующие значения ERP и повторите импорт."
        />
        <Table
          rowKey={(record) => snapshotReferenceMappingKey(record)}
          size="small"
          columns={columns}
          dataSource={rows}
          pagination={rows.length > 8 ? { pageSize: 8, showSizeChanger: false } : false}
          scroll={{ x: 920 }}
        />
      </Space>
    </Modal>
  );
};

type FormOptionsByType = Partial<Record<OrderSnapshotReferenceEntityType, TargetOption[]>>;

function optionsFor(
  row: SnapshotUnmappedReferenceRow,
  formOptionsByType: FormOptionsByType,
): TargetOption[] {
  return mergeTargetOptions(
    formOptionsByType[row.entityType] ?? [],
    row.candidates.map(candidateToTargetOption),
  );
}

function toTargetOptions(options: ReferenceOption[]): TargetOption[] {
  return options.map((option) => ({
    value: option.value,
    label: option.label,
    code: null,
  }));
}

function toStatusOptions(
  items: Array<{ id: number; name: string; code?: string | null }>,
): TargetOption[] {
  return items.map((item) => ({
    value: item.id,
    label: item.name,
    code: item.code ?? null,
  }));
}

function toUnitOptions(
  items: Array<{ id: number; name: string; code: string }>,
): TargetOption[] {
  return items.map((item) => ({
    value: item.id,
    label: item.name,
    code: item.code,
  }));
}

function candidateToTargetOption(
  candidate: ImportOrderSnapshotUnmappedReference["candidates"][number],
): TargetOption {
  return {
    value: candidate.id,
    label: candidate.name,
    code: candidate.code,
  };
}

function mergeTargetOptions(left: TargetOption[], right: TargetOption[]): TargetOption[] {
  const byId = new Map<number, TargetOption>();
  for (const option of [...left, ...right]) {
    byId.set(option.value, option);
  }
  return [...byId.values()];
}
