import { useState, useCallback } from 'react';
import { CalendarOrder, DragItem } from '../types/calendar';

export interface UseDragAndDropResult {
  draggedOrder: CalendarOrder | null;
  dragOverColumn: string | null;
  handleDragStart: (order: CalendarOrder, sourceDate: string) => void;
  handleDragEnd: () => void;
  handleDragOver: (targetDate: string) => void;
  handleDragLeave: () => void;
  isDragging: boolean;
}

/**
 * Hook для управления состоянием Drag & Drop в календаре
 *
 * @returns Объект с состоянием и обработчиками D&D
 */
export const useDragAndDrop = (): UseDragAndDropResult => {
  const [draggedOrder, setDraggedOrder] = useState<CalendarOrder | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<string | null>(null);

  /**
   * Начало перетаскивания заказа
   */
  const handleDragStart = useCallback((order: CalendarOrder, sourceDate: string) => {
    setDraggedOrder(order);
  }, []);

  /**
   * Конец перетаскивания (успешно или отменено)
   */
  const handleDragEnd = useCallback(() => {
    setDraggedOrder(null);
    setDragOverColumn(null);
  }, []);

  /**
   * Курсор над колонкой (drop target)
   */
  const handleDragOver = useCallback((targetDate: string) => {
    setDragOverColumn(targetDate);
  }, []);

  /**
   * Курсор покинул колонку
   */
  const handleDragLeave = useCallback(() => {
    setDragOverColumn(null);
  }, []);

  const isDragging = draggedOrder !== null;

  return {
    draggedOrder,
    dragOverColumn,
    handleDragStart,
    handleDragEnd,
    handleDragOver,
    handleDragLeave,
    isDragging,
  };
};
