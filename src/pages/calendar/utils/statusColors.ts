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
 * Тип детали заказа для вычисления фрезеровки и материалов
 */
interface OrderDetailForDisplay {
  milling_type?: {
    milling_type_name: string;
  };
  material?: {
    material_name: string;
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
export function getMillingDisplayValue(orderDetails: OrderDetailForDisplay[] | undefined): string {
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

/**
 * Вычисляет уникальные материалы из деталей заказа
 * @param orderDetails - массив деталей заказа с material
 * @returns строка с уникальными материалами через запятую
 */
export function getMaterialsDisplayValue(orderDetails: OrderDetailForDisplay[] | undefined): string {
  if (!orderDetails || orderDetails.length === 0) return '';

  // Собираем все уникальные материалы из деталей
  const materialNames = orderDetails
    .map(d => d.material?.material_name)
    .filter((name): name is string => !!name);

  if (materialNames.length === 0) return '';

  // Убираем дубликаты
  const uniqueMaterials = Array.from(new Set(materialNames));

  return uniqueMaterials.join(', ');
}

/**
 * Сокращает название материала для отображения на карточке:
 * - МДФ → только толщина (цифры + "мм")
 * - ЛДСП → просто "ЛДСП"
 * - Остальные — без изменений
 * @param material - полное название материала
 * @returns сокращенное название
 */
export function getShortMaterialName(material: string): string {
  const mat = material.trim();
  const matLower = mat.toLowerCase();

  // ЛДСП — всегда сокращаем до "ЛДСП"
  if (matLower.includes('лдсп')) {
    return 'ЛДСП';
  }

  // МДФ — извлекаем только толщину (цифры + мм)
  if (matLower.includes('мдф')) {
    const match = mat.match(/(\d+)\s*мм/i);
    if (match) {
      return `${match[1]}мм`;
    }
    // Если не нашли толщину, ищем просто цифры
    const numMatch = mat.match(/(\d+)/);
    if (numMatch) {
      return `${numMatch[1]}мм`;
    }
  }

  // Остальные материалы — без изменений
  return mat;
}

/**
 * Получить массив материалов с сокращенными именами для отображения на карточке
 * @param orderDetails - массив деталей заказа
 * @param excludeMdf16 - исключить "МДФ 16мм" из списка (для стандартной карточки)
 * @returns массив объектов { name: сокращенное имя, fullName: полное имя }
 */
export function getMaterialsForCard(
  orderDetails: OrderDetailForDisplay[] | undefined,
  excludeMdf16: boolean = true
): Array<{ name: string; fullName: string }> {
  if (!orderDetails || orderDetails.length === 0) return [];

  // Собираем все уникальные материалы из деталей
  const materialNames = orderDetails
    .map(d => d.material?.material_name)
    .filter((name): name is string => !!name);

  if (materialNames.length === 0) return [];

  // Убираем дубликаты
  const uniqueMaterials = Array.from(new Set(materialNames));

  // Фильтруем "МДФ 16мм" если нужно
  const filtered = excludeMdf16
    ? uniqueMaterials.filter(m => {
        const lower = m.toLowerCase();
        // Исключаем если это МДФ 16мм
        return !(lower.includes('мдф') && lower.includes('16'));
      })
    : uniqueMaterials;

  return filtered.map(fullName => ({
    name: getShortMaterialName(fullName),
    fullName,
  }));
}

/**
 * Получить материалы для краткого вида (все кроме МДФ 16мм, в сокращенном виде)
 * @param orderDetails - массив деталей заказа
 * @returns строка с сокращенными материалами через запятую
 */
export function getMaterialsForBriefView(orderDetails: OrderDetailForDisplay[] | undefined): string {
  const materials = getMaterialsForCard(orderDetails, true);
  return materials.map(m => m.name).join(', ');
}

/**
 * Определяет цвет текста для материала (для краткого вида)
 * @param material - название материала
 * @returns HEX цвет текста
 */
export function getMaterialTextColor(material: string): string {
  const mat = String(material || '').toLowerCase().trim();

  // 18мм - темно-желтый/оранжевый
  if (mat.includes('18')) {
    return '#b8860b';
  }

  // 16мм - темно-желтый
  if (mat.includes('16')) {
    return '#996600';
  }

  // 10мм - темно-синий
  if (mat.includes('10')) {
    return '#1565c0';
  }

  // 8мм - темно-зеленый
  if (mat.includes('8')) {
    return '#2e7d32';
  }

  // ЛДСП - фиолетовый
  if (mat.includes('лдсп')) {
    return '#7b1fa2';
  }

  // МДФ - темно-оранжевый
  if (mat.includes('мдф')) {
    return '#e65100';
  }

  // Фанера - коричневый
  if (mat.includes('фанера')) {
    return '#5d4037';
  }

  // По умолчанию - темно-серый
  return '#333333';
}
