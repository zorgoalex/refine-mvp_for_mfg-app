import React from 'react';
import type { BitrixActor, Bitrix24IncomingPayment } from '../../api/bitrix24Api';

export function BitrixActorLabel({ actor }: { actor?: BitrixActor | null }) {
  if (!actor) return <span>Неизвестно — Bitrix не передал автора</span>;
  return <span style={{ overflowWrap: 'anywhere' }}>
    {actor.displayName ? `${actor.displayName} · Bitrix #${actor.bitrixUserId}` : `Bitrix #${actor.bitrixUserId}`}
    {actor.erpUserId != null && <small style={{ display: 'block', color: 'var(--app-text-muted)' }}>
      Сопоставлен ERP: {actor.erpDisplayName || `#${actor.erpUserId}`}
    </small>}
  </span>;
}

export function BitrixPaymentAuthorship({ payment }: { payment: Bitrix24IncomingPayment }) {
  return <div style={{ minWidth: 180, overflowWrap: 'anywhere' }}>
    {payment.source === 'widget'
      ? <div>Внёс через виджет: <BitrixActorLabel actor={payment.authorship?.createdBy} /></div>
      : <div>Автор создания неизвестен — Bitrix не передал автора</div>}
    {payment.authorship?.paidBy && <div style={{ marginTop: 4 }}>
      Статус оплаты изменил (Bitrix): <BitrixActorLabel actor={payment.authorship.paidBy} />
    </div>}
  </div>;
}
