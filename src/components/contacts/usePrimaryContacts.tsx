import { useEffect, useMemo, useState } from 'react';
import { Space } from 'antd';
import type { EmployeeContact } from '../../api/employeeContactsApiTypes';
import { partyContactsApi } from '../../api/partyContactsApi';
import { EMPLOYEE_CONTACT_KIND_LABELS, formatContact, isContactsApiMissing, sortContacts } from './contactsModel';

/**
 * Contacts of the owners on a list page (one request per page of rows). `supported` turns false on a backend
 * without the contacts API — the caller hides the column then.
 */
export function usePrimaryContacts(party: 'supplier' | 'vendor', rows: readonly unknown[] | undefined, idField: string, enabled: boolean) {
  const key = useMemo(
    () => (rows ?? []).map((row) => Number((row as Record<string, unknown>)[idField])).filter((id) => Number.isSafeInteger(id) && id > 0).join(','),
    [rows, idField],
  );
  const [contacts, setContacts] = useState<Map<number, EmployeeContact[]>>(new Map());
  const [supported, setSupported] = useState(true);
  useEffect(() => {
    if (!enabled || !supported || !key) return;
    let cancelled = false;
    partyContactsApi.list(party, key.split(',').map(Number)).then((result) => {
      if (!cancelled) setContacts(new Map(result.items.map((item) => [item.id, item.contacts])));
    }).catch((error: unknown) => {
      // An older backend without the contacts API: the column is hidden; any other error leaves it empty.
      if (!cancelled && isContactsApiMissing(error)) setSupported(false);
    });
    return () => { cancelled = true; };
  }, [party, key, enabled, supported]);
  return { contacts, supported: enabled && supported };
}

/** The primary contact of each kind, one per line. */
export const PrimaryContactsCell: React.FC<{ contacts: readonly EmployeeContact[] | undefined }> = ({ contacts }) => {
  const primary = sortContacts(contacts ?? []).filter((contact) => contact.isPrimary);
  if (!primary.length) return null;
  return (
    <Space direction="vertical" size={0}>
      {primary.map((contact) => (
        <span key={contact.contactId} title={EMPLOYEE_CONTACT_KIND_LABELS[contact.kind]}>{formatContact(contact)}</span>
      ))}
    </Space>
  );
};
