import { useEffect, useMemo, useState } from 'react';
import { Alert, Button, Modal, Radio, Space, Typography, message } from 'antd';
import { WhatsAppOutlined } from '@ant-design/icons';
import { ApiError } from '../../api/apiError';
import { authSession } from '../../api/authSession';
import { partyContactsApi } from '../../api/partyContactsApi';
import { supplierSendApi } from '../../api/supplierSendApi';
import { announceWhatsAppSendQueued, currentOwner } from '../../components/whatsapp/myWhatsAppSendsModel';
import { Tooltip } from '../../ui/tooltipDelay';
import { can } from '../../utils/permissions';
import {
  counterpartyOfSupplierKey,
  runSupplierSend,
  supplierMessagesText,
  supplierSendButtonState,
  supplierUnavailableText,
  type SupplierMenuLoad,
  type SupplierSendContext,
} from './supplierSendModel';
import { normalizeSupplierText } from './supplierSendText';

interface SupplierWhatsAppSendProps {
  /** What the window «Текст для поставщика» shows: the text goes exactly as it is on the screen. */
  context: SupplierSendContext;
  requestNumber: string;
  requestStatus: string;
  supplierKey: string;
  supplierName: string;
}

/**
 * «Отправить в WhatsApp» рядом со «Скопировать» в окне «Текст для поставщика»: текст с экрана уходит на телефон
 * поставщика из справочника через очередь отправок из карточек. Статус заявки не меняется.
 */
export function SupplierWhatsAppSend({ context, requestNumber, requestStatus, supplierKey, supplierName }: SupplierWhatsAppSendProps) {
  const [load, setLoad] = useState<SupplierMenuLoad>({ status: 'loading' });
  const [refresh, setRefresh] = useState(0);
  const [open, setOpen] = useState(false);
  const [contactId, setContactId] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [adding, setAdding] = useState(false);

  // The recipient is read again for every version of the request (its supplier may have changed).
  useEffect(() => {
    if (!context.ready) return undefined;
    const controller = new AbortController();
    setLoad((current) => (current.status === 'ready' ? current : { status: 'loading' }));
    supplierSendApi.menu(context.requestId, { signal: controller.signal })
      .then((menu) => { if (!controller.signal.aborted) setLoad({ status: 'ready', menu }); })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        // No such route (an older backend) or no right to send: the button is not offered at all.
        const hidden = error instanceof ApiError && (error.status === 403 || (error.status === 404 && error.code !== 'SUPPLIER_REQUEST_NOT_FOUND'));
        setLoad({ status: hidden ? 'hidden' : 'error' });
      });
    return () => controller.abort();
  }, [context.ready, context.requestId, context.requestVersion, refresh]);

  const state = supplierSendButtonState(context, load);
  const menu = load.status === 'ready' ? load.menu : null;
  const contacts = useMemo(() => menu?.contacts ?? [], [menu]);
  // The chosen phone while it is still in the list; otherwise the primary one (the first).
  const contact = contacts.find((item) => item.contactId === contactId) ?? contacts[0] ?? null;
  const counterparty = counterpartyOfSupplierKey(supplierKey);

  if (state.hidden) return null;

  const send = (confirmAfterUnknown?: string) => {
    if (!contact || busy) return;
    // Who sends: captured before the command, so a re-login while it runs cannot take over its result.
    const owner = currentOwner();
    setBusy(true);
    void runSupplierSend({
      supplierRequestId: context.requestId,
      requestNumber,
      actorId: String(authSession.getUser()?.id ?? ''),
      payload: {
        text: normalizeSupplierText(context.text), edited: context.edited, templateId: context.templateId, templateVersion: context.templateVersion,
        textVersion: context.textVersion, contactId: contact.contactId, contactToken: contact.token,
        ...(confirmAfterUnknown ? { confirmAfterUnknown } : {}),
      },
      send: supplierSendApi.send,
      onQueued: (queued) => { void announceWhatsAppSendQueued(queued.sendId, { kind: 'order_send' }, owner); },
    })
      .then((result) => {
        if (!result) return;
        if (result.confirmUnknown) {
          const previous = result.confirmUnknown;
          Modal.confirm({
            title: 'Результат прежней отправки неизвестен',
            content: result.text,
            okText: 'Отправить ещё раз',
            cancelText: 'Не отправлять',
            onOk: () => send(previous.sendId),
          });
          return;
        }
        if (result.refreshMenu) setRefresh((value) => value + 1);
        message[result.type](result.text);
        if (result.accepted) {
          setOpen(false);
          // WhatsApp-отправка статус заявки не меняет — напоминание для черновика.
          if (requestStatus === 'draft') message.info('Заявка осталась черновиком. Когда поставщик получит текст — нажмите «Отметить отправленной».', 8);
        }
      })
      .finally(() => setBusy(false));
  };

  const addToDirectory = () => {
    if (!counterparty || adding) return;
    setAdding(true);
    partyContactsApi.supplierFromCounterparty(counterparty)
      .then((link) => {
        message.success(link.created ? `Поставщик «${link.supplierName}» добавлен в справочник. Укажите его телефон.` : `Поставщик «${link.supplierName}» уже есть в справочнике.`);
        setRefresh((value) => value + 1);
      })
      .catch((error: unknown) => {
        message.error(error instanceof ApiError && error.status === 403 ? 'Недостаточно прав для изменения справочника «Поставщики»'
          : error instanceof ApiError && error.message ? error.message : 'Не удалось добавить поставщика в справочник');
      })
      .finally(() => setAdding(false));
  };

  const problem = state.recipientProblem;
  const supplierPage = menu?.supplier ? `/suppliers/edit/${menu.supplier.supplierId}` : null;

  return (
    <>
      <Tooltip title={state.reason}>
        <Button icon={<WhatsAppOutlined style={state.disabled ? undefined : { color: '#25D366' }} />} disabled={state.disabled}
          onClick={() => { setContactId(null); setOpen(true); }}>
          Отправить в WhatsApp
        </Button>
      </Tooltip>
      <Modal
        open={open}
        width={480}
        title={`Отправить в WhatsApp — заявка ${requestNumber}`}
        onCancel={() => { if (!busy) setOpen(false); }}
        footer={(
          <Space wrap style={{ justifyContent: 'flex-end', width: '100%' }}>
            <Button disabled={busy} onClick={() => setOpen(false)}>Отмена</Button>
            <Button type="primary" icon={<WhatsAppOutlined />} loading={busy} disabled={problem !== null || !contact || state.disabled} onClick={() => send()}>
              Отправить
            </Button>
          </Space>
        )}
      >
        {problem !== null ? (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Alert type="warning" showIcon message={supplierUnavailableText(problem)} />
            {problem === 'not_linked' && counterparty && (
              <>
                <Typography.Text>Поставщик заявки — контрагент 1С «{supplierName}». Добавьте его в справочник «Поставщики» и укажите телефон.</Typography.Text>
                <Button type="primary" loading={adding} disabled={!can('suppliers.manage')} onClick={addToDirectory}>Добавить в справочник «Поставщики»</Button>
                {!can('suppliers.manage') && <Typography.Text type="secondary">Нужно право на изменение справочника поставщиков.</Typography.Text>}
              </>
            )}
            {problem === 'not_linked' && !counterparty && (
              <Typography.Text>В заявке поставщик указан только названием («{supplierName}»). Выберите в заявке поставщика из справочника или контрагента 1С.</Typography.Text>
            )}
            {problem !== 'not_linked' && supplierPage && (
              <Typography.Text>
                {problem === 'no_phone' ? 'Добавьте телефон в карточке поставщика' : 'Проверьте карточку поставщика'}:{' '}
                <a href={supplierPage} target="_blank" rel="noreferrer">«{menu?.supplier?.name}»</a>, затем нажмите «Проверить снова».
              </Typography.Text>
            )}
            <Button onClick={() => setRefresh((value) => value + 1)}>Проверить снова</Button>
          </Space>
        ) : (
          <Space direction="vertical" size={10} style={{ width: '100%' }}>
            <Typography.Text>Получатель: <Typography.Text strong>{menu?.supplier?.name ?? supplierName}</Typography.Text></Typography.Text>
            {contacts.length > 1 ? (
              <Radio.Group value={contact?.contactId} disabled={busy} onChange={(event) => setContactId(Number(event.target.value))}>
                <Space direction="vertical" size={4}>
                  {contacts.map((item) => (
                    <Radio key={item.contactId} value={item.contactId}>{item.masked}{item.isPrimary ? ' — основной' : ''}</Radio>
                  ))}
                </Space>
              </Radio.Group>
            ) : (
              <Typography.Text>Телефон: {contact?.masked ?? '—'}</Typography.Text>
            )}
            <Typography.Text type="secondary">
              {supplierMessagesText(state.messages)}; символов: {normalizeSupplierText(context.text).length}.
              {context.edited ? ' Текст изменён вручную — уйдёт именно он.' : ''}
            </Typography.Text>
            {menu && menu.queueLength > 0 && (
              <Typography.Text type="secondary">В очереди отправок уже {menu.queueLength} — текст уйдёт в свою очередь.</Typography.Text>
            )}
            {state.reason && <Alert type="warning" showIcon message={state.reason} />}
          </Space>
        )}
      </Modal>
    </>
  );
}
