/**
 * Типы данных для производственного календаря
 */

/**
 * Режимы отображения карточек заказов
 */
export enum ViewMode {
  STANDARD = 'standard',  // Стандартный вид (текущий)
  COMPACT = 'compact',    // Компактный вид
  BRIEF = 'brief',        // Краткий вид
}

/**
 * Настройки отображения календаря
 */
export interface CalendarViewSettings {
  viewMode: ViewMode;
}

/**
 * Деталь заказа для вычисления фрезеровки и материалов
 */
export interface CalendarOrderDetail {
  milling_type?: {
    milling_type_name: string;
  };
  material?: {
    material_name: string;
  };
}

/**
 * Заказ для календаря (на основе orders_view + order_details)
 */
export interface CalendarOrder {
  order_id: number;
  order_name: string;
  order_date: string;
  planned_completion_date: string;
  parts_count: number;
  total_area: number;
  paid_amount: number;
  total_price?: number;

  // Поля из orders_view
  client_name?: string;
  order_status_name?: string;
  payment_status_name?: string;
  production_status_name?: string;

  // Детали заказа для вычисления фрезеровки (добавляются в useCalendarData)
  order_details?: CalendarOrderDetail[];

  // Агрегированные данные по материалам
  materials?: string;
  edge_type?: string;
  film?: string;

  // Присадка (из order_doweling_links)
  doweling_order_name?: string;

  // Дополнительные поля
  cad_files_status?: string;
  is_drawn?: boolean;
  is_issued?: boolean;

  // Метаданные
  created_at?: string;
  updated_at?: string;
  delete_flag?: boolean;
}

/**
 * Данные дня календаря
 */
export interface DayData {
  date: Date;
  dateKey: string; // Формат DD.MM.YYYY
  orders: CalendarOrder[];
  totalArea: number; // Общая площадь заказов в этот день
}

/**
 * Элемент перетаскивания (Drag Item)
 */
export interface DragItem {
  order: CalendarOrder;
  sourceDate: string; // Исходная дата (DD.MM.YYYY)
}

/**
 * Состояние контекстного меню
 */
export interface ContextMenuState {
  isOpen: boolean;
  position: { x: number; y: number };
  order: CalendarOrder | null;
}

/**
 * Настройки отображения календаря
 */
export interface CalendarSettings {
  compactMode: boolean; // Компактный режим отображения
  showWeekends: boolean; // Показывать выходные
  showEmptyDays: boolean; // Показывать пустые дни
  visibleFields: {
    client: boolean;
    area: boolean;
    materials: boolean;
    statuses: boolean;
    payment: boolean;
  };
}

/**
 * Фильтры календаря
 */
export interface CalendarFilters {
  searchQuery?: string; // Поиск по номеру заказа
  orderStatus?: string; // Фильтр по статусу заказа
  paymentStatus?: string; // Фильтр по статусу оплаты
  client?: string; // Фильтр по клиенту
  material?: string; // Фильтр по материалу
}

/**
 * Статистика календаря
 */
export interface CalendarStats {
  totalOrders: number;
  totalArea: number;
  ordersByStatus: Record<string, number>;
  averageAreaPerDay: number;
}

/**
 * Пропсы компонента DayColumn
 */
export interface DayColumnProps {
  date: Date;
  orders: CalendarOrder[];
  columnWidth: number;
  viewMode?: ViewMode;
  cardScale?: number; // Масштаб карточек (от 0.7 до 1.0)
  onDrop?: (item: DragItem, targetDate: Date, targetDateKey: string) => void;
  onOrderDrop?: (order: CalendarOrder, sourceDate: string, targetDate: string) => void;
  onOrderClick?: (order: CalendarOrder) => void;
  onPrintDay?: (date: Date, orders: CalendarOrder[]) => void;
  onContextMenu?: (e: React.MouseEvent, order: CalendarOrder) => void;
}

/**
 * Пропсы компонента OrderCard
 */
export interface OrderCardProps {
  order: CalendarOrder;
  sourceDate: string;
  cardScale?: number; // Масштаб карточки (от 0.7 до 1.0)
  onContextMenu?: (e: React.MouseEvent, order: CalendarOrder) => void;
  onDoubleTap?: (e: React.TouchEvent, order: CalendarOrder) => void;
  onCheckboxChange?: (order: CalendarOrder, isChecked: boolean) => void;
  isDragging?: boolean;
}

/**
 * Группированные заказы по датам
 */
export type OrdersByDate = Record<string, CalendarOrder[]>;

/**
 * Тип результата хука useCalendarData
 */
export interface CalendarDataResult {
  ordersByDate: OrdersByDate;
  isLoading: boolean;
  refetch: () => void;
  error?: Error;
}

/**
 * Тип результата хука useCalendarDays
 */
export interface CalendarDaysResult {
  days: Date[];
  startDate: Date;
  endDate: Date;
  setCenterDate: (date: Date) => void;
  goToToday: () => void;
  goForward: () => void;
  goBackward: () => void;
}
