import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useNavigation } from "@refinedev/core";
import { List, ShowButton, EditButton, CreateButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Table, Badge, Input, Button, message } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { HasuraReportError } from "../../api/hasuraReportClient";
import { countClientsAfter, findClientByName } from "../../api/reports/clientsSearchReportApi";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";
import { CLIENT_PERSON_TYPE_LABELS, ClientPersonType } from "../../types/clients";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedClientId, setHighlightedClientId] = useState<number | null>(null);

  const { tableProps, current, pageSize, setCurrent, sorters, setSorters } = useTable({
    syncWithLocation: true,
    sorters: {
      initial: [{ field: "sort_order", order: "asc" }, { field: "client_id", order: "asc" }],
    },
    pagination: {
      mode: "server",
      pageSize: 10,
    },
  });

  const { highlightProps: existingHighlightProps } = useHighlightRow("client_id", tableProps.dataSource);
  const { show } = useNavigation();

  // Автоскролл к найденной строке после загрузки данных
  useEffect(() => {
    if (highlightedClientId && tableProps?.dataSource) {
      const timeoutId = setTimeout(() => {
        const row = document.querySelector(`tr[data-row-key="${highlightedClientId}"]`);
        if (row) {
          row.scrollIntoView({ behavior: "smooth", block: "center" });
        }
      }, 100);
      return () => clearTimeout(timeoutId);
    }
  }, [highlightedClientId, tableProps?.dataSource]);

  // Обработчик поиска клиента
  const handleSearchClient = useCallback(async () => {
    if (!searchValue || searchValue.trim() === "") {
      message.warning("Введите название клиента для поиска");
      return;
    }

    const clientName = searchValue.trim();

    // Сбрасываем сортировку на client_id DESC перед поиском
    const isDefaultSort =
      sorters.length >= 1 &&
      sorters[0].field === "client_id" &&
      sorters[0].order === "desc";

    if (!isDefaultSort) {
      message.info("Сброс сортировки для поиска...");
      setSorters([{ field: "client_id", order: "desc" }]);
      await new Promise(resolve => setTimeout(resolve, 500));
    }

    try {
      let foundClient;
      try {
        foundClient = await findClientByName(clientName);
      } catch (e) {
        if (e instanceof HasuraReportError && e.code === "NOT_AUTHENTICATED") {
          message.error("Не авторизован. Пожалуйста, войдите в систему.");
        } else {
          message.error((e as Error).message || "Ошибка поиска");
          console.error("GraphQL ошибка:", e);
        }
        return;
      }

      if (!foundClient) {
        message.error(`Клиент с "${clientName}" не найден`);
        return;
      }

      const foundClientId = foundClient.client_id;

      // Шаг 2: Получаем количество клиентов с client_id > найденного (для DESC сортировки)
      let greaterCount: number;
      try {
        greaterCount = await countClientsAfter(foundClientId);
      } catch (e) {
        message.error((e as Error).message || "Ошибка подсчета");
        console.error("GraphQL ошибка при подсчете:", e);
        return;
      }

      // Вычисляем номер страницы
      const targetPage = Math.floor(greaterCount / pageSize) + 1;

      // Переключаем на нужную страницу
      if (targetPage !== current) {
        setCurrent(targetPage);
      }

      // Подсвечиваем найденную строку
      setHighlightedClientId(foundClientId);
      message.success(`Клиент "${foundClient.client_name}" найден`);

      // Убираем подсветку через 3 секунды
      setTimeout(() => {
        setHighlightedClientId(null);
      }, 3000);
    } catch (error) {
      console.error("Ошибка поиска клиента:", error);
      message.error("Ошибка при поиске клиента");
    }
  }, [searchValue, pageSize, current, setCurrent, sorters, setSorters]);

  // Комбинированный rowClassName для подсветки
  const getRowClassName = (record: any) => {
    if (record.client_id === highlightedClientId) {
      return "highlighted-row";
    }
    // Поддержка существующей подсветки из useHighlightRow
    if (existingHighlightProps.rowClassName) {
      return existingHighlightProps.rowClassName(record);
    }
    return "";
  };

  return (
    <List
      title="Клиенты"
      headerButtons={() => (
        <>
          <Space.Compact style={{ marginRight: 8 }}>
            <Input
              placeholder="Поиск по названию"
              value={searchValue}
              onChange={(e) => setSearchValue(e.target.value)}
              onPressEnter={handleSearchClient}
              style={{ width: 200 }}
              allowClear
            />
            <Button
              type="default"
              icon={<SearchOutlined />}
              onClick={handleSearchClient}
            >
              Найти
            </Button>
          </Space.Compact>
          <CreateButton>Создать</CreateButton>
        </>
      )}
    >
      <Table
        {...tableProps}
        rowKey="client_id"
        rowClassName={getRowClassName}
        onRow={(record) => ({
          ...existingHighlightProps.onRow?.(record),
          onDoubleClick: () => {
            show("clients", record.client_id);
          },
        })}
      >
        <Table.Column dataIndex="client_id" title="id" sorter />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="client_name" title="Имя клиента" sorter />
        <Table.Column
          dataIndex="person_type"
          title="Тип лица"
          sorter
          render={(value: ClientPersonType) => CLIENT_PERSON_TYPE_LABELS[value] || "Физическое лицо"}
          filters={[
            { text: "Физическое лицо", value: "individual" },
            { text: "Юридическое лицо", value: "legal" },
          ]}
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
        <Table.Column dataIndex="ref_key_1c" title="1С-key" />
        <Table.Column
          title="Действия"
          render={(_, record: any) => (
            <Space>
              <ShowButton hideText size="small" recordItemId={record.client_id} />
              <EditButton hideText size="small" recordItemId={record.client_id} />
            </Space>
          )}
        />
      </Table>
    </List>
  );
};
