import React, { type PropsWithChildren } from 'react';
import { Alert, Button, Skeleton, Space, Typography } from 'antd';
import { LoadingOutlined } from '@ant-design/icons';

export interface OrderProgressiveLoadingInput {
  hasPrimaryData: boolean;
  primaryPending: boolean;
  primaryFetching: boolean;
  sectionPending?: boolean;
}

export interface OrderProgressiveLoadingState {
  isInitialLoading: boolean;
  isRefreshing: boolean;
  isSectionLoading: boolean;
}

export function deriveOrderProgressiveLoadingState({
  hasPrimaryData,
  primaryPending,
  primaryFetching,
  sectionPending = false,
}: OrderProgressiveLoadingInput): OrderProgressiveLoadingState {
  return {
    isInitialLoading: !hasPrimaryData && (primaryPending || primaryFetching),
    isRefreshing: hasPrimaryData && primaryFetching,
    isSectionLoading: hasPrimaryData && sectionPending,
  };
}

export const OrderInitialSkeleton: React.FC<{
  variant: 'list' | 'show' | 'form';
  label: string;
}> = ({ variant, label }) => {
  const rows = variant === 'list' ? 9 : variant === 'form' ? 7 : 6;
  const minHeight = variant === 'list' ? 620 : 520;

  return (
    <div
      data-order-loading="initial"
      data-order-loading-variant={variant}
      role="status"
      aria-live="polite"
      aria-busy="true"
      aria-label={label}
      style={{ minHeight, padding: 16 }}
    >
      <Skeleton
        active
        title={{ width: variant === 'list' ? '24%' : '38%' }}
        paragraph={{ rows: 2, width: ['72%', '48%'] }}
      />
      <div style={{ marginTop: 24 }}>
        <Skeleton
          active
          title={false}
          paragraph={{
            rows,
            width: Array.from({ length: rows }, (_, index) => (
              index === rows - 1 ? '68%' : '100%'
            )),
          }}
        />
      </div>
    </div>
  );
};

export const OrderNonBlockingLoadingStatus: React.FC<{
  active: boolean;
  label: string;
}> = ({ active, label }) => (
  <div
    {...(active
      ? { role: 'status', 'aria-live': 'polite' as const, 'aria-atomic': true }
      : { 'aria-hidden': true })}
    data-order-loading={active ? 'background' : 'idle'}
    style={{ minHeight: 24, display: 'flex', alignItems: 'center' }}
  >
    {active ? (
      <Space size={6}>
        <LoadingOutlined spin aria-hidden />
        <Typography.Text type="secondary">{label}</Typography.Text>
      </Space>
    ) : null}
  </div>
);

export const OrderSectionError: React.FC<{
  message: string;
  description?: string;
  onRetry?: () => void;
}> = ({ message, description, onRetry }) => (
  <Alert
    type="error"
    showIcon
    message={message}
    description={description}
    action={onRetry ? <Button size="small" onClick={onRetry}>Повторить</Button> : undefined}
    style={{ marginBottom: 12 }}
  />
);

export const OrderProgressiveSurface: React.FC<PropsWithChildren<{
  state: OrderProgressiveLoadingState;
  variant: 'list' | 'show' | 'form';
  initialLabel: string;
  refreshLabel: string;
  error?: {
    message: string;
    description?: string;
  } | null;
  onRetry?: () => void;
}>> = ({
  state,
  variant,
  initialLabel,
  refreshLabel,
  error,
  onRetry,
  children,
}) => (
  <>
    <OrderNonBlockingLoadingStatus
      active={state.isRefreshing || state.isSectionLoading}
      label={refreshLabel}
    />
    {error ? (
      <OrderSectionError
        message={error.message}
        description={error.description}
        onRetry={onRetry}
      />
    ) : null}
    {state.isInitialLoading ? (
      <OrderInitialSkeleton variant={variant} label={initialLabel} />
    ) : children}
  </>
);

interface OrderPageProgressiveSurfaceProps {
  state: OrderProgressiveLoadingState;
  onRetry: () => void;
}

export const OrderListProgressiveSurface: React.FC<PropsWithChildren<
  OrderPageProgressiveSurfaceProps & {
    hasPrimaryData: boolean;
    queryError: boolean;
  }
>> = ({ state, hasPrimaryData, queryError, onRetry, children }) => (
  <OrderProgressiveSurface
    state={state}
    variant="list"
    initialLabel="Загрузка списка заказов"
    refreshLabel="Обновляем список заказов"
    error={queryError ? {
      message: 'Не удалось обновить список заказов',
      description: hasPrimaryData ? 'Показываем последние доступные данные.' : undefined,
    } : null}
    onRetry={onRetry}
  >
    {children}
  </OrderProgressiveSurface>
);

export const OrderShowProgressiveSurface: React.FC<PropsWithChildren<
  OrderPageProgressiveSurfaceProps & {
    hasDeletedOrder: boolean;
    hasPrimaryData: boolean;
    queryError: boolean;
    sectionError: boolean;
    onSectionRetry: () => void;
  }
>> = ({
  state,
  hasDeletedOrder,
  hasPrimaryData,
  queryError,
  sectionError,
  onRetry,
  onSectionRetry,
  children,
}) => {
  const primaryError = queryError && !hasDeletedOrder && !state.isInitialLoading;
  const visibleSectionError = sectionError && hasPrimaryData && !state.isInitialLoading;

  return (
    <OrderProgressiveSurface
      state={state}
      variant="show"
      initialLabel="Загрузка карточки заказа"
      refreshLabel={state.isRefreshing
        ? 'Обновляем карточку заказа'
        : 'Загружаем состав заказа'}
      error={primaryError ? {
        message: 'Не удалось загрузить карточку заказа',
        description: hasPrimaryData ? 'Показываем последние доступные данные.' : undefined,
      } : visibleSectionError ? {
        message: 'Не удалось загрузить состав заказа',
        description: 'Карточка доступна, состав может быть неполным.',
      } : null}
      onRetry={primaryError ? onRetry : onSectionRetry}
    >
      {children}
    </OrderProgressiveSurface>
  );
};

export const OrderFormProgressiveSurface: React.FC<PropsWithChildren<
  OrderPageProgressiveSurfaceProps & { error: Error | null }
>> = ({ state, error, onRetry, children }) => (
  <OrderProgressiveSurface
    state={state}
    variant="form"
    initialLabel="Загрузка формы заказа"
    refreshLabel="Обновляем данные формы"
    error={error ? {
      message: 'Не удалось обновить справочники формы',
      description: error.message,
    } : null}
    onRetry={onRetry}
  >
    {children}
  </OrderProgressiveSurface>
);
