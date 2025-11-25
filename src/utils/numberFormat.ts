// Number formatting utilities
// Formats numbers with space as thousand separator (Russian standard)

/**
 * Format number with space as thousand separator
 * @param value - number to format
 * @param precision - decimal places (default: 0)
 * @returns formatted string
 */
export const formatNumber = (
  value: number | null | undefined,
  precision: number = 0
): string => {
  if (value === null || value === undefined || isNaN(value)) {
    return '0';
  }

  // Ensure precision is a valid integer between 0 and 20
  const validPrecision = Math.max(0, Math.min(20, Math.floor(precision || 0)));

  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: validPrecision,
    maximumFractionDigits: validPrecision,
  }).format(value);
};

/**
 * Parse formatted number string back to number
 * @param value - formatted string (e.g., "1 234.56")
 * @returns parsed number
 */
export const parseFormattedNumber = (value: string): number | null => {
  if (!value) return null;

  // Remove spaces and replace comma with dot
  const cleaned = value.replace(/\s/g, '').replace(',', '.');
  const parsed = parseFloat(cleaned);

  return isNaN(parsed) ? null : parsed;
};

/**
 * Formatter for Ant Design InputNumber
 * Adds space as thousand separator
 */
export const numberFormatter = (value: number | undefined, precision: number = 0): string => {
  if (!value) return '';
  return formatNumber(value, precision);
};

/**
 * Parser for Ant Design InputNumber
 * Removes spaces and parses the number
 */
export const numberParser = (value: string | undefined): number | string => {
  if (!value || value.trim() === '') return '';
  const parsed = parseFormattedNumber(value);
  return parsed ?? '';
};
