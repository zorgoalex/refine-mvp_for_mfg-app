import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { ReferenceFilterBar } from "../../components/referenceFilters/ReferenceFilterBar";
import type { ReferenceFilterConfig } from "../../components/referenceFilters/referenceFilterModel";
import { Space, Tag, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";

const MATERIAL_TRANSACTION_TYPES_FILTERS: ReferenceFilterConfig = {
  search: { field: "transaction_type_name", placeholder: "Поиск по названию" },
  activeField: true,
  fields: [
    { kind: "select", field: "direction_type_id", label: "Направление", resource: "transaction_direction", optionLabel: "direction_name", optionValue: "direction_type_id" },
    { kind: "boolean", field: "affects_stock", label: "Влияет на остаток", yes: "Да", no: "Нет" },
    { kind: "boolean", field: "requires_document", label: "Требует документ", yes: "Да", no: "Нет" },
    { kind: "text", field: "description", label: "Описание" },
  ],
};

export const MaterialTransactionTypeList: React.FC<IResourceComponentsProps> =
  () => {
    const { tableProps, filters, setFilters, setCurrent } = useTable({
      syncWithLocation: true,
      sorters: {
        initial: [{ field: "sort_order", order: "asc" }, { field: "transaction_type_id", order: "asc" }],
      },
    });
    const { show } = useNavigation();

    return (
      <LocalizedList title="Типы операций с материалами">
        <ReferenceFilterBar storageKey="material_transaction_types" config={MATERIAL_TRANSACTION_TYPES_FILTERS} filters={filters} setFilters={setFilters} setCurrent={setCurrent} />
        <Table
          {...tableProps}
          rowKey="transaction_type_id"
          onRow={(record) => ({
            onDoubleClick: () => {
              show("material_transaction_types", record.transaction_type_id);
            },
          })}
        >
          <Table.Column dataIndex="transaction_type_id" title="ID" sorter />
          <Table.Column
            dataIndex="transaction_type_name"
            title="Тип операции"
            sorter
          />
          <Table.Column
            dataIndex="direction"
            title="Направление движения"
            render={(direction: any) => direction?.direction_name || "-"}
          />
          <Table.Column
            dataIndex="affects_stock"
            title="Влияет на склад"
            render={(value: boolean) => (
              <Tag color={value ? "green" : "default"}>
                {value ? "Да" : "Нет"}
              </Tag>
            )}
          />
          <Table.Column
            dataIndex="requires_document"
            title="Требует документа"
            render={(value: boolean) => (
              <Tag color={value ? "blue" : "default"}>
                {value ? "Да" : "Нет"}
              </Tag>
            )}
          />
          <Table.Column
            dataIndex="sort_order"
            title="Сортировка по умолчанию"
            sorter
          />
          <Table.Column
            dataIndex="is_active"
            title="Активен"
            sorter
            render={(value: boolean) => (
              <Badge
                status={value ? "success" : "default"}
                text={value ? "Активен" : "Неактивен"}
              />
            )}
          />
          <Table.Column
            title="Действия"
            render={(_, record: any) => (
              <Space size={4}>
                <ShowButton
                  hideText
                  size="small"
                  recordItemId={record.transaction_type_id}
                />
                <EditButton
                  hideText
                  size="small"
                  recordItemId={record.transaction_type_id}
                />
              </Space>
            )}
          />
        </Table>
      </LocalizedList>
    );
  };
