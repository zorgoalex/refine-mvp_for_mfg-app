export const signalLabels: Record<string, string> = {
  needs_review: 'Нужно уточнить заказ', pending: 'Ожидает обработки', processing: 'Обрабатывается', retry_wait: 'Повторим автоматически',
  succeeded: 'Действия выполнены', no_action: 'Подходящих действий нет', failed: 'Не удалось обработать', dismissed: 'Не учитывать',
  signal_detected: 'Найдены ключевые слова', order_resolved: 'Заказ определён', ambiguous_reference: 'Найдено несколько заказов',
  reference_not_found: 'Заказ не найден', processing_started: 'Начата проверка правил автостатусов', resolve: 'Заказ выбран вручную',
  dismiss: 'Сигнал исключён вручную', retry: 'Запрошена повторная обработка', configuration_changed: 'Настройки изменились — проверьте сигнал',
  preview_changed: 'Заказ или правила изменились — повторите предпросмотр', order_unavailable: 'Заказ удалён или недоступен',
  reference_changed: 'Связь с заказом изменилась — нужно уточнение',
  processing_failed: 'Ошибка обработки', worker_interrupted: 'Обработка прервалась', no_applicable_action: 'Условия правил автостатусов не выполнены',
  false_match: 'Ложное совпадение', irrelevant: 'Не относится к работе', duplicate: 'Повторное сообщение', other: 'Другая причина',
};
export const signalLabel = (code: string | null) => code ? signalLabels[code] ?? 'Требуется проверка' : 'Ключевых слов не найдено';
