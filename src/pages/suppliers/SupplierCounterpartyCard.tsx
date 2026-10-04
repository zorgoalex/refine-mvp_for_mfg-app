import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Card, Popconfirm, Select, Space, Typography, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { partyContactsApi, type SupplierCounterparty, type SupplierLink } from '../../api/partyContactsApi';
import {
  SUPPLIER_COUNTERPARTY_CONFLICT, counterpartyOptions, isCounterpartyApiMissing, supplierLinkErrorMessage,
} from './supplierCounterpartyModel';

interface Props {
  supplierId: number | null | undefined;
  /** suppliers.manage: may link and unlink; otherwise read-only. */
  editable: boolean;
}

/**
 * «Контрагент 1С» of a supplier. The link is changed only by the backend command (it drives the 1C documents
 * loader): the form of the supplier no longer carries the key.
 */
export const SupplierCounterpartyCard: React.FC<Props> = ({ supplierId, editable }) => {
  const [link, setLink] = useState<SupplierLink | null>(null);
  const [items, setItems] = useState<SupplierCounterparty[]>([]);
  const [choice, setChoice] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [unsupported, setUnsupported] = useState(false);
  const [saving, setSaving] = useState(false);
  const [searching, setSearching] = useState(false);
  const searchRef = useRef(0);

  const load = useCallback(async () => {
    if (!supplierId) return;
    try {
      setLink(await partyContactsApi.supplierCounterparty(supplierId));
      setChoice(null);
      setLoadError(null);
    } catch (error) {
      if (isCounterpartyApiMissing(error)) { setUnsupported(true); return; }
      setLoadError(error instanceof Error ? error.message : 'Не удалось загрузить привязку');
    }
  }, [supplierId]);

  const search = useCallback(async (text: string) => {
    const epoch = ++searchRef.current;
    setSearching(true);
    try {
      const result = await partyContactsApi.supplierCounterparties(text);
      if (epoch === searchRef.current) setItems(result.items);
    } catch {
      if (epoch === searchRef.current) setItems([]);
    } finally {
      if (epoch === searchRef.current) setSearching(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (editable && supplierId) void search(''); }, [editable, supplierId, search]);

  const change = async (refKey1c: string | null) => {
    if (!supplierId || !link || saving) return;
    setSaving(true);
    try {
      setLink(await partyContactsApi.setSupplierCounterparty(supplierId, { refKey1c, expectedRefKey1c: link.refKey1c }));
      setChoice(null);
      message.success(refKey1c ? 'Поставщик привязан к контрагенту 1С' : 'Привязка к контрагенту 1С снята');
      void search('');
    } catch (error) {
      if (isApiError(error, SUPPLIER_COUNTERPARTY_CONFLICT)) {
        message.warning('Привязку уже изменил другой пользователь — показано текущее значение');
        await load();
      } else {
        message.error(supplierLinkErrorMessage(error));
      }
    } finally {
      setSaving(false);
    }
  };

  if (!supplierId || unsupported) return null;
  const title = 'Контрагент 1С';
  if (loadError) return <Card title={title} size="small"><Alert type="error" showIcon message={loadError} /></Card>;

  const current = link?.refKey1c
    ? <Typography.Text strong>{link.counterpartyName ?? link.refKey1c}</Typography.Text>
    : <Typography.Text type="secondary">Не связан</Typography.Text>;

  return (
    <Card title={title} size="small" loading={!link}>
      <Space direction="vertical" style={{ width: '100%' }} size={8}>
        <div>{current}</div>
        {editable ? (
          <Space wrap>
            <Select
              showSearch
              allowClear
              filterOption={false}
              disabled={saving}
              loading={searching}
              style={{ minWidth: 320 }}
              placeholder="Найти контрагента 1С по названию"
              value={choice}
              options={counterpartyOptions(items, supplierId)}
              onSearch={(text) => { void search(text); }}
              onChange={(value) => setChoice(value ?? null)}
            />
            <Popconfirm
              title={<>Привязать поставщика к этому контрагенту 1С?<br />При ближайшей загрузке из 1С все документы этого контрагента получат ссылку на поставщика.</>}
              okText="Привязать"
              cancelText="Отмена"
              disabled={!choice || saving}
              onConfirm={() => { void change(choice); }}
            >
              <Button type="primary" disabled={!choice || saving} loading={saving}>{link?.refKey1c ? 'Сменить' : 'Привязать'}</Button>
            </Popconfirm>
            {link?.refKey1c ? (
              <Popconfirm
                title={<>Снять привязку к контрагенту 1С?<br />При ближайшей загрузке из 1С документы контрагента потеряют ссылку на поставщика.</>}
                okText="Снять"
                cancelText="Отмена"
                disabled={saving}
                onConfirm={() => { void change(null); }}
              >
                <Button danger disabled={saving}>Снять привязку</Button>
              </Popconfirm>
            ) : null}
          </Space>
        ) : null}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          По этой связи экран снабжения находит телефон поставщика для отправки заявки в WhatsApp.
        </Typography.Text>
      </Space>
    </Card>
  );
};
