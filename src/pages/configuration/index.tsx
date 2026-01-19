import React, { useState, useEffect } from 'react';
import { Card, Tabs, Typography, Space, Empty, InputNumber, Input, Button, Tooltip, message, Spin } from 'antd';
import {
  SettingOutlined,
  FileTextOutlined,
  EyeOutlined,
  DollarOutlined,
  CheckOutlined,
  CloseOutlined,
  CameraOutlined,
} from '@ant-design/icons';
import { useAppSettings, SETTING_KEYS, CurrencySettings } from '../../hooks/useAppSettings';
import { VlmConfigTab } from './VlmConfigTab';

const { Text } = Typography;

// ============================================================================
// Компонент редактируемого поля настройки
// ============================================================================
interface EditableSettingFieldProps {
  label: string;
  value: string | number | null | undefined;
  onSave: (value: any) => Promise<void>;
  type?: 'number' | 'text';
  placeholder?: string;
  suffix?: string;
  emptyText?: string;
  hint?: string;
  formatter?: (value: number | string | undefined) => string;
  parser?: (value: string | undefined) => number | string;
}

const EditableSettingField: React.FC<EditableSettingFieldProps> = ({
  label,
  value,
  onSave,
  type = 'text',
  placeholder = 'не задано',
  suffix,
  emptyText = 'не задано',
  hint,
  formatter,
  parser,
}) => {
  const [isEditing, setIsEditing] = useState(false);
  const [editValue, setEditValue] = useState<any>(value);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    setEditValue(value);
  }, [value]);

  const handleDoubleClick = () => {
    setEditValue(value);
    setIsEditing(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await onSave(editValue);
      setIsEditing(false);
      message.success('Сохранено');
    } catch (error) {
      message.error('Ошибка сохранения');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditValue(value);
    setIsEditing(false);
  };

  const formatDisplayValue = (val: any): string => {
    if (val === null || val === undefined || val === '') {
      return emptyText;
    }
    if (type === 'number' && typeof val === 'number') {
      return val.toLocaleString('ru-RU') + (suffix ? ` ${suffix}` : '');
    }
    return String(val) + (suffix ? ` ${suffix}` : '');
  };

  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
      <Text strong style={{ minWidth: 200 }}>{label}:</Text>

      {isEditing ? (
        <>
          {type === 'number' ? (
            <InputNumber
              value={editValue}
              onChange={(val) => setEditValue(val)}
              min={0}
              style={{ width: 150 }}
              placeholder={placeholder}
              formatter={formatter as any}
              parser={parser as any}
              autoFocus
            />
          ) : (
            <Input
              value={editValue}
              onChange={(e) => setEditValue(e.target.value)}
              style={{ width: 150 }}
              placeholder={placeholder}
              autoFocus
            />
          )}
          <Tooltip title="Сохранить">
            <Button
              type="primary"
              icon={<CheckOutlined />}
              size="small"
              onClick={handleSave}
              loading={isSaving}
            />
          </Tooltip>
          <Tooltip title="Отмена">
            <Button
              icon={<CloseOutlined />}
              size="small"
              onClick={handleCancel}
              disabled={isSaving}
            />
          </Tooltip>
        </>
      ) : (
        <>
          <Tooltip title="Двойной клик для редактирования">
            <Text
              onDoubleClick={handleDoubleClick}
              style={{
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: 4,
                backgroundColor: '#fafafa',
                border: '1px solid #d9d9d9',
                minWidth: 150,
                display: 'inline-block',
              }}
            >
              {formatDisplayValue(value)}
            </Text>
          </Tooltip>
          {hint && (value === null || value === undefined) && (
            <Text type="secondary" style={{ fontSize: 12 }}>
              ({hint})
            </Text>
          )}
        </>
      )}
    </div>
  );
};

// ============================================================================
// Вкладка: Настройки заказов
// ============================================================================
const OrdersConfigTab: React.FC = () => {
  const { getSetting, saveSetting, isLoading } = useAppSettings();

  const minOrderAmount = getSetting<number>(SETTING_KEYS.ORDERS_MIN_TOTAL_AMOUNT);

  const handleSaveMinAmount = async (value: number | null) => {
    await saveSetting(
      SETTING_KEYS.ORDERS_MIN_TOTAL_AMOUNT,
      value,
      'Минимальная сумма заказа'
    );
  };

  if (isLoading) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 0' }}>
      <EditableSettingField
        label="Минимальная сумма заказа"
        value={minOrderAmount}
        onSave={handleSaveMinAmount}
        type="number"
        suffix="₸"
        hint="ограничение отсутствует"
        formatter={(value) => (value ? `${value}`.replace(/\B(?=(\d{3})+(?!\d))/g, ' ') : '')}
        parser={(value) => Number(value?.replace(/\s/g, '') || 0)}
      />
    </div>
  );
};

// ============================================================================
// Вкладка: Настройки финансов
// ============================================================================
const FinanceConfigTab: React.FC = () => {
  const { getSetting, saveSetting, isLoading } = useAppSettings();

  const currency = getSetting<CurrencySettings>(SETTING_KEYS.APP_CURRENCY);

  const [isEditing, setIsEditing] = useState(false);
  const [editCode, setEditCode] = useState(currency?.code || 'KZT');
  const [editSymbol, setEditSymbol] = useState(currency?.symbol || '₸');
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (currency) {
      setEditCode(currency.code);
      setEditSymbol(currency.symbol);
    }
  }, [currency]);

  const handleDoubleClick = () => {
    setEditCode(currency?.code || 'KZT');
    setEditSymbol(currency?.symbol || '₸');
    setIsEditing(true);
  };

  const handleSave = async () => {
    setIsSaving(true);
    try {
      await saveSetting(
        SETTING_KEYS.APP_CURRENCY,
        { code: editCode, symbol: editSymbol },
        'Базовая валюта приложения'
      );
      setIsEditing(false);
      message.success('Сохранено');
    } catch (error) {
      message.error('Ошибка сохранения');
    } finally {
      setIsSaving(false);
    }
  };

  const handleCancel = () => {
    setEditCode(currency?.code || 'KZT');
    setEditSymbol(currency?.symbol || '₸');
    setIsEditing(false);
  };

  if (isLoading) {
    return (
      <div style={{ padding: '32px', textAlign: 'center' }}>
        <Spin />
      </div>
    );
  }

  return (
    <div style={{ padding: '16px 0' }}>
      <Text strong style={{ display: 'block', marginBottom: 16 }}>Базовая валюта приложения</Text>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 12 }}>
        <Text style={{ minWidth: 200 }}>Код валюты:</Text>

        {isEditing ? (
          <Input
            value={editCode}
            onChange={(e) => setEditCode(e.target.value.toUpperCase())}
            style={{ width: 100 }}
            maxLength={3}
            autoFocus
          />
        ) : (
          <Tooltip title="Двойной клик для редактирования">
            <Text
              onDoubleClick={handleDoubleClick}
              style={{
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: 4,
                backgroundColor: '#fafafa',
                border: '1px solid #d9d9d9',
                minWidth: 100,
                display: 'inline-block',
              }}
            >
              {currency?.code || 'KZT'}
            </Text>
          </Tooltip>
        )}
      </div>

      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <Text style={{ minWidth: 200 }}>Символ валюты:</Text>

        {isEditing ? (
          <>
            <Input
              value={editSymbol}
              onChange={(e) => setEditSymbol(e.target.value)}
              style={{ width: 100 }}
              maxLength={5}
            />
            <Tooltip title="Сохранить">
              <Button
                type="primary"
                icon={<CheckOutlined />}
                size="small"
                onClick={handleSave}
                loading={isSaving}
              />
            </Tooltip>
            <Tooltip title="Отмена">
              <Button
                icon={<CloseOutlined />}
                size="small"
                onClick={handleCancel}
                disabled={isSaving}
              />
            </Tooltip>
          </>
        ) : (
          <Tooltip title="Двойной клик для редактирования">
            <Text
              onDoubleClick={handleDoubleClick}
              style={{
                cursor: 'pointer',
                padding: '4px 8px',
                borderRadius: 4,
                backgroundColor: '#fafafa',
                border: '1px solid #d9d9d9',
                minWidth: 100,
                display: 'inline-block',
              }}
            >
              {currency?.symbol || '₸'}
            </Text>
          </Tooltip>
        )}
      </div>
    </div>
  );
};

// ============================================================================
// Вкладка: Видимость ресурсов
// ============================================================================
const ResourceVisibilityTab: React.FC = () => {
  return (
    <div style={{ padding: '16px 0' }}>
      <Empty
        description={
          <Space direction="vertical" size="small">
            <Text type="secondary">Настройки видимости ресурсов</Text>
            <Text type="secondary" style={{ fontSize: 12 }}>
              В разработке
            </Text>
          </Space>
        }
      />
    </div>
  );
};

// ============================================================================
// Главная страница конфигурации
// ============================================================================
export const ConfigurationPage: React.FC = () => {
  const [activeTab, setActiveTab] = useState('orders');

  const tabItems = [
    {
      key: 'orders',
      label: (
        <span>
          <FileTextOutlined />
          Заказы
        </span>
      ),
      children: <OrdersConfigTab />,
    },
    {
      key: 'finance',
      label: (
        <span>
          <DollarOutlined />
          Финансы
        </span>
      ),
      children: <FinanceConfigTab />,
    },
    {
      key: 'visibility',
      label: (
        <span>
          <EyeOutlined />
          Видимость ресурсов
        </span>
      ),
      children: <ResourceVisibilityTab />,
    },
    {
      key: 'vlm',
      label: (
        <span>
          <CameraOutlined />
          Анализ фото
        </span>
      ),
      children: <VlmConfigTab />,
    },
  ];

  return (
    <Card
      title={
        <Space>
          <SettingOutlined />
          <span>Конфигурация</span>
        </Space>
      }
    >
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        type="card"
      />
    </Card>
  );
};

export default ConfigurationPage;
