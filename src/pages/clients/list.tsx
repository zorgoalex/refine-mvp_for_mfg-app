import { Table } from '../../ui/tooltipDelay';
import React, { useState, useCallback, useEffect } from "react";
import { IResourceComponentsProps, useInvalidate, useNavigation } from "@refinedev/core";
import { List, ShowButton, EditButton, CreateButton } from "@refinedev/antd";
import { usePersistentTable as useTable } from "../../hooks/usePersistentTable";
import { Space, Badge, Input, Button, Tag, Typography, message } from "antd";
import { SearchOutlined } from "@ant-design/icons";
import { useHighlightRow } from "../../hooks/useHighlightRow";
import { HasuraReportError } from "../../api/hasuraReportClient";
import { countClientsAfter, findClientByName } from "../../api/reports/clientsSearchReportApi";
import { ReferenceSortOrderColumn } from "../../components/ReferenceSortOrder";
import { CLIENT_PERSON_TYPE_LABELS, ClientPersonType } from "../../types/clients";
import { clientsReadApi, type ClientListFacts } from "../../api/clientsReadApi";
import { featureFlags } from "../../config/featureFlags";
import { formatDate } from "../../utils/dateFormat";
import { can } from "../../utils/permissions";
import { ClientCounterpartyBulkModal } from "./ClientCounterpartyBulkModal";
import { canChooseCounterparty } from "./clientCounterpartyModel";

export const ClientList: React.FC<IResourceComponentsProps> = () => {
  const [searchValue, setSearchValue] = useState<string>("");
  const [highlightedClientId, setHighlightedClientId] = useState<number | null>(null);
  const [matchingOpen, setMatchingOpen] = useState(false);
  const invalidate = useInvalidate();

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

  // Телефон, число заказов и последний заказ клиентов страницы — отдельным запросом к серверу
  // (число и последний заказ — по тем заказам, которые видит пользователь). В режиме без серверного
  // входа запрос не делается: колонки остаются пустыми.
  const pageClientIds = ((tableProps?.dataSource ?? []) as ReadonlyArray<{ client_id?: unknown }>)
    .map((row) => Number(row.client_id)).filter((id) => Number.isInteger(id) && id > 0);
  const pageClientIdsKey = pageClientIds.join(",");
  const [clientFacts, setClientFacts] = useState<{ key: string; byId: Map<number, ClientListFacts> } | null>(null);
  useEffect(() => {
    if (!featureFlags.useBackendAuth || pageClientIds.length === 0) return undefined;
    let current = true;
    clientsReadApi.listFacts(pageClientIds)
      .then((rows) => { if (current) setClientFacts({ key: pageClientIdsKey, byId: new Map(rows.map((row) => [row.clientId, row])) }); })
      .catch(() => { if (current) setClientFacts({ key: pageClientIdsKey, byId: new Map() }); });
    return () => { current = false; };
  }, [pageClientIdsKey]); // eslint-disable-line react-hooks/exhaustive-deps
  const factsOf = (clientId: unknown): ClientListFacts | undefined =>
    (clientFacts?.key === pageClientIdsKey ? clientFacts.byId.get(Number(clientId)) : undefined);

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
      wrapperProps={{ className: 'wb-list' }}
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
          {canChooseCounterparty(can) ? (
            <Button style={{ marginRight: 8 }} onClick={() => setMatchingOpen(true)}>Сопоставить с 1С</Button>
          ) : null}
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
        <Table.Column dataIndex="client_id" title="id" sorter className="wb-list__muted" />
        <ReferenceSortOrderColumn />
        <Table.Column dataIndex="client_name" title="Имя клиента" sorter className="wb-list__title" />
        <Table.Column
          key="facts_phone"
          title="Телефон"
          render={(_, record: any) => {
            const facts = factsOf(record.client_id);
            if (!facts?.primaryPhone) return <span className="wb-list__muted">—</span>;
            return (
              <span style={{ whiteSpace: "nowrap" }}>
                {facts.primaryPhone}
                {facts.phonesCount > 1 ? <span className="wb-list__muted"> +{facts.phonesCount - 1}</span> : null}
              </span>
            );
          }}
        />
        <Table.Column
          key="facts_orders"
          title="Заказов"
          align="right"
          render={(_, record: any) => {
            const orders = factsOf(record.client_id)?.orders;
            return orders ? orders.count : <span className="wb-list__muted">—</span>;
          }}
        />
        <Table.Column
          key="facts_last_order"
          title="Последний заказ"
          render={(_, record: any) => {
            const last = factsOf(record.client_id)?.orders?.last;
            if (!last) return <span className="wb-list__muted">—</span>;
            return (
              <span style={{ whiteSpace: "nowrap" }}>
                <a onClick={(event) => { event.stopPropagation(); show("orders_view", last.orderId); }}>№ {last.orderName}</a>
                {last.orderDate ? <span className="wb-list__muted"> · {formatDate(last.orderDate)}</span> : null}
              </span>
            );
          }}
        />
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
        <Table.Column
          dataIndex="ref_key_1c"
          title="Контрагент 1С"
          render={(value: string | null) => (value ? <Tag color="green">сопоставлен</Tag> : <Typography.Text type="secondary">—</Typography.Text>)}
        />
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
      <ClientCounterpartyBulkModal
        open={matchingOpen}
        onClose={() => setMatchingOpen(false)}
        onChanged={() => { void invalidate({ resource: "clients", invalidates: ["list"] }); }}
      />
    </List>
  );
};
