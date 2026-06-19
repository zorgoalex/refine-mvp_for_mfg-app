import dayjs from "dayjs";
import "dayjs/locale/ru";

// Устанавливаем русскую локаль по умолчанию
dayjs.locale("ru");

export const DISPLAY_DATE_FORMAT = "DD.MM.YYYY";
export const DISPLAY_DATE_TIME_FORMAT = `${DISPLAY_DATE_FORMAT} HH:mm`;
export const DISPLAY_DATE_TIME_SECONDS_FORMAT = `${DISPLAY_DATE_TIME_FORMAT}:ss`;

/**
 * Форматирование даты в формате дд.мм.гггг
 */
export const formatDate = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format(DISPLAY_DATE_FORMAT);
};

/**
 * Форматирование даты и времени в формате дд.мм.гггг чч:мм
 */
export const formatDateTime = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format(DISPLAY_DATE_TIME_FORMAT);
};

/**
 * Форматирование даты и времени с секундами в формате дд.мм.гггг чч:мм:сс
 */
export const formatDateTimeFull = (date: string | null | undefined): string => {
  if (!date) return "—";
  return dayjs(date).format(DISPLAY_DATE_TIME_SECONDS_FORMAT);
};
