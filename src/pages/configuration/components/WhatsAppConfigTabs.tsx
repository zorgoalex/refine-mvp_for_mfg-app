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
  QrcodeOutlined,
  ReloadOutlined,
  RetweetOutlined,
} from "@ant-design/icons";
import { Table } from "../../../ui/tooltipDelay";
import { whatsappApi } from "../../../api/whatsappApi";
import { featureFlags } from "../../../config/featureFlags";
import type {
  WhatsAppAuditDto,
  WhatsAppDeliveryJobDto,
  WhatsAppRuleDto,
  WhatsAppRuleInput,
  WhatsAppStatusDto,
  WhatsAppTemplateDto,
  WhatsAppTemplateInput,
} from "../../../api/types/whatsappApi.types";
import { can } from "../../../utils/permissions";
import "./WhatsAppConfigTabs.css";

const { Paragraph, Text, Title } = Typography;

export const WhatsAppConnectionConfig: React.FC = () => {
  const canManage =
    !featureFlags.useBackendPermissions || can("whatsapp.manage");
  const [status, setStatus] = useState<WhatsAppStatusDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [qrUrl, setQrUrl] = useState<string | null>(null);
  const [action, setAction] = useState(false);

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
    try {
      const blob = await whatsappApi.qr();
      setQrUrl((current) => {
        if (current) URL.revokeObjectURL(current);
        return URL.createObjectURL(blob);
      });
    } catch (actionError) {
      message.error(errorText(actionError, "Не удалось получить QR-код"));
    } finally {
      setAction(false);
    }
  };

  const restart = async () => {
    setAction(true);
    try {
      await whatsappApi.restart(Boolean(status?.restrictions.length));
      message.success("Перезапуск сессии запрошен");
      await load();
    } catch (actionError) {
      message.error(errorText(actionError, "Не удалось перезапустить сессию"));
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
          description={`Перезапуск их не снимет: ${status.restrictions.join(
            ", "
          )}.`}
        />
      ) : null}
      {error ? <Alert type="warning" showIcon message={error} /> : null}
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
            {extractValue(status?.session, ["status", "name"])}
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
          title="Перезапустить WhatsApp-сессию? Активные timelock и capping сохранятся."
          okText="Перезапустить"
          cancelText="Отмена"
          onConfirm={() => void restart()}
        >
          <Button
            danger
            icon={<RetweetOutlined />}
            disabled={!canManage}
            loading={action}
          >
            Перезапустить сессию
          </Button>
        </Popconfirm>
      </div>
      {qrUrl ? (
        <Card title="QR-код подключения" className="whatsapp-config__qr">
          <img src={qrUrl} alt="QR-код для подключения WhatsApp" />
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
                  onAction={async () => {
                    await whatsappApi.processNow();
                    await load();
                  }}
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
  return <Tag color={color[state]}>{state}</Tag>;
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
function errorText(error: unknown, fallback: string) {
  return error instanceof Error ? error.message : fallback;
}
