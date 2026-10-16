import { Table } from '../../ui/tooltipDelay';
import React from "react";
import { IResourceComponentsProps, useList, useMany, useNavigation } from "@refinedev/core";
import { ShowButton, EditButton, DateField } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge, Input } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { LocalizedList } from "../../components/LocalizedList";
import { DISPLAY_DATE_TIME_FORMAT } from "../../utils/dateFormat";
import { useOptionalUiVariant } from "../../ui-variant/UiVariantProvider";
import { Segmented } from "../../ui/Segmented";
import { userActiveFilterChoice, userInitials, userSearchText, type UserActiveChoice } from "./userListView";

export const UserList: React.FC<IResourceComponentsProps> = () => {
  const isWorkbench = useOptionalUiVariant()?.variant === "workbench";
  const { tableProps, filters, setFilters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "user_id", order: "desc" }],
    },
  });
  const { show } = useNavigation();
  // The backend users API returns only employee_id: names come from the employees reference.
  const employeeIds = [...new Set((tableProps.dataSource ?? []).map((row: any) => row.employee_id).filter((id: unknown) => id != null))];
  const { data: employees } = useMany({ resource: "employees", ids: employeeIds, queryOptions: { enabled: employeeIds.length > 0 } });
  const employeeNames = new Map((employees?.data ?? []).map((row: any) => [Number(row.employee_id), row.full_name as string]));
  const employeeName = (record: any) => (record?.employee_id ? record?.employee?.full_name ?? employeeNames.get(Number(record.employee_id)) ?? `#${record.employee_id}` : null);

  if (isWorkbench) {
    return (
      <WorkbenchUserList
        tableProps={tableProps}
        filters={filters}
        setFilters={setFilters}
        employeeName={employeeName}
        onShow={(id) => show("users", id)}
      />
    );
  }

  return (
    <LocalizedList>
      <Table
        {...tableProps}
        rowKey="user_id"
        onRow={(record) => ({
          onDoubleClick: () => {
            show("users", record.user_id);
          },
        })}
      >
        <Table.Column dataIndex="user_id" title="ID" sorter />
        <Table.Column dataIndex="username" title="Логин" sorter />
        <Table.Column dataIndex="email" title="Email" sorter />
        <Table.Column dataIndex="full_name" title="Полное имя" sorter />
        <Table.Column
          key="employee"
          title="Сотрудник"
          render={(_, record: any) => employeeName(record)}
        />
        <Table.Column
          dataIndex={["role", "role_name"]}
          title="Роль"
          sorter
          render={(_, record: any) => formatUserRole(record)}
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
          filters={[
            { text: "Активен", value: true },
            { text: "Неактивен", value: false },
          ]}
        />
        <Table.Column
          dataIndex="last_login_at"
          title="Последний вход"
          render={(value) => value && <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} />}
        />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.user_id} />
              <EditButton hideText size="small" recordItemId={record.user_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};

/**
 * «NewLine»: пользователи одной панелью — счётчики под заголовком, поиск и отбор по активности
 * (оба выполняет сервер), в строке аватар, имя с логином, роль и статус плашками. Колонки те же.
 */
const WorkbenchUserList: React.FC<{
  tableProps: any;
  filters: any[];
  setFilters: (filters: any[], behavior?: "merge" | "replace") => void;
  employeeName: (record: any) => string | null;
  onShow: (id: number) => void;
}> = ({ tableProps, filters, setFilters, employeeName, onShow }) => {
  const choice = userActiveFilterChoice(filters);
  const [query, setQuery] = React.useState(() => userSearchText(filters));
  React.useEffect(() => {
    const current = userSearchText(filters);
    if (query.trim() === current) return undefined;
    const timer = window.setTimeout(() => {
      setFilters([{ field: "username", operator: "contains", value: query.trim() || undefined }], "merge");
    }, 350);
    return () => window.clearTimeout(timer);
  }, [query, filters, setFilters]);

  const { data: all } = useList({ resource: "users", pagination: { current: 1, pageSize: 1 } });
  const { data: inactive } = useList({
    resource: "users",
    pagination: { current: 1, pageSize: 1 },
    filters: [{ field: "is_active", operator: "eq", value: false }],
  });
  const totalUsers = all?.total;
  const inactiveUsers = inactive?.total;

  const pickChoice = (next: UserActiveChoice) => {
    setFilters([{ field: "is_active", operator: "eq", value: next === "all" ? undefined : next === "active" }], "merge");
  };

  return (
    <LocalizedList
      title={(
        <span className="wb-refs__heading">
          <span className="wb-refs__title">Пользователи</span>
          <span className="wb-refs__desc wb-users__counts">
            {totalUsers == null ? "Учётные записи для входа в ERP" : (
              <>
                <span>Всего: {totalUsers}</span>
                {inactiveUsers ? <span>неактивных: {inactiveUsers}</span> : null}
              </>
            )}
          </span>
        </span>
      )}
      wrapperProps={{ className: "wb-list wb-refs wb-users" }}
    >
      <div className="wb-users__toolbar">
        <Input
          allowClear
          prefix={<SearchOutlined aria-hidden />}
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Имя, логин или email"
          aria-label="Поиск пользователей"
          className="wb-users__search"
        />
        <Segmented
          size="small"
          value={choice}
          onChange={(value) => pickChoice(value as UserActiveChoice)}
          options={[
            { label: "Все", value: "all" },
            { label: "Активные", value: "active" },
            { label: "Неактивные", value: "inactive" },
          ]}
        />
      </div>
      <Table
        {...tableProps}
        rowKey="user_id"
        onRow={(record: any) => ({
          onDoubleClick: () => onShow(record.user_id),
        })}
      >
        <Table.Column
          dataIndex="full_name"
          title="Пользователь"
          sorter
          render={(_, record: any) => {
            const name = record.full_name || record.username || `#${record.user_id}`;
            return (
              <span className="wb-users__who">
                <span className="wb-avatar" aria-hidden>{userInitials(name) || "—"}</span>
                <span className="wb-users__names">
                  <span className="wb-users__name">{name}</span>
                  <span className="wb-users__login">{record.username}<span className="wb-users__id"> · #{record.user_id}</span></span>
                </span>
              </span>
            );
          }}
        />
        <Table.Column
          dataIndex={["role", "role_name"]}
          title="Роль"
          sorter
          render={(_, record: any) => <span className="wb-users__role">{formatUserRole(record)}</span>}
        />
        <Table.Column key="employee" title="Сотрудник" render={(_, record: any) => employeeName(record) ?? <span className="wb-list__muted">—</span>} />
        <Table.Column dataIndex="email" title="Email" sorter render={(value) => value || <span className="wb-list__muted">—</span>} />
        <Table.Column
          dataIndex="last_login_at"
          title="Последний вход"
          render={(value) => (value ? <DateField value={value} format={DISPLAY_DATE_TIME_FORMAT} /> : <span className="wb-list__muted">ещё не входил</span>)}
        />
        <Table.Column
          dataIndex="is_active"
          title="Статус"
          render={(value: boolean) => (
            <span className="wb-pill" data-tone={value ? "ready" : undefined}>{value ? "Активен" : "Неактивен"}</span>
          )}
        />
        <Table.Column
          title={<span className="sr-only">Действия</span>}
          render={(_, record: any) => (
            <Space size={2}>
              <ShowButton hideText size="small" type="text" recordItemId={record.user_id} />
              <EditButton hideText size="small" type="text" recordItemId={record.user_id} />
            </Space>
          )}
        />
      </Table>
    </LocalizedList>
  );
};

function formatUserRole(record: any): string {
  if (typeof record?.role === "string") {
    return record.role_name || record.role;
  }

  return record?.role?.role_name || record?.role_name || "-";
}
