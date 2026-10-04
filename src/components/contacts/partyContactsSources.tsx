import { partyContactsApi, type PartyKind } from '../../api/partyContactsApi';
import type { ContactsSource } from './ContactsCard';

const source = (party: PartyKind, fields: Pick<ContactsSource, 'kinds' | 'title' | 'hint'>): ContactsSource => ({
  load: (id) => partyContactsApi.get(party, id),
  save: (id, body) => partyContactsApi.replace(party, id, body),
  conflictCode: 'PARTY_CONTACTS_VERSION_CONFLICT',
  ...fields,
});

export const SUPPLIER_CONTACTS = source('supplier', {
  kinds: ['phone', 'email', 'telegram'],
  title: 'Контакты',
  hint: 'Основной телефон используется для отправки заявок поставщику в WhatsApp. Поставщика с контактами нельзя удалить — снимите отметку «Активен».',
});

export const VENDOR_CONTACTS = source('vendor', {
  kinds: ['phone', 'email', 'telegram'],
  title: 'Контакты',
  hint: 'Производителя с контактами нельзя удалить — снимите отметку «Активен».',
});

/** A client's phones are edited in the phones list above; here — emails and Telegram accounts. */
export const CLIENT_CONTACTS = source('client', {
  kinds: ['email', 'telegram'],
  title: 'Email и Telegram',
  hint: 'Телефоны клиента ведутся в списке телефонов выше; основной телефон используется для отправки заказа клиенту в WhatsApp.',
});
