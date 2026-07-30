import { useState, useMemo } from 'react';
import { addDays } from 'date-fns';
import { generateCalendarDays } from '../utils/dateUtils';
import { CalendarDaysResult } from '../types/calendar';

export type CalendarStepDays = 1 | 7 | 14 | 30;

/**
 * Pure helper: возвращает смещение в днях для перехода вперёд/назад.
 * Используется для тестирования без React rendering.
 */
export function computeStepOffset(stepDays: CalendarStepDays, direction: 1 | -1): number {
  return stepDays * direction;
}

/**
 * Hook для генерации и управления днями календаря
 * Генерирует диапазон: 5 дней назад + текущий день + 10 дней вперед (всего 16 дней)
 *
 * @param options.stepDays 1, 7, 14 или 30 дней. По умолчанию — неделя.
 */
export const useCalendarDays = (
  options: { stepDays?: CalendarStepDays; daysAfter?: number } = {},
): CalendarDaysResult => {
  const stepDays: CalendarStepDays = options.stepDays ?? 7;
  const daysAfter = options.daysAfter ?? 10;
  const [centerDate, setCenterDate] = useState<Date>(new Date());

  // Генерируем массив дней: 5 дней назад + текущий день + 10 дней вперед
  const days = useMemo(() => {
    return generateCalendarDays(centerDate, 5, daysAfter);
  }, [centerDate, daysAfter]);

  // Начальная и конечная даты для фильтрации данных
  const startDate = days[0];
  const endDate = days[days.length - 1];

  // Функция для возврата к текущей дате
  const goToToday = () => {
    setCenterDate(new Date());
  };

  // Функция для перехода вперед (на stepDays дней)
  const goForward = () => {
    setCenterDate((prev) => addDays(prev, computeStepOffset(stepDays, 1)));
  };

  // Функция для перехода назад (на stepDays дней)
  const goBackward = () => {
    setCenterDate((prev) => addDays(prev, computeStepOffset(stepDays, -1)));
  };

  return {
    days,
    startDate,
    endDate,
    setCenterDate,
    goToToday,
    goForward,
    goBackward,
  };
};
