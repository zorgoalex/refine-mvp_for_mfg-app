import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { Alert, Button, Card, Checkbox, Empty, Input, Select, Space, Tag, Typography, message } from 'antd';
import { DeleteOutlined, PlusOutlined, StarFilled } from '@ant-design/icons';
import type { EmployeeContact, EmployeeContactInput, EmployeeContactKind } from '../../api/employeeContactsApiTypes';
import { isApiError } from '../../api/apiError';
import {
  EMPLOYEE_CONTACT_KIND_LABELS, EMPLOYEE_CONTACTS_MAX,
  addDraftRow, contactValueMaxLength, changeDraftKind, isContactsApiMissing, contactsToDraft, draftToInput, formatContact, removeDraftRow, setDraftPrimary, sortContacts,
  type EmployeeContactDraft,
} from './contactsModel';

const PLACEHOLDERS = { phone: '+7 701 555 01 01', email: 'name@mebel.kz', telegram: '@username', address: 'Город, улица, дом' } as const;
const FROM_ONEC_TAG = <Tag color="blue">из 1С</Tag>;

/** Where a contact set lives: employees, suppliers, vendors and clients each bring their own API. */
export interface ContactsSource {
  load: (ownerId: number) => Promise<{ version: number; contacts: EmployeeContact[] }>;
  save: (ownerId: number, body: { version: number; contacts: EmployeeContactInput[] }) => Promise<{ version: number; contacts: EmployeeContact[] }>;
  /** The API code of a stale set version. */
  conflictCode: string;
  /** Kinds this owner keeps here (a client's phones live in the client phones list). */
  kinds: readonly EmployeeContactKind[];
  title: string;
  /** The grey line under the editor. */
  hint: ReactNode;
}

interface Props {
  ownerId: number | null | undefined;
  /** The editor; otherwise the read-only list. */
  editable: boolean;
  source: ContactsSource;
  /** A change of it reloads the set (e.g. after a sync with 1C made elsewhere on the page). */
  reloadToken?: number;
  /** Unsaved edits appear or go: the page holds back actions that would reload the set over them. */
  onDirtyChange?: (dirty: boolean) => void;
  /** Another block of the page is changing these contacts (a sync with 1C, a link change): editing waits. */
  locked?: boolean;
}

/** Contacts of an owner: phones, emails, Telegram accounts; one «основной» per kind. */
export const ContactsCard: React.FC<Props> = ({ ownerId, editable, source, reloadToken = 0, onDirtyChange, locked = false }) => {
  const [data, setData] = useState<{ version: number; contacts: EmployeeContact[] } | null>(null);
  const [rows, setRows] = useState<EmployeeContactDraft[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [reloading, setReloading] = useState(false);
  // Only the latest load applies its answer and ends «reloading» (loads may overlap: an owner change, a reload).
  const loadGeneration = useRef(0);

  const load = useCallback(async () => {
    if (!ownerId) return;
    const generation = ++loadGeneration.current;
    setReloading(true);
    try {
      const result = await source.load(ownerId);
      if (generation !== loadGeneration.current) return;
      setData(result);
      setRows(contactsToDraft(sortContacts(result.contacts)));
      setDirty(false);
      setLoadError(null);
    } catch (error) {
      if (generation !== loadGeneration.current) return;
      if (isContactsApiMissing(error)) { setUnsupported(true); return; }
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить контакты');
    } finally {
      if (generation === loadGeneration.current) setReloading(false);
    }
    // reloadToken: a reload on demand of the page.
  }, [ownerId, source, reloadToken]);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);

  // While a save, a reload or a change from another block of the page is in flight the set is locked: the answer
  // replaces the rows, so later edits would be lost.
  const busy = saving || reloading || locked;
  const change = (next: EmployeeContactDraft[]) => { if (busy) return; setRows(next); setDirty(true); };
  const patch = (key: string, fields: Partial<EmployeeContactDraft>) =>
    change(rows.map((row) => (row.rowKey === key ? { ...row, ...fields } : row)));

  const save = async () => {
    if (!ownerId || !data) return;
    const body = draftToInput(rows);
    if ('error' in body) { message.error(body.error); return; }
    setSaving(true);
    try {
      const result = await source.save(ownerId, { version: data.version, contacts: body.contacts });
      setData(result);
      setRows(contactsToDraft(sortContacts(result.contacts)));
      setDirty(false);
      message.success('Контакты сохранены');
    } catch (error) {
      if (isApiError(error, source.conflictCode)) {
        message.warning('Контакты уже изменил другой пользователь — загружена свежая версия');
        await load();
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить контакты');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!ownerId || unsupported) return null;
  const title = source.title;
  if (loadError) return <Card title={title} size="small"><Alert type="error" showIcon message={loadError} /></Card>;

  if (!editable) {
    const contacts = sortContacts(data?.contacts ?? []);
    return (
      <Card title={title} size="small" loading={!data}>
        {contacts.length === 0 ? <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Контактов нет" /> : (
          <Space direction="vertical" size={4}>
            {contacts.map((contact) => (
              <Space key={contact.contactId} size={8} wrap>
                <Typography.Text type="secondary">{EMPLOYEE_CONTACT_KIND_LABELS[contact.kind]}</Typography.Text>
                <Typography.Text copyable>{formatContact(contact)}</Typography.Text>
                {contact.isPrimary ? <Tag color="gold">основной</Tag> : null}
                {contact.origin === 'onec' ? FROM_ONEC_TAG : null}
                {contact.note ? <Typography.Text type="secondary">{contact.note}</Typography.Text> : null}
              </Space>
            ))}
          </Space>
        )}
      </Card>
    );
  }

  return (
    <Card
      title={title}
      size="small"
      loading={!data}
      extra={<Button type="primary" size="small" loading={saving} disabled={!dirty || reloading || locked} onClick={() => { void save(); }}>Сохранить контакты</Button>}
    >
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        {rows.length === 0 ? <Typography.Text type="secondary">Контактов нет</Typography.Text> : null}
        {rows.map((row) => row.fromOnec ? (
          // A contact from 1C: its value lives in 1C; here only «основной» moves.
          <div key={row.rowKey} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Typography.Text type="secondary" style={{ width: 120 }}>{EMPLOYEE_CONTACT_KIND_LABELS[row.kind]}</Typography.Text>
            <Typography.Text style={{ flex: '1 1 200px', minWidth: 0 }}>
              {formatContact({ kind: row.kind, value: row.value, valueNormalized: row.value })} {FROM_ONEC_TAG}
            </Typography.Text>
            <Checkbox disabled={busy} checked={row.isPrimary} onChange={() => change(setDraftPrimary(rows, row.rowKey))}>
              {row.isPrimary ? <><StarFilled style={{ color: '#faad14' }} /> основной</> : 'основной'}
            </Checkbox>
          </div>
        ) : (
          <div key={row.rowKey} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Select
              disabled={busy}
              value={row.kind}
              style={{ width: 120 }}
              options={source.kinds.map((kind) => ({ value: kind, label: EMPLOYEE_CONTACT_KIND_LABELS[kind] }))}
              onChange={(kind) => change(changeDraftKind(rows, row.rowKey, kind))}
            />
            <Input
              disabled={busy}
              value={row.value}
              maxLength={contactValueMaxLength(row.kind)}
              placeholder={PLACEHOLDERS[row.kind]}
              style={{ flex: '1 1 200px', minWidth: 0 }}
              onChange={(event) => patch(row.rowKey, { value: event.target.value })}
            />
            <Checkbox disabled={busy} checked={row.isPrimary} onChange={() => change(setDraftPrimary(rows, row.rowKey))}>
              {row.isPrimary ? <><StarFilled style={{ color: '#faad14' }} /> основной</> : 'основной'}
            </Checkbox>
            <Input
              disabled={busy}
              value={row.note}
              maxLength={200}
              placeholder="Примечание"
              style={{ flex: '1 1 160px', minWidth: 0 }}
              onChange={(event) => patch(row.rowKey, { note: event.target.value })}
            />
            <Button aria-label="Удалить контакт" disabled={busy} icon={<DeleteOutlined />} danger type="text" onClick={() => change(removeDraftRow(rows, row.rowKey))} />
          </div>
        ))}
        <Space wrap>
          {source.kinds.map((kind) => (
            <Button key={kind} size="small" icon={<PlusOutlined />} disabled={busy || rows.filter((row) => !row.fromOnec).length >= EMPLOYEE_CONTACTS_MAX}
              onClick={() => change(addDraftRow(rows, kind))}>
              {EMPLOYEE_CONTACT_KIND_LABELS[kind]}
            </Button>
          ))}
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {source.hint}
        </Typography.Text>
      </Space>
    </Card>
  );
};
