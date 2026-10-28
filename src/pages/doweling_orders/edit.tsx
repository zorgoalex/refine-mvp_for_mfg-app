import { useEffect, useMemo, useState } from "react";
import { Edit, useSelect } from "@refinedev/antd";
import { IResourceComponentsProps, useGo, useInvalidate, useList, useOne } from "@refinedev/core";
import { Form, Input, InputNumber, DatePicker, Select, Switch, message } from "antd";
import { useParams } from "react-router-dom";
import dayjs, { Dayjs } from "dayjs";
import { buildUpdateDowelingRequest, dowelingApi, isOutdatedBackendError, OUTDATED_BACKEND_MESSAGE } from "../../api/dowelingApi";
import { createBackendSelectProps, useOrderFormData } from "../../hooks/useOrderFormData";
import { useBazisCardsCapability } from "../../hooks/useBazisCardsCapability";
import { isApiError } from "../../api/apiError";
import { useOrderFinancialVisibility } from "../../hooks/useOrderFinancialVisibility";
import { hasHasuraFinancials } from "../../utils/hasuraFinancials";

type DowelingEditValues = {
  doweling_order_name?: string;
  client_id?: number | string | null;
  order_ids?: Array<number | string>;
  doweling_order_date?: Dayjs | string | null;
  payment_status_id?: number | string | null;
  production_status_id?: number | string | null;
  design_engineer_id?: number | string | null;
  operator_id?: number | string | null;
  issue_date?: Dayjs | string | null;
  parts_count?: number | string | null;
  total_amount?: number | string | null;
  discount?: number | string | null;
  surcharge?: number | string | null;
  final_amount?: number | string | null;
  paid_amount?: number | string | null;
  payment_date?: Dayjs | string | null;
  link_cad_file?: string | null;
  link_pdf_file?: string | null;
  ref_key_1c?: string | null;
  is_active?: boolean;
};

const toNullableNumber = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
};

const toOptionalDate = (value: Dayjs | string | null | undefined): string | null => {
  if (!value) return null;
  const parsed = dayjs.isDayjs(value) ? value : dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
};

const toDayjs = (value: unknown) => (value ? dayjs(String(value)) : undefined);

export const DowelOrderEdit: React.FC<IResourceComponentsProps> = () => {
  const { id } = useParams<{ id: string }>();
  const go = useGo();
  const invalidate = useInvalidate();
  const [form] = Form.useForm<DowelingEditValues>();
  const [saving, setSaving] = useState(false);
  const dowelingOrderId = toNullableNumber(id);

  // Reads stay on Hasura (doweling.view + order scope); every write goes through the backend command
  // PATCH /api/v1/doweling-orders/:id (audit, version, order scope of all linked orders).
  const { data: recordData, isLoading, refetch } = useOne({
    resource: "doweling_orders",
    id: dowelingOrderId ?? undefined,
    queryOptions: { enabled: !!dowelingOrderId, staleTime: 0 },
  });
  const record = recordData?.data;
  // Money (access groups «финансы»): shown and sent only when the user may see it (permission + the settings matrix;
  // false while the settings load) AND it arrived (Hasura answers `financials` only with orders.view_financials).
  // Otherwise the save carries no money and the server keeps it.
  const { canViewFinancials } = useOrderFinancialVisibility();
  const moneyEditable = canViewFinancials && hasHasuraFinancials("doweling_orders", record);

  const { data: dowelingLinksData, refetch: refetchLinks } = useList({
    resource: "order_doweling_links",
    filters: [
      { field: "doweling_order_id", operator: "eq", value: dowelingOrderId },
      { field: "delete_flag", operator: "eq", value: false },
    ],
    pagination: { pageSize: 100 },
    queryOptions: { enabled: !!dowelingOrderId, staleTime: 0 },
  });
  // The orders of the doweling order: active links ∪ the legacy order_id (a legacy-only order must not vanish on save).
  const linkedOrderIds = useMemo(
    () =>
      [...new Set([...(dowelingLinksData?.data ?? []).map((link: any) => toNullableNumber(link.order_id)), toNullableNumber(record?.order_id)])]
        .filter((orderId): orderId is number => orderId !== null)
        .sort((a, b) => a - b),
    [dowelingLinksData?.data, record?.order_id],
  );

  useEffect(() => {
    if (!record || !dowelingLinksData) return;
    form.setFieldsValue({
      ...record,
      // A card of an unknown client (previous backend, «нд» by default): the user picks the client, nothing is guessed.
      client_id: record.client_source === "default" ? undefined : record.client_id,
      order_ids: linkedOrderIds,
      is_active: record.delete_flag !== true,
      doweling_order_date: toDayjs(record.doweling_order_date),
      issue_date: toDayjs(record.issue_date),
      payment_date: toDayjs(record.payment_date),
    } as DowelingEditValues);
  }, [form, record, dowelingLinksData, linkedOrderIds]);

  const isActive = Form.useWatch("is_active", form);
  // The client of a card needs a backend that knows cards; an older one (open tab after a rollback) keeps it as is.
  const cardsSupported = useBazisCardsCapability();
  // A Bazis project links orders of its own client only (migration 279): the order list follows the client.
  const clientId = toNullableNumber(Form.useWatch("client_id", form));

  // orders_view: the backend order list (search + the user's order scope); Hasura `orders` is ERP-admin-only since 0Б.
  const { selectProps: orderSelectProps } = useSelect({
    resource: "orders_view",
    optionLabel: "order_name",
    optionValue: "order_id",
    defaultValue: linkedOrderIds,
    filters: clientId ? [{ field: "client_id", operator: "eq", value: clientId }] : [],
    pagination: { mode: "server", pageSize: 100 },
  });

  const orderFormData = useOrderFormData();
  const { selectProps: legacyClientSelectProps } = useSelect({
    resource: "clients",
    optionLabel: "client_name",
    optionValue: "client_id",
    defaultValue: record?.client_id ?? undefined,
    queryOptions: { enabled: !orderFormData.enabled },
  });
  const clientSelectProps = orderFormData.enabled
    ? createBackendSelectProps(orderFormData.references.clients, orderFormData.isLoading)
    : legacyClientSelectProps;

  const { selectProps: paymentStatusSelectProps } = useSelect({
    resource: "payment_statuses",
    optionLabel: "payment_status_name",
    optionValue: "payment_status_id",
    defaultValue: record?.payment_status_id ?? undefined,
  });

  const { selectProps: productionStatusSelectProps } = useSelect({
    resource: "production_statuses",
    optionLabel: "production_status_name",
    optionValue: "production_status_id",
    defaultValue: record?.production_status_id ?? undefined,
  });

  const { selectProps: employeeSelectProps } = useSelect({
    resource: "employees",
    optionLabel: "full_name",
    optionValue: "employee_id",
  });

  const handleFinish = async (values: DowelingEditValues) => {
    if (!dowelingOrderId || !record) return;
    // The backend no longer knows cards (an open tab after a rollback) but the user chose a client: the client would be
    // lost silently — keep the form and ask to reload instead (R2 #5).
    const chosenClient = toNullableNumber(values.client_id ?? form.getFieldValue("client_id"));
    const storedClient = record.client_source === "default" ? null : toNullableNumber(record.client_id);
    if (!cardsSupported && chosenClient !== null && chosenClient !== storedClient) {
      message.error(OUTDATED_BACKEND_MESSAGE);
      return;
    }
    const request = buildUpdateDowelingRequest(
      {
        ...values,
        client_id: cardsSupported ? values.client_id : null,
        doweling_order_date: toOptionalDate(values.doweling_order_date),
        issue_date: toOptionalDate(values.issue_date),
        payment_date: toOptionalDate(values.payment_date),
      },
      {
        expectedVersion: Number(record.version ?? 0),
        // The backend refuses the save when these are no longer the current orders (separate reads may disagree).
        baseOrderIds: linkedOrderIds,
        fallbackDate: toOptionalDate(record.doweling_order_date) ?? dayjs().format("YYYY-MM-DD"),
        sendMoney: moneyEditable,
      },
    );

    setSaving(true);
    try {
      const result = await dowelingApi.update(dowelingOrderId, request);
      await Promise.all([
        invalidate({ resource: "doweling_orders", invalidates: ["list", "detail"] }),
        invalidate({ resource: "doweling_orders_view", invalidates: ["list", "detail"] }),
        invalidate({ resource: "order_doweling_links", invalidates: ["list", "detail"] }),
        invalidate({ resource: "orders_view", invalidates: ["list", "detail"] }),
      ]);
      if (!result.changed) {
        message.info("Изменений нет");
      } else {
        message.success(result.dowelingOrder.isActive ? "Базис-проект сохранён" : "Базис-проект деактивирован");
      }
      if (result.dowelingOrder.isActive) {
        go({ to: { resource: "doweling_orders_view", action: "show", id: dowelingOrderId }, type: "replace" });
      } else {
        go({ to: { resource: "doweling_orders_view", action: "list" }, type: "replace" });
      }
    } catch (error) {
      if (isApiError(error, "DOWELING_VERSION_CONFLICT") || isApiError(error, "DOWELING_LINKS_CONFLICT")) {
        message.error("Базис-проект уже изменили. Данные обновлены — проверьте и сохраните ещё раз");
        await Promise.all([refetch(), refetchLinks()]);
      } else if (isOutdatedBackendError(error)) {
        message.error(OUTDATED_BACKEND_MESSAGE);
      } else {
        message.error(error instanceof Error && error.message ? error.message : "Не удалось сохранить Базис-проект");
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <Edit
      isLoading={isLoading}
      saveButtonProps={{ onClick: () => form.submit(), loading: saving, disabled: !record }}
      title="Редактирование Базис-проекта"
    >
      <Form form={form} layout="vertical" onFinish={handleFinish}>
        <Form.Item
          label="Номер Базис-проекта"
          name="doweling_order_name"
          rules={[{ required: true, whitespace: true, message: "Обязательное поле" }]}
        >
          <Input maxLength={200} />
        </Form.Item>

        <Form.Item
          label="Клиент"
          name="client_id"
          hidden={!cardsSupported}
          rules={cardsSupported && record?.client_source !== "default" ? [{ required: true, message: "Обязательное поле" }] : []}
          extra={record?.client_source === "default"
            ? "Клиент не был указан (запись старой версии) — выберите клиента"
            : "Все заказы и XML Базис-проекта — этого клиента"}
        >
          <Select
            {...clientSelectProps}
            placeholder="Выберите клиента"
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Switch
            checkedChildren="Да"
            unCheckedChildren="Нет"
            onChange={(checked) => {
              if (!checked) form.setFieldsValue({ order_ids: [] });
            }}
          />
        </Form.Item>

        <Form.Item
          label="Заказы"
          name="order_ids"
          extra={isActive === false ? "Неактивный Базис-проект не связан с заказами" : "Базис-проект может относиться к нескольким заказам"}
        >
          <Select
            {...orderSelectProps}
            mode="multiple"
            disabled={isActive === false}
            placeholder="Выберите заказы"
            allowClear
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item
          label="Дата заказа"
          name="doweling_order_date"
          rules={[{ required: true, message: "Обязательное поле" }]}
          getValueProps={(value) => ({
            value: value ? dayjs(value) : undefined,
          })}
        >
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>

        {moneyEditable && (
          <Form.Item
            label="Статус оплаты"
            name="payment_status_id"
            rules={[{ required: true, message: "Обязательное поле" }]}
          >
            <Select {...paymentStatusSelectProps} placeholder="Выберите статус" />
          </Form.Item>
        )}

        <Form.Item label="Статус производства" name="production_status_id">
          <Select
            {...productionStatusSelectProps}
            placeholder="Выберите статус"
            allowClear
          />
        </Form.Item>

        <Form.Item
          label="Конструктор"
          name="design_engineer_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select
            {...employeeSelectProps}
            placeholder="Выберите конструктора"
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="Оператор" name="operator_id">
          <Select
            {...employeeSelectProps}
            placeholder="Выберите оператора"
            allowClear
            showSearch
            filterOption={(input, option) =>
              String(option?.label ?? "")
                .toLowerCase()
                .includes(input.toLowerCase())
            }
          />
        </Form.Item>

        <Form.Item label="Дата выдачи" name="issue_date">
          <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
        </Form.Item>

        <Form.Item label="Количество деталей" name="parts_count">
          <InputNumber min={0} style={{ width: "100%" }} />
        </Form.Item>

        {moneyEditable && (<>
          <Form.Item label="Сумма" name="total_amount">
            <InputNumber
              min={0}
              precision={2}
              style={{ width: "100%" }}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item label="Скидка" name="discount">
            <InputNumber
              min={0}
              precision={2}
              style={{ width: "100%" }}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item label="Наценка" name="surcharge">
            <InputNumber
              min={0}
              precision={2}
              style={{ width: "100%" }}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item label="Итого со скидкой" name="final_amount">
            <InputNumber
              min={0}
              precision={2}
              style={{ width: "100%" }}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item label="Оплачено" name="paid_amount">
            <InputNumber
              min={0}
              precision={2}
              style={{ width: "100%" }}
              placeholder="0.00"
            />
          </Form.Item>

          <Form.Item label="Дата оплаты" name="payment_date">
            <DatePicker style={{ width: "100%" }} format="DD.MM.YYYY" />
          </Form.Item>
        </>)}

        <Form.Item label="Ссылка на CAD-файл" name="link_cad_file">
          <Input placeholder="https://..." />
        </Form.Item>

        <Form.Item label="Ссылка на PDF-файл" name="link_pdf_file">
          <Input placeholder="https://..." />
        </Form.Item>

        <Form.Item label="Ref Key 1C" name="ref_key_1c">
          <Input />
        </Form.Item>
      </Form>
    </Edit>
  );
};
