import React from 'react';
import { Button, Form, Space, Typography } from 'antd';
import { DEFAULT_STATUS_COLOR, normalizeStatusColor } from './statusColorUtils';
import './StatusColor.css';

interface StatusColorPickerProps {
  value?: string | null;
  onChange?: (value: string | null) => void;
  disabled?: boolean;
}

export const StatusColorPicker: React.FC<StatusColorPickerProps> = ({
  value,
  onChange,
  disabled = false,
}) => {
  const color = normalizeStatusColor(value);

  return (
    <Space align="center" size={12} wrap>
      <label
        className="status-color-picker__trigger"
        title={color ? `Изменить цвет ${color}` : 'Выбрать цвет статуса'}
      >
        <input
          aria-label="Выбрать цвет статуса"
          className="status-color-picker__input"
          disabled={disabled}
          type="color"
          value={color ?? DEFAULT_STATUS_COLOR}
          onChange={(event) => {
            onChange?.(normalizeStatusColor(event.target.value) ?? null);
          }}
        />
        <span
          aria-hidden="true"
          className={`status-color-picker__preview${color ? '' : ' status-color-picker__preview--empty'}`}
          style={color ? { backgroundColor: color } : undefined}
        >
          {color ? null : '+'}
        </span>
      </label>

      <Typography.Text code className="status-color-picker__value">
        {color ?? 'Не выбран'}
      </Typography.Text>

      {color ? (
        <Button
          className="status-color-picker__clear"
          disabled={disabled}
          onClick={() => onChange?.(null)}
        >
          Очистить
        </Button>
      ) : null}
    </Space>
  );
};

export const StatusColorFormItem: React.FC = () => (
  <Form.Item label="Цвет статуса" name="color">
    <StatusColorPicker />
  </Form.Item>
);

export const StatusColorSwatch: React.FC<{ value: unknown }> = ({ value }) => {
  const color = normalizeStatusColor(value);

  if (!color) return <span aria-label="Цвет не задан">—</span>;

  return (
    <span
      aria-label={`Цвет статуса ${color}`}
      className="status-color-swatch"
      role="img"
      style={{ backgroundColor: color }}
      title={color}
    />
  );
};

