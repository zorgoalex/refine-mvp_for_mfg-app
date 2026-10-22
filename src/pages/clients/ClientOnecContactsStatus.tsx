import { useCallback, useEffect, useState } from 'react';
import { Alert, Button, Space, Typography, message } from 'antd';
import { isApiError } from '../../api/apiError';
import { partyContactsApi, type ClientLink } from '../../api/partyContactsApi';
import { onecSyncMessage } from '../suppliers/supplierCounterpartyModel';
import { CLIENT_ONEC_SYNC_OFF, canSyncClientOnec, clientOnecStatusView } from './clientOnecContactsModel';

interface Props {
  clientId: number | null | undefined;
  /** clients.update and clients.onec_data.view: the «Сверить с 1С» button is shown (when the sync is on). */
  canSync?: boolean;
  /** The contacts of the client changed here (a sync with 1C): the contacts block reloads. */
  onContactsChanged?: () => void;
  /** The contacts block has unsaved edits: a sync would reload it over them, so it waits. */
  contactsDirty?: boolean;
  /** A sync is in flight (until its answer is in): the contacts block does not take edits meanwhile. */
  onBusyChange?: (busy: boolean) => void;
  /** Read the state again (the link of the client changed in its card). */
  reloadToken?: number;
}

/** The state of the 1C copy of the contacts of a client and the «Сверить с 1С» button; hidden when there is nothing to say. */
export const ClientOnecContactsStatus: React.FC<Props> = ({ clientId, canSync = false, onContactsChanged, contactsDirty = false, onBusyChange, reloadToken = 0 }) => {
  const [link, setLink] = useState<ClientLink | null>(null);
  const [syncing, setSyncing] = useState(false);
  useEffect(() => { onBusyChange?.(syncing); }, [syncing, onBusyChange]);

  const load = useCallback(async () => {
    if (!clientId) return;
    try {
      setLink(await partyContactsApi.clientCounterparty(clientId));
    } catch {
      setLink(null); // the link card of the page says what is wrong
    }
    // reloadToken: a read again on demand of the page.
  }, [clientId, reloadToken]);
  useEffect(() => { void load(); }, [load]);

  const syncNow = async () => {
    if (!clientId || syncing || contactsDirty) return;
    setSyncing(true);
    try {
      const result = await partyContactsApi.syncClientOnec(clientId);
      setLink((current) => (current ? { ...current, onec: result.onec } : current));
      onContactsChanged?.();
      const shown = onecSyncMessage(result.outcome, 'Клиент');
      message[shown.type](shown.text);
    } catch (error) {
      if (isApiError(error, CLIENT_ONEC_SYNC_OFF)) {
        message.info('Сверка контактов клиентов с 1С сейчас выключена');
        setLink((current) => (current ? { ...current, onecSyncEnabled: false } : current));
      } else {
        message.error(error instanceof Error ? error.message : 'Не удалось сверить контакты с 1С');
      }
    } finally {
      setSyncing(false);
    }
  };

  const view = clientOnecStatusView(link);
  const showButton = canSync && canSyncClientOnec(link, () => true);
  if (!view.visible && !showButton) return null;
  return (
    <Space direction="vertical" size={4} style={{ width: '100%' }}>
      <Space wrap size={8}>
        {view.syncedText ? <Typography.Text type="secondary">{view.syncedText}</Typography.Text> : null}
        {showButton ? (
          <Button size="small" loading={syncing} disabled={contactsDirty} onClick={() => { void syncNow(); }}>Сверить с 1С</Button>
        ) : null}
        {showButton && contactsDirty ? <Typography.Text type="warning">Сначала сохраните контакты: сверка перечитывает их.</Typography.Text> : null}
      </Space>
      {view.warnings.map((warning) => <Alert key={warning} type="warning" showIcon message={warning} />)}
    </Space>
  );
};
