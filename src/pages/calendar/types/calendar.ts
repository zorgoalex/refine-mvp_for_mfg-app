/**
 * Типы данных для производственного календаря
 */

/**
 * Заказ для календаря (на основе orders_view)
 */
export interface CalendarOrder {
  order_id: number;
  order_name: string;
  order_date: string;
  planned_completion_date: string;
  client_name: string;
  parts_count: number;
  total_area: number;
  order_status: string;
  payment_status: string;
  production_status?: string; // Статус производства
  paid_amount: number;
  total_price: number;

  // Агрегированные данные по материалам, пленкам и т.д.
  materials?: string; // Уникальные материалы через запятую
  milling_type?: string; // Тип фрезеровки (если один для всех деталей)
  edge_type?: string; // Тип обката (если один для всех деталей)
  film?: string; // Пленка (если одна для всех деталей)

  // Дополнительные поля
  cad_files_status?: string; // Статус CAD файлов
  is_drawn?: boolean; // Отрисован
  is_issued?: boolean; // Выдан
  
  // Заметка: Статусы производства (З Р Ш П У) НЕ хранятся в orders/orders_view
  // Они хранятся в order_details.production_status_id и должны агрегироваться отдельно
  // Для отображения в календаре нужно добавить эти поля в orders_view через агрегацию

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
