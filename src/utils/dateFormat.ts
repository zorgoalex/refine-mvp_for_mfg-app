import dayjs from "dayjs";
import "dayjs/locale/ru";

// Устанавливаем русскую локаль по умолчанию
dayjs.locale("ru");

/**
 * Форматирование даты в формате дд.мм.гггг
 */
export const formatDate = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format("DD.MM.YYYY");
};

/**
 * Форматирование даты и времени в формате дд.мм.гггг чч:мм
 */
export const formatDateTime = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format("DD.MM.YYYY HH:mm");
};

/**
 * Форматирование даты и времени с секундами в формате дд.мм.гггг чч:мм:сс
 */
export const formatDateTimeFull = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format("DD.MM.YYYY HH:mm:ss");
};
