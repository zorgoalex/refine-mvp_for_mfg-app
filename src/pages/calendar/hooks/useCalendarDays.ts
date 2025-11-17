import { useState, useMemo } from 'react';
import { addDays } from 'date-fns';
import { generateCalendarDays } from '../utils/dateUtils';
import { CalendarDaysResult } from '../types/calendar';

/**
 * Hook для генерации и управления днями календаря
 * Генерирует диапазон: 5 дней назад + текущий день + 10 дней вперед (всего 16 дней)
 */
export const useCalendarDays = (): CalendarDaysResult => {
  const [centerDate, setCenterDate] = useState<Date>(new Date());

  // Генерируем массив дней: 5 дней назад + текущий день + 10 дней вперед
  const days = useMemo(() => {
    return generateCalendarDays(centerDate, 5, 10);
  }, [centerDate]);

  // Начальная и конечная даты для фильтрации данных
  const startDate = days[0];
  const endDate = days[days.length - 1];

  // Функция для возврата к текущей дате
  const goToToday = () => {
    setCenterDate(new Date());
  };

  // Функция для перехода вперед (на неделю)
  const goForward = () => {
    setCenterDate((prev) => addDays(prev, 7));
  };

  // Функция для перехода назад (на неделю)
  const goBackward = () => {
    setCenterDate((prev) => addDays(prev, -7));
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
