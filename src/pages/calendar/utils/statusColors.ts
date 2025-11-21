/**
 * Утилиты для определения цветов статусов и материалов
 */

/**
 * Определяет цвет фона карточки заказа по статусу
 * @param status - статус заказа
 * @returns HEX цвет фона
 */
export function getStatusColor(status: string): string {
  const statusLower = String(status || '').toLowerCase().trim();

  // Выдан - светло-зеленый
  if (statusLower === 'выдан') {
    return '#eafbe7';
  }

  // Готов - светло-оранжевый
  if (statusLower === 'готов') {
    return '#ffd9bf';
  }

  // В работе - светло-желтый
  if (statusLower === 'в работе' || statusLower.includes('работ')) {
    return '#fff9e6';
  }

  // Отменен - светло-красный
  if (statusLower === 'отменен' || statusLower.includes('отмен')) {
    return '#ffe6e6';
  }

  // Новый / По умолчанию - белый
  return '#ffffff';
}

/**
 * Определяет цвет бейджа материала
 * @param material - название материала
 * @returns HEX цвет фона
 */
export function getMaterialColor(material: string): string {
  const mat = String(material || '').toLowerCase().trim();

  // 18мм - светло-желтый
  if (mat.includes('18')) {
    return '#fff3cd';
  }

  // 16мм - желтый
  if (mat.includes('16')) {
    return '#ffeaa7';
  }

  // 10мм - голубой
  if (mat.includes('10')) {
    return '#90caf9';
  }

  // 8мм - зеленый
  if (mat.includes('8')) {
    return '#c8e6c9';
  }

  // ЛДСП - фиолетовый
  if (mat.includes('лдсп')) {
    return '#ce93d8';
  }

  // МДФ - оранжевый
  if (mat.includes('мдф')) {
    return '#ffcc80';
  }

  // Фанера - коричневый
  if (mat.includes('фанера')) {
    return '#d7ccc8';
  }

  // По умолчанию - светло-серый
  return '#f0f0f0';
}

/**
 * Определяет стиль индикатора статуса производства
 * @param status - статус (Готов / -)
 * @param backgroundColor - цвет фона карточки (для скрытия неактивных индикаторов)
 * @returns объект стиля с цветом и жирностью шрифта
 */
export function getProductionStageStyle(
  status: string,
  backgroundColor: string = '#ffffff'
): { color: string; fontWeight: number } {
  const statusLower = String(status || '').toLowerCase().trim();

  // Готов - оранжевый + жирный
  if (statusLower === 'готов') {
    return { color: '#ff6f00', fontWeight: 700 };
  }

  // Не готов (-) - цвет фона (невидимый)
  return { color: backgroundColor, fontWeight: 600 };
}

/**
 * Определяет цвет границы карточки заказа
 * @param order - объект заказа
 * @returns HEX цвет границы
 */
export function getCardBorderColor(order: {
  order_status?: string;
  payment_status?: string;
  order_name?: string;
}): string {
  // Выдан - зеленая граница
  if (order.order_status?.toLowerCase() === 'выдан') {
    return '#52c41a';
  }

  // Готов - оранжевая граница
  if (order.order_status?.toLowerCase() === 'готов') {
    return '#ff6f00';
  }

  // Не оплачен - красная граница
  if (
    order.payment_status?.toLowerCase().includes('не оплачен') ||
    order.payment_status?.toLowerCase() === 'не оплачен'
  ) {
    return '#ff4d4f';
  }

  // Корпусной заказ (начинается с "К") - коричневая граница
  if (order.order_name?.startsWith('К')) {
    return '#8B4513';
  }

  // По умолчанию - светло-серая граница
  return '#d9d9d9';
}

/**
 * Проверяет, все ли статусы производства в "Готов"
 * @param order - объект заказа
 * @returns true если все 5 статусов в "Готов"
 * 
 * TODO: Статусы производства НЕ хранятся в orders/orders_view
 * Они в order_details.production_status_id. Временно возвращаем false.
 */
export function areAllProductionStagesReady(order: Record<string, any>): boolean {
  // ВРЕМЕННО: всегда false, т.к. статусов производства нет в orders_view
  return false;
  
  /* Когда будут добавлены поля в orders_view, раскомментировать:
  const stages = [
    order.film_purchase_status,
    order.cutting_status,
    order.grinding_status,
    order.filming_status,
    order.packaging_status,
  ];
  return stages.every((status) => String(status || '').toLowerCase().trim() === 'готов');
  */
}

/**
 * Тип детали заказа для вычисления фрезеровки
 */
interface OrderDetailForMilling {
  milling_type?: {
    milling_type_name: string;
  };
}

/**
 * Вычисляет отображаемое значение фрезеровки из деталей заказа
 * Правила:
 * - "Выборка" — если хотя бы одна деталь содержит слово "Выборка"
 * - "Фрезеровка" — если есть детали с фрезеровкой не равной "Модерн" и без слова "Выборка"
 * - "Модерн" — если все детали имеют фрезеровку "Модерн"
 * @param orderDetails - массив деталей заказа с milling_type
 * @returns отображаемое значение
 */
export function getMillingDisplayValue(orderDetails: OrderDetailForMilling[] | undefined): string {
  if (!orderDetails || orderDetails.length === 0) return '';

  // Собираем все типы фрезеровки из деталей
  const millingTypes = orderDetails
    .map(d => d.milling_type?.milling_type_name)
    .filter((name): name is string => !!name)
    .map(name => name.toLowerCase());

  if (millingTypes.length === 0) return '';

  // Приоритет 1: Выборка — если хотя бы одна деталь содержит "Выборка"
  if (millingTypes.some(t => t.includes('выборка'))) {
    return 'Выборка';
  }

  // Приоритет 2: Фрезеровка — если есть что-то кроме "Модерн"
  const hasNonModern = millingTypes.some(t => t !== 'модерн' && !t.includes('модерн'));
  if (hasNonModern) {
    return 'Фрезеровка';
  }

  // Все детали имеют "Модерн"
  return 'Модерн';
}
