// CurrencyInput - InputNumber with smart decimal formatting using react-number-format
// - During editing (focused): hides .00 if decimal part is zero
// - After blur: shows .00 for whole numbers
// - Thousand separators (spaces) work correctly with cursor position preserved

import React, { useState, useCallback } from 'react';
import { NumericFormat } from 'react-number-format';
import { Input } from 'antd';

interface CurrencyInputProps {
  value?: number | null;
  onChange?: (value: number | null) => void;
  precision?: number;
  min?: number;
  max?: number;
  placeholder?: string;
  style?: React.CSSProperties;
  readOnly?: boolean;
  disabled?: boolean;
  addonAfter?: React.ReactNode;
  size?: 'small' | 'middle' | 'large';
}

export const CurrencyInput: React.FC<CurrencyInputProps> = ({
  value,
  onChange,
  precision = 2,
  min,
  max,
  placeholder,
  style,
  readOnly,
  disabled,
  addonAfter,
  size,
}) => {
  const [isFocused, setIsFocused] = useState(false);

  // Determine decimal scale based on focus and value
  const getDecimalScale = (): number => {
    if (isFocused) {
      // During editing: hide .00 if decimal is zero
      if (value !== null && value !== undefined && value % 1 === 0) {
        return 0; // No decimals for whole numbers
      }
    }
    return precision; // Show full precision
  };

  // Get display value - hide zero when focused
  const getDisplayValue = () => {
    if (isFocused && (value === 0 || value === null || value === undefined)) {
      return ''; // Show empty field when focused and value is 0/null
    }
    return value ?? '';
  };

  const handleFocus = useCallback(() => {
    setIsFocused(true);
  }, []);

  const handleBlur = useCallback(() => {
    setIsFocused(false);
    // If field is empty after editing, set to 0
    if (value === null || value === undefined) {
      onChange?.(0);
    }
  }, [value, onChange]);

  const handleValueChange = useCallback((values: { floatValue: number | undefined }) => {
    let newValue = values.floatValue ?? null;

    // Apply min/max constraints
    if (newValue !== null) {
      if (min !== undefined && newValue < min) newValue = min;
      if (max !== undefined && newValue > max) newValue = max;
    }

    onChange?.(newValue);
  }, [onChange, min, max]);

  return (
    <NumericFormat
      value={getDisplayValue()}
      onValueChange={handleValueChange}
      onFocus={handleFocus}
      onBlur={handleBlur}
      thousandSeparator=" "
      decimalSeparator=","
      decimalScale={getDecimalScale()}
      fixedDecimalScale={!isFocused}
      allowNegative={min === undefined || min < 0}
      placeholder={placeholder}
      disabled={disabled}
      readOnly={readOnly}
      customInput={Input}
      style={style}
      size={size}
      addonAfter={addonAfter}
    />
  );
};

export default CurrencyInput;
