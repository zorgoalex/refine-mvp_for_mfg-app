import { useEffect, useMemo } from "react";
import { Edit, useSelect } from "@refinedev/antd";
import {
  IResourceComponentsProps,
  useCreate,
  useGo,
  useInvalidate,
  useList,
  useUpdate,
} from "@refinedev/core";
import { Form, Input, InputNumber, DatePicker, Select, Switch, message } from "antd";
import { useFormWithHighlight } from "../../hooks/useFormWithHighlight";
import { useParams } from "react-router-dom";
import dayjs, { Dayjs } from "dayjs";

type DowelingEditValues = {
  doweling_order_name?: string;
  order_id?: number | string | null;
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

const toNumberOrDefault = (value: unknown, fallback: number): number => {
  const numeric = toNullableNumber(value);
  return numeric ?? fallback;
};

const toOptionalDate = (value: Dayjs | string | null | undefined): string | null => {
  if (!value) return null;
  const parsed = dayjs.isDayjs(value) ? value : dayjs(value);
  return parsed.isValid() ? parsed.format("YYYY-MM-DD") : null;
};

const toRequiredDate = (value: Dayjs | string | null | undefined, fallback?: string | null): string => {
  return toOptionalDate(value) ?? fallback ?? dayjs().format("YYYY-MM-DD");
};

const activeLinksFor = (links: any[]) =>
  links
    .filter((link) => link?.delete_flag !== true)
    .sort((a, b) => Number(b.order_doweling_link_id ?? 0) - Number(a.order_doweling_link_id ?? 0));

export const DowelOrderEdit: React.FC<IResourceComponentsProps> = () => {
  const { id } = useParams<{ id: string }>();
  const go = useGo();
  const invalidate = useInvalidate();
  const { mutateAsync: updateDowelingLink } = useUpdate();
  const { mutateAsync: createDowelingLink } = useCreate();

  const { formProps, saveButtonProps, queryResult } = useFormWithHighlight({
    resource: "doweling_orders",
    successResource: "doweling_orders_view",
    idField: "doweling_order_id",
    action: "edit",
    navigateOnSuccess: false,
    formProps: {
      id,
    },
  });

  const record = queryResult?.data?.data;
  const dowelingOrderId = toNullableNumber(record?.doweling_order_id ?? id);

  const { data: dowelingLinksData } = useList({
    resource: "order_doweling_links",
    filters: [
      {
        field: "doweling_order_id",
        operator: "eq",
        value: dowelingOrderId,
      },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!dowelingOrderId,
      staleTime: 0,
    },
  });

  const dowelingLinks = useMemo(() => dowelingLinksData?.data || [], [dowelingLinksData?.data]);
  const activeLinks = useMemo(() => activeLinksFor(dowelingLinks), [dowelingLinks]);
  const linkedOrderId = toNullableNumber(record?.order_id) ?? toNullableNumber(activeLinks[0]?.order_id);

  useEffect(() => {
    const form = formProps.form;
    if (!form || !record) return;

    if (!form.isFieldTouched("order_id")) {
      form.setFieldsValue({ order_id: linkedOrderId ?? undefined });
    }

    if (!form.isFieldTouched("is_active")) {
      form.setFieldsValue({ is_active: record.delete_flag !== true });
    }
  }, [formProps.form, linkedOrderId, record]);

  const { selectProps: orderSelectProps } = useSelect({
    resource: "orders",
    optionLabel: "order_name",
    optionValue: "order_id",
    defaultValue: linkedOrderId ?? undefined,
    pagination: { mode: "server", pageSize: 100 },
  });

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

  const syncDowelingLinks = async (nextOrderId: number | null) => {
    if (!dowelingOrderId) return;

    const matchingLinks = dowelingLinks
      .filter((link: any) => toNullableNumber(link.order_id) === nextOrderId)
      .sort((a: any, b: any) => Number(b.order_doweling_link_id ?? 0) - Number(a.order_doweling_link_id ?? 0));
    const linkToKeep = nextOrderId ? matchingLinks[0] : undefined;
    const activeLinksToRemove = activeLinks.filter((link: any) => {
      if (!nextOrderId) return true;
      return Number(link.order_doweling_link_id) !== Number(linkToKeep?.order_doweling_link_id);
    });

    await Promise.all(
      activeLinksToRemove.map((link: any) =>
        updateDowelingLink({
          resource: "order_doweling_links",
          id: link.order_doweling_link_id,
          values: { delete_flag: true },
        }),
      ),
    );

    if (!nextOrderId) {
      return;
    }

    if (linkToKeep) {
      if (linkToKeep.delete_flag === true) {
        await updateDowelingLink({
          resource: "order_doweling_links",
          id: linkToKeep.order_doweling_link_id,
          values: {
            order_id: nextOrderId,
            doweling_order_id: dowelingOrderId,
            delete_flag: false,
          },
        });
      }
      return;
    }

    await createDowelingLink({
      resource: "order_doweling_links",
      values: {
        order_id: nextOrderId,
        doweling_order_id: dowelingOrderId,
        delete_flag: false,
        version: 0,
      },
    });
  };

  const handleFinish = async (values: DowelingEditValues) => {
    const isActive = values.is_active !== false;
    const nextOrderId = isActive ? toNullableNumber(values.order_id) : null;
    const payload = {
      doweling_order_name: String(values.doweling_order_name ?? "").trim(),
      order_id: nextOrderId,
      doweling_order_date: toRequiredDate(values.doweling_order_date, record?.doweling_order_date),
      payment_status_id: toNullableNumber(values.payment_status_id),
      production_status_id: toNullableNumber(values.production_status_id),
      design_engineer_id: toNullableNumber(values.design_engineer_id),
      operator_id: toNullableNumber(values.operator_id),
      issue_date: toOptionalDate(values.issue_date),
      total_amount: toNullableNumber(values.total_amount),
      discount: toNumberOrDefault(values.discount, 0),
      surcharge: toNumberOrDefault(values.surcharge, 0),
      final_amount: toNullableNumber(values.final_amount),
      paid_amount: toNumberOrDefault(values.paid_amount, 0),
      payment_date: toOptionalDate(values.payment_date),
      parts_count: toNumberOrDefault(values.parts_count, 0),
      link_cad_file: values.link_cad_file || null,
      link_pdf_file: values.link_pdf_file || null,
      ref_key_1c: values.ref_key_1c || null,
      delete_flag: !isActive,
    };

    await formProps.onFinish?.(payload);
    await syncDowelingLinks(nextOrderId);

    await Promise.all([
      invalidate({ resource: "doweling_orders", invalidates: ["list", "detail"] }),
      invalidate({ resource: "doweling_orders_view", invalidates: ["list", "detail"] }),
      invalidate({ resource: "order_doweling_links", invalidates: ["list", "detail"] }),
      invalidate({ resource: "orders_view", invalidates: ["list", "detail"] }),
    ]);

    message.success(isActive ? "Присадка сохранена" : "Присадка деактивирована");
    if (isActive && dowelingOrderId) {
      go({ to: { resource: "doweling_orders_view", action: "show", id: dowelingOrderId }, type: "replace" });
    } else {
      go({ to: { resource: "doweling_orders_view", action: "list" }, type: "replace" });
    }
  };

  const initialValues = {
    ...formProps.initialValues,
    order_id: linkedOrderId ?? undefined,
    is_active: formProps.initialValues?.delete_flag !== true,
    doweling_order_date: formProps.initialValues?.doweling_order_date
      ? dayjs(formProps.initialValues.doweling_order_date)
      : undefined,
    issue_date: formProps.initialValues?.issue_date
      ? dayjs(formProps.initialValues.issue_date)
      : undefined,
    payment_date: formProps.initialValues?.payment_date
      ? dayjs(formProps.initialValues.payment_date)
      : undefined,
  };

  return (
    <Edit saveButtonProps={saveButtonProps} title="Редактирование присадки">
      <Form
        {...formProps}
        layout="vertical"
        initialValues={initialValues}
        onFinish={handleFinish}
      >
        <Form.Item
          label="Название присадки"
          name="doweling_order_name"
          rules={[{ required: true, whitespace: true, message: "Обязательное поле" }]}
        >
          <Input maxLength={200} />
        </Form.Item>

        <Form.Item label="Активен" name="is_active" valuePropName="checked">
          <Switch checkedChildren="Да" unCheckedChildren="Нет" />
        </Form.Item>

        <Form.Item label="Заказ" name="order_id">
          <Select
            {...orderSelectProps}
            placeholder="Выберите заказ"
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

        <Form.Item
          label="Статус оплаты"
          name="payment_status_id"
          rules={[{ required: true, message: "Обязательное поле" }]}
        >
          <Select {...paymentStatusSelectProps} placeholder="Выберите статус" />
        </Form.Item>

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
