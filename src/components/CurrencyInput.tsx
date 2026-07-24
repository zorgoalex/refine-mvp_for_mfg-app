// CurrencyInput - InputNumber with smart focus/blur formatting
// Focus: hides ".00" for integers, shows empty for 0
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
 * Format value for focused state: hide ".00" for integers, empty for 0
 */
type CurrencyInputValue = number | string | undefined | null;

const formatFocused = (value: CurrencyInputValue, precision: number): string => {
  if (value === undefined || value === null || value === '' || Number(value) === 0) {
    return '';
  }
  const numericValue = Number(value);
  const hasDecimalPart = numericValue % 1 !== 0;
  return hasDecimalPart
    ? formatNumber(numericValue, precision)
    : formatNumber(numericValue, 0);
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
 * - On focus: hides ".00" for integers, empty for 0/null
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
    setIsFocused(true);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    onBlur?.(e);
  };

  // Formatter for InputNumber (used during typing)
  const formatter = (val: number | string | undefined): string => {
    if (isFocused) {
      return formatFocused(val, precision);
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
