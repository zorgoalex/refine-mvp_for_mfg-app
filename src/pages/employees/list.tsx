import { Table } from '../../ui/tooltipDelay';
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge } from "antd";
import { LocalizedList } from "../../components/LocalizedList";
import { useEffect, useMemo, useState } from "react";
import { employeeContactsApi } from "../../api/employeeContactsApi";
import type { EmployeeContact } from "../../api/employeeContactsApiTypes";
import { can } from "../../utils/permissions";
import { EMPLOYEE_CONTACT_KIND_LABELS, formatContact, isContactsApiMissing, sortContacts } from "./employeeContactsModel";

export const EmployeeList: React.FC<IResourceComponentsProps> = () => {
  const { tableProps } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "employee_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();
  const [contactsApiMissing, setContactsApiMissing] = useState(false);
  const canViewContacts = can("employees.view") && !contactsApiMissing;
  const pageIds = useMemo(
    () => (tableProps.dataSource ?? []).map((row: any) => Number(row.employee_id)).filter((id) => Number.isFinite(id)),
    [tableProps.dataSource],
  );
  const [contacts, setContacts] = useState<Map<number, EmployeeContact[]>>(new Map());
  const pageKey = pageIds.join(",");
  useEffect(() => {
    if (!canViewContacts || !pageKey) return;
    let cancelled = false;
    employeeContactsApi.list(pageKey.split(",").map(Number)).then((result) => {
      if (!cancelled) setContacts(new Map(result.items.map((item) => [item.employeeId, item.contacts])));
    }).catch((error: unknown) => {
      // An older backend without the contacts API: the column is hidden; any other error leaves it empty.
      if (isContactsApiMissing(error)) setContactsApiMissing(true);
    });
    return () => { cancelled = true; };
  }, [canViewContacts, pageKey]);

  return (
    <LocalizedList title="Сотрудники">
      <Table
        {...tableProps}
        rowKey="employee_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("employees", record.employee_id);
          },
        })}
      >
        <Table.Column dataIndex="employee_id" title="ID" sorter />
        <Table.Column dataIndex="full_name" title="ФИО" sorter />
        <Table.Column dataIndex="position" title="Должность" sorter />
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
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        {canViewContacts ? (
          <Table.Column
            key="work_contacts"
            title="Рабочие контакты"
            render={(_, record: any) => {
              const list = sortContacts(contacts.get(Number(record.employee_id)) ?? []).filter((contact) => contact.isPrimary);
              return list.length ? (
                <Space direction="vertical" size={0}>
                  {list.map((contact) => (
                    <span key={contact.contactId} title={EMPLOYEE_CONTACT_KIND_LABELS[contact.kind]}>{formatContact(contact)}</span>
                  ))}
                </Space>
              ) : null;
            }}
          />
        ) : null}
        <Table.Column dataIndex="note" title="Примечание" />
        <Table.Column dataIndex="ref_key_1c" title="Ключ 1C" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.employee_id} />
              <EditButton hideText size="small" recordItemId={record.employee_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};
