import React from 'react';
import { TimePicker, type TimePickerProps } from 'antd';
import type { Dayjs } from 'dayjs';

/**
 * antd 5.0.5 / rc-picker 3.1.5: for picker="time" a clicked cell only updates the
 * internal selectedValue; the value is committed (onChange) by the panel "OK"
 * button or Enter. rc-picker also uses blurToCancel, so clicking outside the
 * panel (for example on a "Save" button) reverts the selection. To make a mouse
 * selection stick, commit on every cell click via onSelect.
 */
export const CommitOnSelectTimePicker: React.FC<TimePickerProps> = ({ onSelect, onChange, format, ...rest }) => {
  const handleSelect = (value: Dayjs) => {
    onSelect?.(value);
    const pattern = typeof format === 'string' ? format : 'HH:mm';
    (onChange as ((date: Dayjs, dateString: string) => void) | undefined)?.(value, value.format(pattern));
  };
  return <TimePicker {...rest} format={format} onChange={onChange} onSelect={handleSelect} />;
};
