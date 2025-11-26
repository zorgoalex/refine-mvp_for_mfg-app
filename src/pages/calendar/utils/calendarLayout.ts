/**
 * Константы для адаптивного дизайна календаря
 */
export const LAYOUT_CONFIG = {
  // Минимальная ширина колонки на мобильных устройствах
  MOBILE_MIN_COLUMN_WIDTH: 160,

  // Максимальная ширина колонки на мобильных устройствах
  MOBILE_MAX_COLUMN_WIDTH: 200,

  // Базовая ширина колонки на десктопе (уменьшена на 10% для оптимальных пропорций)
  DESKTOP_COLUMN_WIDTH: 252,

  // Отступ между колонками
  COLUMN_GAP: 16,

  // Padding контейнера слева и справа
  CONTAINER_PADDING: 32,

  // Breakpoint для мобильных устройств
  MOBILE_BREAKPOINT: 768,
} as const;

/**
 * Результат расчета layout колонок
 */
export interface LayoutCalculation {
  columnWidth: number;
  columnsPerRow: number;
}

/**
 * Вычисляет количество колонок в ряду и их ширину
 * @param containerWidth - ширина контейнера календаря
 * @param isMobile - является ли устройство мобильным
 * @param cardScale - масштаб карточек (от 0.7 до 1.5)
 * @returns объект с шириной колонки и количеством колонок в ряду
 */
export function calculateColumnsPerRow(
  containerWidth: number,
  isMobile: boolean = false,
  cardScale: number = 1.0
): LayoutCalculation {
  const {
    MOBILE_MIN_COLUMN_WIDTH,
    MOBILE_MAX_COLUMN_WIDTH,
    DESKTOP_COLUMN_WIDTH,
    COLUMN_GAP,
    CONTAINER_PADDING,
  } = LAYOUT_CONFIG;

  // Доступная ширина для колонок (минус padding)
  const availableWidth = containerWidth - CONTAINER_PADDING;

  if (isMobile) {
    // Мобильные устройства: адаптивный расчет с учетом масштаба
    const scaledMinWidth = MOBILE_MIN_COLUMN_WIDTH * cardScale;
    const scaledMaxWidth = MOBILE_MAX_COLUMN_WIDTH * cardScale;

    // Очень узкие экраны - 2 колонки минимальной ширины
    if (availableWidth < scaledMinWidth * 2 + COLUMN_GAP) {
      const width = Math.max(
        scaledMinWidth,
        Math.floor((availableWidth - COLUMN_GAP) / 2)
      );
      return { columnWidth: width, columnsPerRow: 2 };
    }

    // Более широкие мобильные экраны - автоматический расчет
    let cols = Math.floor(
      (availableWidth + COLUMN_GAP) / (scaledMinWidth + COLUMN_GAP)
    );
    cols = Math.max(2, Math.min(cols, 3)); // от 2 до 3 колонок на мобильных

    const width = Math.min(
      scaledMaxWidth,
      Math.floor((availableWidth - COLUMN_GAP * (cols - 1)) / cols)
    );

    return { columnWidth: width, columnsPerRow: cols };
  }

  // Десктоп и планшеты: фиксированная ширина колонки, масштабирование через transform
  // Визуальная ширина карточки после масштабирования
  const visualCardWidth = DESKTOP_COLUMN_WIDTH * cardScale;

  // Вычисляем количество колонок с учетом визуального размера масштабированных карточек
  const cols = Math.max(
    1,
    Math.floor((availableWidth + COLUMN_GAP) / (visualCardWidth + COLUMN_GAP))
  );

  // Колонка имеет фиксированную ширину (карточки масштабируются через transform: scale)
  return { columnWidth: DESKTOP_COLUMN_WIDTH, columnsPerRow: cols };
}

/**
 * Группирует дни по рядам на основе количества колонок в ряду
 * @param days - массив дат
 * @param columnsPerRow - количество колонок в одном ряду
 * @returns двумерный массив дат (ряды × колонки)
 */
export function groupDaysIntoRows<T>(days: T[], columnsPerRow: number): T[][] {
  const rows: T[][] = [];

  for (let i = 0; i < days.length; i += columnsPerRow) {
    rows.push(days.slice(i, i + columnsPerRow));
  }

  return rows;
}

/**
 * Проверяет, является ли устройство мобильным на основе ширины экрана
 * @param width - ширина экрана или контейнера
 * @returns true если ширина меньше MOBILE_BREAKPOINT
 */
export function isMobileDevice(width: number = window.innerWidth): boolean {
  return width <= LAYOUT_CONFIG.MOBILE_BREAKPOINT;
}

/**
 * Вычисляет общую ширину ряда колонок
 * @param columnWidth - ширина одной колонки
 * @param columnsPerRow - количество колонок в ряду
 * @returns общая ширина ряда включая gaps
 */
export function calculateRowWidth(
  columnWidth: number,
  columnsPerRow: number
): number {
  return (
    columnWidth * columnsPerRow +
    LAYOUT_CONFIG.COLUMN_GAP * (columnsPerRow - 1)
  );
}
