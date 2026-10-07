import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, List, Popconfirm, Select, Space, Tag, Typography, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { partyContactsApi, type ClientCounterparty, type ClientLink } from '../../api/partyContactsApi';
import {
  CLIENT_COUNTERPARTY_CONFLICT, clientLinkErrorMessage, counterpartyDetails, counterpartyOptions, isCounterpartyApiMissing,
  matchReasons, takenBy,
} from './clientCounterpartyModel';

interface Props {
  clientId: number | null | undefined;
  /** clients.update: may link and unlink; otherwise read-only. */
  editable: boolean;
}

/**
 * «Контрагент 1С» of a client: one counterparty for a client, one client for a counterparty. The link is
 * changed only by the backend command (checked against the loaded 1C data, audited); the form of the client
 * no longer carries the key.
 */
export const ClientCounterpartyCard: React.FC<Props> = ({ clientId, editable }) => {
  const [link, setLink] = useState<ClientLink | null>(null);
  const [suggestions, setSuggestions] = useState<ClientCounterparty[]>([]);
  const [found, setFound] = useState<ClientCounterparty[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(0);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      setLink(await partyContactsApi.clientCounterparty(clientId));
      setChoice(null);
      setLoadError(null);
    } catch (error) {
      if (isCounterpartyApiMissing(error)) { setUnsupported(true); return; }
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить сопоставление');
    }
  }, [clientId]);

  const suggest = useCallback(async () => {
    if (!clientId) return;
    try {
      setSuggestions((await partyContactsApi.clientCounterpartyCandidates(clientId)).items);
    } catch {
      setSuggestions([]);
    }
  }, [clientId]);

  const search = useCallback(async (text: string) => {
    if (!clientId) return;
    const epoch = ++searchRef.current;
    if (!text.trim()) { setFound([]); setSearching(false); return; }
    setSearching(true);
    try {
      const result = await partyContactsApi.clientCounterpartyCandidates(clientId, text);
      if (epoch === searchRef.current) setFound(result.items);
    } catch {
      if (epoch === searchRef.current) setFound([]);
    } finally {
      if (epoch === searchRef.current) setSearching(false);
    }
  }, [clientId]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (editable) void suggest(); }, [editable, suggest]);

  const change = async (refKey1c: string | null) => {
    if (!clientId || !link || saving) return;
    setSaving(true);
    try {
      setLink(await partyContactsApi.setClientCounterparty(clientId, { refKey1c, expectedRefKey1c: link.refKey1c }));
      setChoice(null);
      setFound([]);
      message.success(refKey1c ? 'Клиент сопоставлен с контрагентом 1С' : 'Сопоставление с контрагентом 1С снято');
      void suggest();
    } catch (error) {
      if (isApiError(error, CLIENT_COUNTERPARTY_CONFLICT)) {
        message.warning('Сопоставление уже изменил другой пользователь — показано текущее значение');
        await load();
      } else {
        message.error(clientLinkErrorMessage(error));
      }
      void suggest();
    } finally {
      setSaving(false);
    }
  };

  if (!clientId || unsupported) return null;
  const title = 'Контрагент 1С';
  if (loadError) return <Card title={title} size="small"><Alert type="error" showIcon message={loadError} /></Card>;

  const linked = link?.counterparty ?? null;
  const offered = suggestions.filter((item) => item.refKey1c !== link?.refKey1c);
  const confirmText = link?.refKey1c
    ? 'Заменить контрагента 1С у этого клиента?'
    : 'Сопоставить клиента с этим контрагентом 1С?';

  const current = !link?.refKey1c
    ? <Typography.Text type="secondary">Не сопоставлен</Typography.Text>
    : linked
      ? (
        <Space direction="vertical" size={0}>
          <Space size={8} wrap>
            <Typography.Text strong>{linked.name}</Typography.Text>
            <Tag color="green">Сопоставлен</Tag>
            {linked.isBuyer === false ? <Tag>не покупатель в 1С</Tag> : null}
          </Space>
          {counterpartyDetails(linked) ? <Typography.Text type="secondary">{counterpartyDetails(linked)}</Typography.Text> : null}
        </Space>
      )
      : link.available
        ? (
          <Alert
            type="warning"
            showIcon
            message="Сохранённый ключ 1С не найден среди загруженных контрагентов"
            description={`Ключ ${link.refKey1c}: контрагент удалён или помечен на удаление в 1С. Выберите контрагента заново или снимите сопоставление.`}
          />
        )
        : <Typography.Text>{link.refKey1c}</Typography.Text>;

  return (
    <Card title={title} size="small" loading={!link}>
      <Space direction="vertical" style={{ width: '100%' }} size={12}>
        <div>{current}</div>
        {link && !link.available ? (
          <Typography.Text type="secondary">Контрагенты 1С ещё не загружены — выбрать не из чего.</Typography.Text>
        ) : null}
        {editable && link?.available && offered.length > 0 ? (
          <List
            size="small"
            bordered
            header={<Typography.Text type="secondary">Похожие контрагенты 1С</Typography.Text>}
            dataSource={offered}
            rowKey={(item) => item.refKey1c}
            renderItem={(item) => {
              const other = takenBy(item, clientId);
              return (
                <List.Item
                  actions={[other ? (
                    <Typography.Text key="taken" type="secondary">у клиента «{other}»</Typography.Text>
                  ) : (
                    <Popconfirm
                      key="link"
                      title={confirmText}
                      okText={link.refKey1c ? 'Заменить' : 'Сопоставить'}
                      cancelText="Отмена"
                      disabled={saving}
                      onConfirm={() => { void change(item.refKey1c); }}
                    >
                      <Button size="small" type="primary" disabled={saving}>{link.refKey1c ? 'Заменить на этого' : 'Сопоставить'}</Button>
                    </Popconfirm>
                  )]}
                >
                  <List.Item.Meta
                    title={<Space size={8} wrap><span>{item.name}</span>{matchReasons(item.matchedBy) ? <Tag color="blue">{matchReasons(item.matchedBy)}</Tag> : null}</Space>}
                    description={counterpartyDetails(item) || undefined}
                  />
                </List.Item>
              );
            }}
          />
        ) : null}
        {editable && link?.available ? (
          <Space wrap>
            <Select
              showSearch
              allowClear
              filterOption={false}
              disabled={saving}
              loading={searching}
              style={{ minWidth: 420 }}
              placeholder="Найти контрагента 1С: название, код, БИН/ИИН или телефон"
              notFoundContent={searching ? 'Поиск…' : 'Введите название, код, БИН/ИИН или телефон'}
              value={choice}
              options={counterpartyOptions(found, clientId)}
              onSearch={(text) => { void search(text); }}
              onChange={(value) => setChoice(value ?? null)}
            />
            <Popconfirm
              title={confirmText}
              okText={link.refKey1c ? 'Заменить' : 'Сопоставить'}
              cancelText="Отмена"
              disabled={!choice || saving}
              onConfirm={() => { void change(choice); }}
            >
              <Button type="primary" disabled={!choice || saving} loading={saving}>{link.refKey1c ? 'Заменить' : 'Сопоставить'}</Button>
            </Popconfirm>
          </Space>
        ) : null}
        {editable && link?.refKey1c ? (
          <Popconfirm
            title="Снять сопоставление с контрагентом 1С?"
            okText="Снять"
            cancelText="Отмена"
            disabled={saving}
            onConfirm={() => { void change(null); }}
          >
            <Button danger disabled={saving}>Снять сопоставление</Button>
          </Popconfirm>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          У клиента — один контрагент 1С, у контрагента — один клиент. Связь будет использоваться для учёта документов контрагента 1С по клиенту.
        </Typography.Text>
      </Space>
    </Card>
  );
};
