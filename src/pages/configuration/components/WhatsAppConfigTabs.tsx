import React, { useCallback, useEffect, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  Form,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Select,
  Space,
  Spin,
  Switch,
  Tabs,
  Tag,
  Typography,
  message,
} from "antd";
import {
  PlusOutlined,
  DownloadOutlined,
  QrcodeOutlined,
  ReloadOutlined,
  RetweetOutlined,
} from "@ant-design/icons";
import { Table } from "../../../ui/tooltipDelay";
import { whatsappApi } from "../../../api/whatsappApi";
import { ApiError, isApiError } from "../../../api/apiError";
import { featureFlags } from "../../../config/featureFlags";
import type {
  WhatsAppAuditDto,
  WhatsAppDeliveryJobDto,
  WhatsAppRuleDto,
  WhatsAppRuleInput,
  WhatsAppStatusDto,
  WhatsAppTemplateDto,
  WhatsAppTemplateInput,
  WhatsAppTechnicalLogDto,
  WhatsAppTechnicalLogQuery,
} from "../../../api/types/whatsappApi.types";
import { can } from "../../../utils/permissions";
import "./WhatsAppConfigTabs.css";

const { Paragraph, Text, Title } = Typography;

export interface UserFacingError {
  title: string;
  description: string;
}

export const WhatsAppConnectionConfig: React.FC = () => {
  const canManage =
    !featureFlags.useBackendPermissions || can("whatsapp.manage");
  const [status, setStatus] = useState<WhatsAppStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [action, setAction] = useState(false);
  const [actionError, setActionError] = useState<UserFacingError | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setStatus(await whatsappApi.status());
    } catch (loadError) {
      setError(errorText(loadError, "Не удалось получить статус WAHA"));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);
  useEffect(
    () => () => {
      if (qrUrl) URL.revokeObjectURL(qrUrl);
    },
    [qrUrl]
  );

  const showQr = async () => {
    setAction(true);
    setActionError(null);
    try {
      const blob = await whatsappApi.qr();
      if (blob.type !== "image/png" || blob.size < 8) {
        throw new ApiError({
          code: "WAHA_QR_RESPONSE_INVALID",
          message: "Invalid QR image",
          status: 502,
        });
      }
      setQrUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
    } catch (actionError) {
      setActionError(qrErrorPresentation(actionError));
    } finally {
      setAction(false);
    }
  };

  const restart = async () => {
    setAction(true);
    setActionError(null);
    try {
      await whatsappApi.restart(Boolean(status?.restrictions.length));
      message.success("WAHA перезапущен. Новый QR действует ограниченное время.");
      await load();
    } catch (actionError) {
      setActionError(restartErrorPresentation(actionError));
    } finally {
      setAction(false);
    }
  };

  if (loading && !status) return <CenteredSpin />;
  if (error && !status) return <LoadError messageText={error} onRetry={load} />;

  const queueTotal = Object.values(status?.diagnostics?.queue ?? {}).reduce(
    (sum, count) => sum + count,
    0
  );
  const session = whatsappSessionPresentation(status?.session, status?.issues);
  return (
    <div className="whatsapp-config">
      <header className="whatsapp-config__header">
        <div>
          <Title level={4}>Подключение WhatsApp</Title>
          <Paragraph type="secondary">
            Состояние WAHA, авторизация устройства и безопасное управление
            сессией.
          </Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          onClick={() => void load()}
          loading={loading}
        >
          Обновить
        </Button>
      </header>
      {status?.restrictions.length ? (
        <Alert
          type="warning"
          showIcon
          message="Ограничения WhatsApp активны"
          description={`Перезапуск их не снимет: ${status.restrictions.map(restrictionLabel).join(", ")}.`}
        />
      ) : null}
      {error ? <Alert type="warning" showIcon message={error} /> : null}
      {actionError ? (
        <Alert type="error" showIcon closable message={actionError.title}
          description={actionError.description} onClose={() => setActionError(null)} />
      ) : null}
      {session.notice ? (
        <Alert type={session.notice.type} showIcon message={session.notice.title}
          description={session.notice.description} />
      ) : null}
      <Card className="whatsapp-config__status-card">
        <Descriptions column={{ xs: 1, sm: 2, lg: 3 }}>
          <Descriptions.Item label="Состояние">
            <Tag color={status?.degraded ? "orange" : "green"}>
              {status?.degraded ? "Требует внимания" : "Работает"}
            </Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Версия WAHA">
            {extractValue(status?.version, ["version", "current"])}
          </Descriptions.Item>
          <Descriptions.Item label="Сессия">
            <Tag color={session.color}>{session.label}</Tag>
          </Descriptions.Item>
          <Descriptions.Item label="Аккаунт">
            {extractValue(status?.account, ["pushName", "id", "name"])}
          </Descriptions.Item>
          <Descriptions.Item label="Последний webhook">
            {formatDate(status?.diagnostics?.lastWebhookAt)}
          </Descriptions.Item>
          <Descriptions.Item label="Сообщений в очереди">
            {queueTotal}
          </Descriptions.Item>
        </Descriptions>
      </Card>
      {!canManage ? (
        <Alert
          type="info"
          showIcon
          message="Режим просмотра"
          description="Для QR и перезапуска нужен доступ whatsapp.manage."
        />
      ) : null}
      <div className="whatsapp-config__actions">
        <Button
          type="primary"
          icon={<QrcodeOutlined />}
          disabled={!canManage}
          loading={action}
          onClick={() => void showQr()}
        >
          Показать QR-код
        </Button>
        <Popconfirm
          title="Принудительно перезапустить WAHA-сессию? Очередь ERP и ограничения WhatsApp сохранятся."
          okText="Перезапустить WAHA"
          cancelText="Отмена"
          onConfirm={() => void restart()}
        >
          <Button
            danger
            icon={<RetweetOutlined />}
            disabled={!canManage}
            loading={action}
          >
            Принудительно перезапустить WAHA
          </Button>
        </Popconfirm>
      </div>
      {qrUrl ? (
        <Card title="QR-код подключения" className="whatsapp-config__qr">
          <img src={qrUrl} alt="QR-код для подключения WhatsApp"
            onError={() => setActionError(whatsappErrorPresentation(
              new ApiError({ code: "WAHA_QR_RESPONSE_INVALID", message: "Invalid QR image", status: 502 }),
              "QR-код повреждён",
            ))} />
          <Text type="secondary">
            Откройте WhatsApp → Связанные устройства → Привязка устройства.
          </Text>
        </Card>
      ) : null}
    </div>
  );
};

export const WhatsAppAutomationConfig: React.FC = () => {
  const canManage =
    !featureFlags.useBackendPermissions || can("whatsapp.manage");
  const [templates, setTemplates] = useState<WhatsAppTemplateDto[]>([]);
  const [rules, setRules] = useState<WhatsAppRuleDto[]>([]);
  const [jobs, setJobs] = useState<WhatsAppDeliveryJobDto[]>([]);
  const [audit, setAudit] = useState<WhatsAppAuditDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [templateEditor, setTemplateEditor] = useState<
    WhatsAppTemplateDto | "new" | null
  >(null);
  const [ruleEditor, setRuleEditor] = useState<WhatsAppRuleDto | "new" | null>(
    null
  );

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [nextTemplates, nextRules, nextJobs, nextAudit] = await Promise.all(
        [
          whatsappApi.templates(),
          whatsappApi.rules(),
          whatsappApi.queue(),
          whatsappApi.audit(),
        ]
      );
      setTemplates(nextTemplates);
      setRules(nextRules);
      setJobs(nextJobs);
      setAudit(nextAudit);
    } catch (loadError) {
      setError(errorText(loadError, "Не удалось загрузить настройки WhatsApp"));
    } finally {
      setLoading(false);
    }
  }, []);
  useEffect(() => {
    void load();
  }, [load]);

  const toggleTemplate = async (
    item: WhatsAppTemplateDto,
    enabled: boolean
  ) => {
    try {
      await whatsappApi.updateTemplate(item.id, {
        version: item.version,
        enabled,
      });
      await load();
    } catch (actionError) {
      message.error(errorText(actionError, "Не удалось изменить шаблон"));
    }
  };
  const toggleRule = async (item: WhatsAppRuleDto, enabled: boolean) => {
    try {
      await whatsappApi.updateRule(item.id, { version: item.version, enabled });
      await load();
    } catch (actionError) {
      message.error(errorText(actionError, "Не удалось изменить правило"));
    }
  };
  const retry = async (id: number) => {
    try {
      await whatsappApi.retryJob(id);
      message.success("Сообщение возвращено в очередь");
      await load();
    } catch (actionError) {
      message.error(errorText(actionError, "Повтор недоступен"));
    }
  };
  const processNow = async () => {
    try {
      await whatsappApi.processNow();
      message.success("Обработка очереди завершена");
      await load();
    } catch (actionError) {
      message.error(errorText(actionError, "Не удалось обработать очередь"));
    }
  };

  if (loading && templates.length === 0 && rules.length === 0)
    return <CenteredSpin />;
  if (error && templates.length === 0 && rules.length === 0)
    return <LoadError messageText={error} onRetry={load} />;

  return (
    <div className="whatsapp-config">
      <header className="whatsapp-config__header">
        <div>
          <Title level={4}>Сообщения и автоматизация</Title>
          <Paragraph type="secondary">
            Ключевые слова, ответы, очередь доставки и журнал действий остаются
            внутри ERP.
          </Paragraph>
        </div>
        <Button
          icon={<ReloadOutlined />}
          loading={loading}
          onClick={() => void load()}
        >
          Обновить
        </Button>
      </header>
      {!canManage ? (
        <Alert
          type="info"
          showIcon
          message="Режим просмотра"
          description="Для изменения правил и очереди нужен доступ whatsapp.manage."
        />
      ) : null}
      {error ? <Alert type="warning" showIcon message={error} /> : null}
      <Tabs
        items={[
          {
            key: "templates",
            label: `Сообщения (${templates.length})`,
            children: (
              <>
                <Toolbar
                  title="Шаблоны ответов"
                  action="Создать сообщение"
                  disabled={!canManage}
                  onAction={() => setTemplateEditor("new")}
                />
                <Table
                  rowKey="id"
                  pagination={false}
                  dataSource={templates}
                  columns={[
                    {
                      title: "Название",
                      dataIndex: "name",
                      render: (_: unknown, item: WhatsAppTemplateDto) => (
                        <Button
                          type="link"
                          className="whatsapp-config__row-link"
                          onClick={() => setTemplateEditor(item)}
                        >
                          {item.name}
                        </Button>
                      ),
                    },
                    { title: "Код", dataIndex: "code", responsive: ["md"] },
                    { title: "Текст", dataIndex: "body", ellipsis: true },
                    {
                      title: "Включено",
                      dataIndex: "enabled",
                      width: 110,
                      render: (enabled: boolean, item: WhatsAppTemplateDto) => (
                        <Switch
                          checked={enabled}
                          disabled={!canManage}
                          onChange={(value) => void toggleTemplate(item, value)}
                        />
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "rules",
            label: `Ключевые слова (${rules.length})`,
            children: (
              <>
                <Toolbar
                  title="Правила ответа"
                  action="Создать правило"
                  disabled={!canManage || templates.length === 0}
                  onAction={() => setRuleEditor("new")}
                />
                <Table
                  rowKey="id"
                  pagination={false}
                  dataSource={rules}
                  columns={[
                    {
                      title: "Правило",
                      dataIndex: "name",
                      render: (_: unknown, item: WhatsAppRuleDto) => (
                        <Button
                          type="link"
                          className="whatsapp-config__row-link"
                          onClick={() => setRuleEditor(item)}
                        >
                          {item.name}
                        </Button>
                      ),
                    },
                    {
                      title: "Ключевые слова",
                      dataIndex: "keywords",
                      render: (values: string[]) => (
                        <Space wrap>
                          {values.map((value) => (
                            <Tag key={value}>{value}</Tag>
                          ))}
                        </Space>
                      ),
                    },
                    {
                      title: "Ответ",
                      dataIndex: "templateName",
                      responsive: ["md"],
                    },
                    {
                      title: "Приоритет",
                      dataIndex: "priority",
                      width: 100,
                      responsive: ["lg"],
                    },
                    {
                      title: "Включено",
                      dataIndex: "enabled",
                      width: 110,
                      render: (enabled: boolean, item: WhatsAppRuleDto) => (
                        <Switch
                          checked={enabled}
                          disabled={!canManage}
                          onChange={(value) => void toggleRule(item, value)}
                        />
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "queue",
            label: `Очередь (${jobs.length})`,
            children: (
              <>
                <Toolbar
                  title="Доставка сообщений"
                  action="Обработать сейчас"
                  disabled={!canManage}
                  onAction={processNow}
                />
                <Table
                  rowKey="id"
                  pagination={{ pageSize: 20 }}
                  dataSource={jobs}
                  columns={[
                    { title: "ID", dataIndex: "id", width: 80 },
                    {
                      title: "Статус",
                      dataIndex: "state",
                      render: (state: string) => <StateTag state={state} />,
                    },
                    {
                      title: "Получатель",
                      dataIndex: "destination",
                      ellipsis: true,
                      responsive: ["md"],
                    },
                    { title: "Сообщение", dataIndex: "body", ellipsis: true },
                    {
                      title: "Попытки",
                      dataIndex: "attemptCount",
                      width: 90,
                      responsive: ["lg"],
                    },
                    {
                      title: "Причина",
                      width: 240,
                      render: (_: unknown, item: WhatsAppDeliveryJobDto) => deliveryErrorText(item),
                    },
                    {
                      title: "",
                      width: 110,
                      render: (_: unknown, item: WhatsAppDeliveryJobDto) =>
                        item.state === "failed" ? (
                          <Button
                            disabled={!canManage}
                            onClick={() => void retry(item.id)}
                          >
                            Повторить
                          </Button>
                        ) : null,
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: "audit",
            label: `Аудит (${audit.length})`,
            children: (
              <>
                <Toolbar title="Журнал WhatsApp" />
                <Table
                  rowKey="auditId"
                  pagination={{ pageSize: 20 }}
                  dataSource={audit}
                  columns={[
                    {
                      title: "Время",
                      dataIndex: "createdAt",
                      render: formatDate,
                    },
                    { title: "Событие", dataIndex: "event" },
                    {
                      title: "Объект",
                      render: (_: unknown, item: WhatsAppAuditDto) =>
                        `${item.entityType} · ${item.entityId}`,
                    },
                    {
                      title: "Пользователь",
                      dataIndex: "username",
                      responsive: ["md"],
                      render: (value: string | null) => value ?? "Система",
                    },
                    {
                      title: "Request ID",
                      dataIndex: "requestId",
                      responsive: ["lg"],
                      ellipsis: true,
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />
      <TemplateEditor
        open={templateEditor}
        onClose={() => setTemplateEditor(null)}
        onSaved={load}
      />
      <RuleEditor
        open={ruleEditor}
        templates={templates}
        onClose={() => setRuleEditor(null)}
        onSaved={load}
      />
    </div>
  );
};

export const WhatsAppTechnicalLogsConfig: React.FC = () => {
  const [rows, setRows] = useState<WhatsAppTechnicalLogDto[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState<WhatsAppTechnicalLogQuery>({ page: 1, pageSize: 100 });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const result = await whatsappApi.technicalLogs(query);
      setRows(result.data);
      setTotal(result.pagination.total);
    } catch (error) {
      message.error(errorText(error, "Не удалось загрузить технический журнал WhatsApp"));
    } finally {
      setLoading(false);
    }
  }, [query]);

  useEffect(() => { void load(); }, [load]);

  const exportLogs = async () => {
    try {
      const result = await whatsappApi.exportTechnicalLogs(query);
      saveBlob(result.blob, result.fileName ?? "whatsapp-technical.jsonl");
    } catch (error) {
      message.error(errorText(error, "Не удалось выгрузить технический журнал"));
    }
  };

  return (
    <div className="whatsapp-config">
      <header className="whatsapp-config__header">
        <div>
          <Title level={4}>Технический журнал WhatsApp</Title>
          <Paragraph type="secondary">События WAHA API, сессии, webhook, relay и cleanup. Хранение 14 дней; сообщения, JID, QR и секреты не записываются.</Paragraph>
        </div>
        <Space wrap>
          <Button icon={<DownloadOutlined />} onClick={() => void exportLogs()}>Выгрузить JSONL</Button>
          <Button icon={<ReloadOutlined />} loading={loading} onClick={() => void load()}>Обновить</Button>
        </Space>
      </header>
      <Space wrap className="whatsapp-config__technical-filters">
        <Select allowClear placeholder="Уровень" style={{ width: 140 }} value={query.level}
          options={["info", "warn", "error"].map((value) => ({ value, label: value }))}
          onChange={(level) => setQuery((current) => ({ ...current, page: 1, level }))} />
        <Select allowClear placeholder="Компонент" style={{ width: 160 }} value={query.component}
          options={["backend", "waha", "webhook", "relay", "cleanup"].map((value) => ({ value, label: value }))}
          onChange={(component) => setQuery((current) => ({ ...current, page: 1, component }))} />
        <Input.Search allowClear placeholder="Событие, операция или код ошибки" style={{ width: 320 }}
          onSearch={(search) => setQuery((current) => ({ ...current, page: 1, search: search || undefined }))} />
      </Space>
      <Table<WhatsAppTechnicalLogDto> rowKey="id" loading={loading} dataSource={rows}
        pagination={{
          current: query.page ?? 1,
          pageSize: query.pageSize ?? 100,
          total,
          showSizeChanger: true,
          pageSizeOptions: [50, 100, 200],
          showTotal: (count) => `Всего: ${count}`,
          onChange: (page, pageSize) => setQuery((current) => ({ ...current, page, pageSize })),
        }}
        scroll={{ x: 1100 }}
        columns={[
          { title: "Время", dataIndex: "occurredAt", width: 180, render: formatDate },
          { title: "Уровень", dataIndex: "level", width: 90, render: (level: string) => <Tag color={level === "error" ? "red" : level === "warn" ? "orange" : "blue"}>{level}</Tag> },
          { title: "Компонент", dataIndex: "component", width: 110 },
          { title: "Событие", dataIndex: "eventCode", width: 210 },
          { title: "Результат", dataIndex: "outcome", width: 110 },
          { title: "Операция", dataIndex: "operation", width: 230 },
          { title: "HTTP", dataIndex: "httpStatus", width: 75 },
          { title: "мс", dataIndex: "durationMs", width: 80 },
          { title: "Ошибка", dataIndex: "errorCode", width: 220 },
        ]} />
    </div>
  );
};

function saveBlob(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = fileName;
  anchor.click();
  URL.revokeObjectURL(url);
}

function TemplateEditor({
  open,
  onClose,
  onSaved,
}: {
  open: WhatsAppTemplateDto | "new" | null;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<WhatsAppTemplateInput>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open)
      form.setFieldsValue(
        open === "new" ? { code: "", name: "", body: "", enabled: true } : open
      );
  }, [form, open]);
  const save = async () => {
    const values = await form.validateFields();
    setSaving(true);
    try {
      if (open === "new") await whatsappApi.createTemplate(values);
      else if (open)
        await whatsappApi.updateTemplate(open.id, {
          ...values,
          version: open.version,
        });
      message.success("Сообщение сохранено");
      onClose();
      await onSaved();
    } catch (error) {
      message.error(errorText(error, "Не удалось сохранить сообщение"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={Boolean(open)}
      title={open === "new" ? "Новое сообщение" : "Редактирование сообщения"}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="code"
          label="Код"
          rules={[
            { required: true },
            {
              pattern: /^[a-z][a-z0-9_]{1,63}$/,
              message: "Латиница, цифры и _; от 2 символов",
            },
          ]}
        >
          <Input disabled={open !== "new"} />
        </Form.Item>
        <Form.Item name="name" label="Название" rules={[{ required: true }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          name="body"
          label="Текст ответа"
          rules={[{ required: true }]}
        >
          <Input.TextArea rows={6} maxLength={4096} showCount />
        </Form.Item>
        <Form.Item name="enabled" label="Включено" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function RuleEditor({
  open,
  templates,
  onClose,
  onSaved,
}: {
  open: WhatsAppRuleDto | "new" | null;
  templates: WhatsAppTemplateDto[];
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [form] = Form.useForm<WhatsAppRuleInput & { keywordText: string }>();
  const [saving, setSaving] = useState(false);
  useEffect(() => {
    if (open)
      form.setFieldsValue(
        open === "new"
          ? {
              code: "",
              name: "",
              matchMode: "contains_any",
              keywordText: "",
              templateId: templates[0]?.id,
              priority: 100,
              enabled: true,
            }
          : { ...open, keywordText: open.keywords.join("\n") }
      );
  }, [form, open, templates]);
  const save = async () => {
    const values = await form.validateFields();
    const { keywordText, ...rest } = values;
    const input = {
      ...rest,
      keywords: keywordText
        .split(/[,\n]/)
        .map((item) => item.trim())
        .filter(Boolean),
    };
    setSaving(true);
    try {
      if (open === "new") await whatsappApi.createRule(input);
      else if (open)
        await whatsappApi.updateRule(open.id, {
          ...input,
          version: open.version,
        });
      message.success("Правило сохранено");
      onClose();
      await onSaved();
    } catch (error) {
      message.error(errorText(error, "Не удалось сохранить правило"));
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      open={Boolean(open)}
      title={open === "new" ? "Новое правило" : "Редактирование правила"}
      okText="Сохранить"
      cancelText="Отмена"
      confirmLoading={saving}
      onOk={() => void save()}
      onCancel={onClose}
      destroyOnClose
    >
      <Form form={form} layout="vertical">
        <Form.Item
          name="code"
          label="Код"
          rules={[
            { required: true },
            {
              pattern: /^[a-z][a-z0-9_]{1,63}$/,
              message: "Латиница, цифры и _; от 2 символов",
            },
          ]}
        >
          <Input disabled={open !== "new"} />
        </Form.Item>
        <Form.Item name="name" label="Название" rules={[{ required: true }]}>
          <Input maxLength={120} />
        </Form.Item>
        <Form.Item
          name="matchMode"
          label="Совпадение"
          rules={[{ required: true }]}
        >
          <Select
            options={[
              { value: "contains_any", label: "Содержит любое слово" },
              { value: "exact_any", label: "Полное совпадение" },
            ]}
          />
        </Form.Item>
        <Form.Item
          name="keywordText"
          label="Ключевые слова"
          extra="По одному в строке или через запятую"
          rules={[{ required: true }]}
        >
          <Input.TextArea rows={4} />
        </Form.Item>
        <Form.Item name="templateId" label="Ответ" rules={[{ required: true }]}>
          <Select
            options={templates.map((item) => ({
              value: item.id,
              label: item.name,
              disabled: !item.enabled,
            }))}
          />
        </Form.Item>
        <Form.Item name="priority" label="Приоритет">
          <InputNumber min={0} max={10000} />
        </Form.Item>
        <Form.Item name="enabled" label="Включено" valuePropName="checked">
          <Switch />
        </Form.Item>
      </Form>
    </Modal>
  );
}

function Toolbar({
  title,
  action,
  disabled,
  onAction,
}: {
  title: string;
  action?: string;
  disabled?: boolean;
  onAction?: () => void | Promise<void>;
}) {
  return (
    <div className="whatsapp-config__toolbar">
      <Title level={5}>{title}</Title>
      {action ? (
        <Button
          type="primary"
          icon={<PlusOutlined />}
          disabled={disabled}
          onClick={() => void onAction?.()}
        >
          {action}
        </Button>
      ) : null}
    </div>
  );
}
function CenteredSpin() {
  return (
    <div className="whatsapp-config__loading">
      <Spin size="large" />
    </div>
  );
}
function LoadError({
  messageText,
  onRetry,
}: {
  messageText: string;
  onRetry: () => void | Promise<void>;
}) {
  return (
    <Alert
      type="error"
      showIcon
      message="WhatsApp недоступен"
      description={messageText}
      action={<Button onClick={() => void onRetry()}>Повторить</Button>}
    />
  );
}
function StateTag({ state }: { state: string }) {
  const color: Record<string, string> = {
    sent: "green",
    failed: "red",
    unknown: "orange",
    processing: "blue",
    retry_wait: "gold",
  };
  const label: Record<string, string> = {
    pending: "Ожидает",
    processing: "Отправляется",
    retry_wait: "Ожидает повтора",
    sent: "Отправлено",
    failed: "Ошибка",
    unknown: "Требует проверки",
  };
  return <Tag color={color[state]}>{label[state] ?? "Неизвестно"}</Tag>;
}
function formatDate(value: string | null | undefined) {
  return value
    ? new Intl.DateTimeFormat("ru-RU", {
        dateStyle: "short",
        timeStyle: "short",
      }).format(new Date(value))
    : "Нет данных";
}
function extractValue(value: unknown, keys: string[]) {
  if (typeof value === "string" || typeof value === "number")
    return String(value);
  if (value && typeof value === "object") {
    const record = value as Record<string, unknown>;
    for (const key of keys)
      if (typeof record[key] === "string" || typeof record[key] === "number")
        return String(record[key]);
  }
  return "Нет данных";
}
export function whatsappErrorPresentation(error: unknown, fallback: string): UserFacingError {
  if (!isApiError(error)) {
    return {
      title: fallback,
      description: error instanceof TypeError
        ? "Нет соединения с backend. Проверьте сеть и повторите действие."
        : "Повторите действие. Если ошибка сохранится, откройте технический журнал WhatsApp.",
    };
  }
  const messages: Record<string, UserFacingError> = {
    AUTH_REQUIRED: { title: "Сеанс ERP завершён", description: "Войдите в ERP заново и повторите действие." },
    PERMISSION_DENIED: { title: "Недостаточно прав", description: "Нужно разрешение whatsapp.manage. Обратитесь к администратору ERP." },
    WHATSAPP_NOT_CONFIGURED: { title: "WhatsApp не настроен", description: "Интеграция выключена или не заполнены параметры WAHA на сервере." },
    WAHA_UNAVAILABLE: { title: "WAHA не отвечает", description: "Сервис недоступен или перезапускается. Подождите несколько секунд и обновите статус." },
    WAHA_PROVIDER_ERROR: { title: "WAHA отклонил запрос", description: "Обновите данные и повторите действие. Если ошибка сохранится, проверьте технический журнал WhatsApp." },
    WAHA_QR_RESPONSE_INVALID: { title: "WAHA вернул некорректный QR-код", description: "ERP не будет показывать повреждённое изображение. Перезапустите WAHA и повторите запрос; подробности находятся в техническом журнале." },
    WHATSAPP_RESTRICTION_CONFIRMATION_REQUIRED: { title: "Нужно подтверждение ограничений", description: "Перезапуск не снимает message capping или timelock. Подтвердите принудительный перезапуск ещё раз." },
    WHATSAPP_VERSION_CONFLICT: { title: "Запись уже изменена", description: "Обновите страницу и повторите изменение с актуальной версией." },
    WHATSAPP_RETRY_NOT_ALLOWED: { title: "Повтор запрещён", description: "Вручную повторять можно только задания со статусом «Ошибка». Обновите очередь." },
    WHATSAPP_TEMPLATE_NOT_FOUND: { title: "Шаблон не найден", description: "Выбранный шаблон удалён или недоступен. Обновите список и выберите другой." },
    WHATSAPP_NOT_FOUND: { title: "Запись не найдена", description: "Запись уже удалена или изменена другим пользователем. Обновите страницу." },
    VALIDATION_ERROR: { title: "Проверьте введённые данные", description: "Одно или несколько полей заполнены неверно. Исправьте отмеченные значения." },
    INVALID_WHATSAPP_TECHNICAL_LOG_QUERY: { title: "Некорректные фильтры журнала", description: "Сбросьте фильтры и повторите запрос." },
    RATE_LIMIT_EXCEEDED: { title: "Слишком много запросов", description: "Подождите несколько секунд и повторите действие." },
    INTERNAL_ERROR: { title: "Внутренняя ошибка ERP", description: "Повторите действие. Если ошибка сохранится, передайте Request ID администратору." },
  };
  const selected = messages[error.code] ?? (
    error.status === 422
      ? { title: "Действие сейчас невозможно", description: "Состояние WhatsApp изменилось. Обновите статус и повторите действие." }
      : error.status >= 500
        ? { title: "Сервис временно недоступен", description: "Повторите действие позже и проверьте технический журнал WhatsApp." }
        : { title: fallback, description: "Обновите данные и повторите действие." }
  );
  return {
    ...selected,
    description: error.requestId ? `${selected.description} Request ID: ${error.requestId}` : selected.description,
  };
}

export function qrErrorPresentation(error: unknown): UserFacingError {
  if (isApiError(error) && error.code === "WAHA_PROVIDER_ERROR") {
    return withRequestId({
      title: "QR-код сейчас недоступен",
      description: "Сессия не ожидает сканирования или срок QR истёк. Нажмите «Принудительно перезапустить WAHA», затем сразу запросите новый QR.",
    }, error.requestId);
  }
  return whatsappErrorPresentation(error, "Не удалось получить QR-код");
}

export function restartErrorPresentation(error: unknown): UserFacingError {
  if (isApiError(error) && error.code === "WAHA_PROVIDER_ERROR") {
    return withRequestId({
      title: "WAHA не принял перезапуск",
      description: "Обновите статус и повторите действие. Если ошибка сохранится, откройте технический журнал WhatsApp.",
    }, error.requestId);
  }
  return whatsappErrorPresentation(error, "Не удалось перезапустить WAHA");
}

function withRequestId(value: UserFacingError, requestId?: string): UserFacingError {
  return {
    ...value,
    description: requestId ? `${value.description} Request ID: ${requestId}` : value.description,
  };
}

export function whatsappSessionPresentation(value: unknown, issues?: Record<string, string | null>) {
  const providerIssue = issues?.health ?? issues?.session;
  if (providerIssue === "WAHA_UNAVAILABLE") return {
    label: "WAHA недоступен", color: "red",
    notice: { type: "error" as const, title: "WAHA не отвечает", description: "Сервис остановлен, перезапускается или недоступен по внутренней сети. Повторите проверку; если ошибка сохранится, обратитесь к администратору VPS." },
  };
  if (providerIssue === "WAHA_PROVIDER_ERROR") return {
    label: "Ошибка WAHA", color: "red",
    notice: { type: "error" as const, title: "WAHA отклонил запрос состояния", description: "Принудительно перезапустите WAHA. Если ошибка повторится, откройте технический журнал." },
  };
  const raw = extractValue(value, ["status"]);
  const status = raw === "Нет данных" ? "UNKNOWN" : raw.toUpperCase();
  if (status === "WORKING") return { label: "Подключена", color: "green", notice: null };
  if (status === "SCAN_QR_CODE") return {
    label: "Ожидает QR", color: "blue",
    notice: { type: "info" as const, title: "Ожидается сканирование QR-кода", description: "Запросите QR и отсканируйте его сразу: код действует ограниченное время." },
  };
  if (status === "STARTING") return {
    label: "Запускается", color: "processing",
    notice: { type: "info" as const, title: "WAHA запускается", description: "Подождите несколько секунд и обновите статус." },
  };
  if (status === "FAILED") return {
    label: "Ошибка", color: "red",
    notice: { type: "error" as const, title: "WhatsApp-сессия остановлена", description: "QR мог истечь либо GOWS завершил сессию с ошибкой. Принудительно перезапустите WAHA и сразу запросите новый QR." },
  };
  if (status === "STOPPED") return {
    label: "Остановлена", color: "default",
    notice: { type: "warning" as const, title: "WhatsApp-сессия остановлена", description: "Принудительно перезапустите WAHA, чтобы возобновить подключение." },
  };
  return {
    label: "Нет данных", color: "default",
    notice: { type: "warning" as const, title: "Состояние сессии неизвестно", description: "Обновите статус. Если состояние не появится, проверьте технический журнал WhatsApp." },
  };
}

function deliveryErrorText(item: WhatsAppDeliveryJobDto): string {
  if (!item.errorCode) return "—";
  const messages: Record<string, string> = {
    INVALID_JOB: "Некорректное задание",
    MAX_ATTEMPTS: "Исчерпаны попытки",
    STALE_BEFORE_DISPATCH: "Отправка не началась; ожидается повтор",
    STALE_AFTER_DISPATCH: "Результат отправки неизвестен; автоматический повтор запрещён",
    WAHA_UNAVAILABLE: "WAHA не отвечал во время отправки",
    WAHA_PROVIDER_ERROR: "WAHA отклонил отправку",
  };
  return messages[item.errorCode] ?? "Техническая ошибка; см. журнал";
}

function restrictionLabel(value: string): string {
  return value === "message_capping" ? "лимит отправки сообщений"
    : value === "reachout_timelock" ? "временный запрет новых диалогов"
      : "ограничение WhatsApp";
}

function errorText(error: unknown, fallback: string) {
  const presentation = whatsappErrorPresentation(error, fallback);
  return `${presentation.title}. ${presentation.description}`;
}
