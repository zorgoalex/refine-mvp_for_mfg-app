import { useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Select, Space, Typography, message } from 'antd';
import { DeleteOutlined, PlusOutlined, StarFilled } from '@ant-design/icons';
import { isApiError } from '../../api/apiError';
import { clientContactsApi, type ClientContactsRow, type ClientPhoneType } from '../../api/clientContactsApi';
import type { EmployeeContactKind } from '../../api/employeeContactsApiTypes';
import { EMPLOYEE_CONTACT_KIND_LABELS, formatContact } from '../../components/contacts/contactsModel';
import {
  PHONE_TYPE_LABELS, PHONES_MAX, addKindDraft, addPhoneDraft, keyFor, kindDraftToSet, kindToDraft, phoneDraftToLines, phoneLines, phonesToDraft,
  rebaseKindDraft, rebasePhoneDraft, removeKindDraft, removePhoneDraft, setKindPrimary, setPhonePrimary, type KindDraft, type PhoneDraft,
} from './clientContactsModel';

const PLACEHOLDERS: Partial<Record<EmployeeContactKind, string>> = {
  email: 'name@mebel.kz', telegram: '@username', whatsapp: '+7 701 555 01 01', viber: '+7 701 555 01 01', instagram: '@account', other: 'vk.com/…',
};
const STAR = <StarFilled style={{ color: '#faad14' }} />;
const newKey = () => (globalThis.crypto?.randomUUID ? globalThis.crypto.randomUUID() : `cc-${Date.now()}-${Math.random().toString(36).slice(2)}`);

interface EditorProps {
  row: ClientContactsRow;
  onSaved: (row: ClientContactsRow) => void;
  onClose: () => void;
}

/** The phones of one client: the whole set is saved at once against the set this editor started from. */
export function PhonesEditor({ row, onSaved, onClose }: EditorProps) {
  const [base, setBase] = useState(row);
  const [rows, setRows] = useState<PhoneDraft[]>(() => phonesToDraft(row.phones));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const attempt = useRef<{ signature: string; key: string } | null>(null);

  const save = async () => {
    const body = phoneDraftToLines(rows);
    if ('error' in body) { message.error(body.error); return; }
    const expected = phoneLines(base.phones);
    attempt.current = keyFor(attempt.current, JSON.stringify({ expected, phones: body.phones }), newKey);
    setSaving(true);
    try {
      onSaved((await clientContactsApi.replacePhones(base.client.id, { idempotencyKey: attempt.current.key, expected, phones: body.phones })).row);
      message.success('Телефоны сохранены');
      onClose();
    } catch (error) {
      if (isApiError(error, 'CLIENT_PHONES_STALE')) {
        const fresh = await clientContactsApi.row(base.client.id);
        onSaved(fresh);
        setBase(fresh);
        setRows((current) => rebasePhoneDraft(current, fresh.phones));
        setConflict(true);
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить телефоны');
      }
    } finally {
      setSaving(false);
    }
  };

  const patch = (rowKey: string, fields: Partial<PhoneDraft>) => setRows(rows.map((item) => (item.rowKey === rowKey ? { ...item, ...fields } : item)));
  return (
    <Modal open title={`Телефоны: ${row.client.name}`} okText="Сохранить" cancelText="Отмена" confirmLoading={saving}
      onOk={() => { void save(); }} onCancel={onClose} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        {conflict ? (
          <Alert type="warning" showIcon message="Телефоны клиента уже изменились"
            description={<>Сейчас сохранено: {base.phones.map((phone) => phone.phoneNumber).join(', ') || 'нет телефонов'}. Ниже — ваш вариант; проверьте и сохраните снова.</>} />
        ) : null}
        {rows.map((item) => (
          <div key={item.rowKey} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Input value={item.phoneNumber} maxLength={20} placeholder="+7 701 555 01 01" style={{ flex: '1 1 160px', minWidth: 0 }}
              onChange={(event) => patch(item.rowKey, { phoneNumber: event.target.value })} />
            <Select<ClientPhoneType> value={item.phoneType} style={{ width: 130 }} onChange={(phoneType) => patch(item.rowKey, { phoneType })}
              options={Object.entries(PHONE_TYPE_LABELS).map(([value, label]) => ({ value: value as ClientPhoneType, label }))} />
            <Checkbox checked={item.isPrimary} onChange={() => setRows(setPhonePrimary(rows, item.rowKey))}>{item.isPrimary ? <>{STAR} основной</> : 'основной'}</Checkbox>
            <Button aria-label="Удалить телефон" icon={<DeleteOutlined />} danger type="text" onClick={() => setRows(removePhoneDraft(rows, item.rowKey))} />
          </div>
        ))}
        <Button size="small" icon={<PlusOutlined />} disabled={rows.length >= PHONES_MAX} onClick={() => setRows(addPhoneDraft(rows))}>Телефон</Button>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>Телефоны клиента уходят в Bitrix24 и используются для отправки заказа в WhatsApp.</Typography.Text>
      </Space>
    </Modal>
  );
}

/** The contacts of one kind of a client; the save sends the whole set (the other kinds as they are) with its version. */
export function KindEditor({ row, kind, kinds, onSaved, onClose }: EditorProps & { kind: EmployeeContactKind; kinds: readonly EmployeeContactKind[] }) {
  const [base, setBase] = useState(row);
  const [rows, setRows] = useState<KindDraft[]>(() => kindToDraft(row, kind));
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const label = EMPLOYEE_CONTACT_KIND_LABELS[kind];
  // A switched-off kind: stored values may stay or go, nothing new is taken (the backend says so too).
  const canAdd = kinds.includes(kind);

  const save = async () => {
    const body = kindDraftToSet(base, kind, rows);
    if ('error' in body) { message.error(body.error); return; }
    setSaving(true);
    try {
      onSaved(await clientContactsApi.replaceContacts(base.client.id, { version: base.contactsVersion, contacts: body.contacts }));
      message.success('Контакты сохранены');
      onClose();
    } catch (error) {
      if (isApiError(error, 'PARTY_CONTACTS_VERSION_CONFLICT')) {
        const fresh = await clientContactsApi.row(base.client.id);
        onSaved(fresh);
        setBase(fresh);
        setRows((current) => rebaseKindDraft(current, fresh, kind));
        setConflict(true);
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось сохранить контакты');
      }
    } finally {
      setSaving(false);
    }
  };

  const patch = (rowKey: string, fields: Partial<KindDraft>) => setRows(rows.map((item) => (item.rowKey === rowKey ? { ...item, ...fields } : item)));
  const current = base.contacts.filter((contact) => contact.kind === kind);
  return (
    <Modal open title={`${label}: ${row.client.name}`} okText="Сохранить" cancelText="Отмена" confirmLoading={saving}
      onOk={() => { void save(); }} onCancel={onClose} destroyOnClose>
      <Space direction="vertical" style={{ width: '100%' }}>
        {conflict ? (
          <Alert type="warning" showIcon message="Контакты клиента уже изменились"
            description={<>Сейчас сохранено: {current.map((contact) => formatContact(contact)).join(', ') || 'ничего'}. Ниже — ваш вариант; проверьте и сохраните снова.</>} />
        ) : null}
        {!canAdd ? <Alert type="info" showIcon message={`Вид «${label}» сейчас не ведётся: сохранённые значения можно оставить или удалить`} /> : null}
        {rows.map((item) => (
          <div key={item.rowKey} style={{ display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center' }}>
            <Input value={item.value} maxLength={200} placeholder={PLACEHOLDERS[kind]} style={{ flex: '1 1 180px', minWidth: 0 }}
              disabled={!canAdd && item.contactId !== null} onChange={(event) => patch(item.rowKey, { value: event.target.value })} />
            <Input value={item.note} maxLength={200} placeholder={kind === 'other' ? 'Подпись (например, VK)' : 'Примечание'}
              style={{ flex: '1 1 140px', minWidth: 0 }} disabled={!canAdd && item.contactId !== null}
              onChange={(event) => patch(item.rowKey, { note: event.target.value })} />
            <Checkbox checked={item.isPrimary} onChange={() => setRows(setKindPrimary(rows, item.rowKey))}>{item.isPrimary ? <>{STAR} основной</> : 'основной'}</Checkbox>
            <Button aria-label="Удалить контакт" icon={<DeleteOutlined />} danger type="text" onClick={() => setRows(removeKindDraft(rows, item.rowKey))} />
          </div>
        ))}
        {canAdd ? <Button size="small" icon={<PlusOutlined />} onClick={() => setRows(addKindDraft(rows))}>{label}</Button> : null}
      </Space>
    </Modal>
  );
}
