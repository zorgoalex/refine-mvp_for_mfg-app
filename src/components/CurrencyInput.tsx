// CurrencyInput - InputNumber with smart focus/blur formatting
// Focus: hides ".00" for integers, shows empty for 0
// Blur: shows ".00" and "0"

import React, { useState, useRef, useEffect } from 'react';
import { InputNumber, InputNumberProps } from 'antd';
import { formatNumber, numberParser } from '../utils/numberFormat';

interface CurrencyInputProps extends Omit<InputNumberProps, 'formatter' | 'parser'> {
  /** Decimal precision (default: 2) */
  precision?: number;
}

/**
 * Format value for focused state: hide ".00" for integers, empty for 0
 */
const formatFocused = (value: number | undefined | null, precision: number): string => {
  if (value === undefined || value === null || value === 0) {
    return '';
  }
  const hasDecimalPart = value % 1 !== 0;
  return hasDecimalPart
    ? formatNumber(value, precision)
    : formatNumber(value, 0);
};

/**
 * Format value for blurred state: always show full precision
 */
const formatBlurred = (value: number | undefined | null, precision: number): string => {
  if (value === undefined || value === null) {
    return '0';
  }
  return formatNumber(value, precision);
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
  ...props
}) => {
  const inputRef = useRef<HTMLInputElement>(null);
  const [isFocused, setIsFocused] = useState(false);

  // Update input display when focus changes
  useEffect(() => {
    const input = inputRef.current?.querySelector?.('input') || inputRef.current;
    if (input && input instanceof HTMLInputElement) {
      const numValue = typeof value === 'number' ? value : undefined;
      const displayValue = isFocused
        ? formatFocused(numValue, precision)
        : formatBlurred(numValue, precision);

      // Only update if different to avoid cursor jumping
      if (input.value !== displayValue) {
        input.value = displayValue;
      }
    }
  }, [isFocused, value, precision]);

  const handleFocus = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(true);
    // Format immediately on focus
    const numValue = typeof value === 'number' ? value : undefined;
    e.target.value = formatFocused(numValue, precision);
    onFocus?.(e);
  };

  const handleBlur = (e: React.FocusEvent<HTMLInputElement>) => {
    setIsFocused(false);
    // Format immediately on blur
    const numValue = typeof value === 'number' ? value : undefined;
    e.target.value = formatBlurred(numValue, precision);
    onBlur?.(e);
  };

  // Formatter for InputNumber (used during typing)
  const formatter = (val: number | undefined): string => {
    if (isFocused) {
      return formatFocused(val, precision);
    }
    return formatBlurred(val, precision);
  };

  return (
    <InputNumber
      ref={inputRef}
      {...props}
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
