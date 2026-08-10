// CurrencyInput - InputNumber with smart focus/blur formatting
// Focus: hides unnecessary fractional zeroes
// Blur: shows ".00" and "0"

import React, { useState } from 'react';
import { InputNumber, InputNumberProps } from 'antd';
import { formatNumber, numberParser } from '../utils/numberFormat';

interface CurrencyInputProps extends Omit<InputNumberProps, 'formatter' | 'parser'> {
  /** Decimal precision (default: 2) */
  precision?: number;
  /** Keep an unset draft value visually empty even when the field is blurred. */
  emptyWhenUnset?: boolean;
}

/**
 * Format value for focused state without unnecessary fractional zeroes.
 */
type CurrencyInputValue = number | string | undefined | null;

interface CurrencyInputFormatterInfo {
  userTyping: boolean;
  input: string;
}

export const formatCurrencyInputFocusedValue = (
  value: CurrencyInputValue,
  precision: number,
  info?: CurrencyInputFormatterInfo,
): string => {
  if (info?.userTyping && /[.,]/.test(info.input)) {
    return info.input;
  }
  if (value === undefined || value === null || value === '') {
    return '';
  }
  const numericValue = Number(value);
  if (!Number.isFinite(numericValue)) return '';
  const validPrecision = Math.max(0, Math.min(20, Math.floor(precision || 0)));
  return new Intl.NumberFormat('ru-RU', {
    minimumFractionDigits: 0,
    maximumFractionDigits: validPrecision,
  }).format(numericValue);
};

/**
 * Format value for blurred state: always show full precision
 */
const formatBlurred = (
  value: CurrencyInputValue,
  precision: number,
  emptyWhenUnset: boolean,
): string => {
  if (
    emptyWhenUnset &&
    (value === undefined || value === null || value === '')
  ) {
    return '';
  }
  if (value === undefined || value === null || value === '') {
    return '0';
  }
  return formatNumber(Number(value), precision);
};

/**
 * Smart currency input with focus/blur formatting:
 * - On focus: hides unnecessary fractional zeroes
 * - On blur: shows ".00" and "0"
 */
export const CurrencyInput: React.FC<CurrencyInputProps> = ({
  precision = 2,
  onFocus,
  onBlur,
  value,
  onChange,
  autoFocus,
  emptyWhenUnset = false,
  ...props
}) => {
  // Initialize isFocused based on autoFocus prop
  const [isFocused, setIsFocused] = useState(!!autoFocus);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    setIsFocused(true);
    onFocus?.(e);
    requestAnimationFrame(() => {
      const cursorPosition = input.value.length;
      input.setSelectionRange(cursorPosition, cursorPosition);
    });
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  // Formatter for InputNumber (used during typing)
  const formatter = (
    val: number | string | undefined,
    info: CurrencyInputFormatterInfo,
  ): string => {
    if (isFocused) {
      return formatCurrencyInputFocusedValue(val, precision, info);
    }
    return formatBlurred(val, precision, emptyWhenUnset);
  };

  return (
    <InputNumber
      {...props}
      autoFocus={autoFocus}
      value={value}
      onChange={onChange}
      precision={precision}
      formatter={formatter}
      parser={numberParser}
      onFocus={handleFocus}
      onBlur={handleBlur}
    />
  );
};

export default CurrencyInput;
