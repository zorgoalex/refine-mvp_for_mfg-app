import React from 'react';
import { Alert } from 'antd';

const reasons: Record<string, string> = {
  POSITIONS_REQUIRED: 'Добавьте хотя бы одну деталь или позицию товаров/услуг. После сохранения заявка будет повторно проверена.',
  WIDGET_PENDING: 'Ожидается завершение команды виджета «Оплата ERP».',
  PAYMENT_MAPPING_REQUIRED: 'Проверьте сопоставление платёжной системы, валюту KZT и дату оплаты.',
  ACTOR_UNAVAILABLE: 'Проверьте служебного пользователя обратной синхронизации.',
  REQUEST_BLOCKED: 'Устраните конфликт синхронизации заявки.',
  PAYMENT_PERMISSION_REQUIRED: 'У принявшего оплату сотрудника нет необходимых прав ERP. Проверьте сопоставление пользователя и права.',
  PAYMENT_REQUIRES_CONFIRMATION: 'Требуется подтверждение переноса платежа, например переплаты, в виджете «Оплата ERP».',
  CONVERSION_BLOCKED: 'Проверьте проект, начальные статусы и настройки преобразования. Подробности доступны администратору.',
};

export function BitrixPaidConversionNotice({ status, reason }: { status?: string; reason?: string | null }) {
  if (status === 'converted') return <Alert type="success" showIcon message="Заявка автоматически преобразована после получения оплаты" />;
  if (status !== 'waiting') return null;
  return <Alert type="info" showIcon message="Автоматическое преобразование ожидает действий"
    description={reasons[reason ?? ''] ?? 'Заявка будет повторно проверена при следующей сверке с Bitrix.'} />;
}
