import React, { useState, useEffect, useMemo } from 'react';
import { Card, Tabs, Typography, Space, InputNumber, Input, Button, Tooltip, message, Spin, Table, Checkbox } from 'antd';
import { useList, useResource } from '@refinedev/core';
import {
  SettingOutlined,
  FileTextOutlined,
  EyeOutlined,
  DollarOutlined,
  CheckOutlined,
  CloseOutlined,
  CameraOutlined,
  BuildOutlined,
  ClockCircleOutlined,
  BellOutlined,
  ApartmentOutlined,
  ScissorOutlined,
} from '@ant-design/icons';
import { useAppSettings, SETTING_KEYS, CurrencySettings } from '../../hooks/useAppSettings';
import { featureFlags } from '../../config/featureFlags';
import { VlmConfigTab } from './VlmConfigTab';
import { ProductionWorkflowTab } from './components/ProductionWorkflowTab';
import { DeadlineTransitionRulesConfig } from './components/DeadlineTransitionRulesConfig';
import { NotificationRulesConfig } from './components/NotificationRulesConfig';
import { OrgStructureConfig } from './components/OrgStructureConfig';
import { CutConfigTab } from './components/CutConfigTab';
import {
  buildInitialResourceVisibility,
  getMenuResources,
  normalizeRoleKey,
  normalizeRoleVisibilityMatrix,
  type RoleVisibilityMatrix,
  type VisibilityRole,
} from '../../utils/resourceVisibility';
import { RESOURCE_LABELS } from '../../utils/tabLabels';

const { Text } = Typography;

interface RoleRow {
  role_id: number | string;
  role_name: string;
  is_active?: boolean;
}

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
// Вкладка: Видимость таблиц для ролей
// ============================================================================
const TableVisibilityByRoleTab: React.FC = () => {
  const { resources } = useResource();
  const { getSetting, saveSetting, isLoading: isSettingsLoading } = useAppSettings();
  const { data: rolesData, isLoading: isRolesLoading } = useList<RoleRow>({
    resource: 'roles',
    pagination: { mode: 'off' },
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    queryOptions: { refetchOnWindowFocus: false },
  });

  const roles = useMemo(
    () => (rolesData?.data ?? []).filter((role) => role.is_active !== false),
    [rolesData],
  );
  const menuResources = useMemo(
    () => getMenuResources(resources, RESOURCE_LABELS),
    [resources],
  );
  const savedMatrix = normalizeRoleVisibilityMatrix(
    getSetting<RoleVisibilityMatrix>(SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE),
  );
  const matrix = useMemo(
    () => buildInitialResourceVisibility(menuResources, roles, savedMatrix),
    [menuResources, roles, savedMatrix],
  );

  const handleToggle = async (resourceName: string, role: VisibilityRole, checked: boolean) => {
    const roleKey = normalizeRoleKey(role);
    const nextMatrix: RoleVisibilityMatrix = {
      ...matrix,
      [resourceName]: {
        ...(matrix[resourceName] ?? {}),
        [roleKey]: checked,
      },
    };

    await saveSetting(
      SETTING_KEYS.RESOURCE_VISIBILITY_BY_ROLE,
      nextMatrix,
      'Видимость пунктов меню по ролям',
    );
    message.success('Видимость обновлена');
  };

  const columns = [
    {
      title: 'Таблица / пункт меню',
      dataIndex: 'label',
      key: 'label',
      fixed: 'left' as const,
      width: 260,
      render: (_: string, record: { name: string; label: string; route: string }) => (
        <Space direction="vertical" size={0}>
          <Text strong>{record.label}</Text>
          <Text type="secondary" style={{ fontSize: 12 }}>{record.route}</Text>
        </Space>
      ),
    },
    ...roles.map((role) => {
      const roleKey = normalizeRoleKey(role);
      return {
        title: role.role_name || roleKey,
        dataIndex: roleKey,
        key: roleKey,
        align: 'center' as const,
        width: 140,
        render: (_: unknown, record: { name: string }) => (
          <Checkbox
            checked={matrix[record.name]?.[roleKey] ?? true}
            onChange={(event) => handleToggle(record.name, role, event.target.checked)}
          />
        ),
      };
    }),
  ];

  return (
    <div style={{ padding: '16px 0' }}>
      <Table
        rowKey="name"
        loading={isSettingsLoading || isRolesLoading}
        dataSource={menuResources}
        columns={columns}
        pagination={false}
        size="middle"
        scroll={{ x: 'max-content' }}
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
      key: 'production',
      label: (
        <span>
          <BuildOutlined />
          Этапы производства
        </span>
      ),
      children: <ProductionWorkflowTab />,
    },
    {
      key: 'deadline-rules',
      label: (
        <span>
          <ClockCircleOutlined />
          Дедлайн-правила
        </span>
      ),
      children: <DeadlineTransitionRulesConfig />,
    },
    {
      key: 'notification-rules',
      label: (
        <span>
          <BellOutlined />
          Уведомления
        </span>
      ),
      children: <NotificationRulesConfig />,
    },
    {
      key: 'org-structure',
      label: (
        <span>
          <ApartmentOutlined />
          Орг-структура
        </span>
      ),
      children: <OrgStructureConfig />,
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
      key: 'table-visibility',
      label: (
        <span>
          <EyeOutlined />
          Видимость таблиц для юзеров
        </span>
      ),
      children: <TableVisibilityByRoleTab />,
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
    ...(featureFlags.useBackendCut
      ? [
          {
            key: 'cut',
            label: (
              <span>
                <ScissorOutlined />
                Раскрой
              </span>
            ),
            children: <CutConfigTab />,
          },
        ]
      : []),
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
        className="configuration-tabs-wrap"
        activeKey={activeTab}
        onChange={setActiveTab}
        items={tabItems}
        type="card"
        tabBarGutter={8}
      />
    </Card>
  );
};

export default ConfigurationPage;
