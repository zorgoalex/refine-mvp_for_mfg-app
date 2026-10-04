import { Show } from '@refinedev/antd';
import type { IResourceComponentsProps } from '@refinedev/core';
import { Alert, Spin } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';

import { isApiError } from '../../api/apiError';
import { ordersApi } from '../../api/ordersApi';
import type { OrderResourceCapabilitiesDto, OrderResourceCardDto } from '../../api/types/orderApi.types';
import { useProcurementPermission } from './ProcurementParts';
import { RESOURCE_CARD_MODES, ResourceDemandCard, type ResourceCardMode } from './ResourceDemandCard';
import { useStoredViewMode } from './useStoredViewMode';

type LoadState =
  | { status: 'loading' }
  | { status: 'invalid' }
  | { status: 'error'; message: string }
  | { status: 'unavailable' }
  | { status: 'ready'; data: OrderResourceCardDto; capabilities: OrderResourceCapabilitiesDto };

const BACK_TO_LIST = <Link to="/order-resource-requirements">Вернуться к списку</Link>;

/**
 * Карточка потребностей заказа отдельной страницей (не Drawer). Доступна
 * только при `capabilities.cardDetails` — без неё показывает Alert и ссылку
 * назад на список (совместимость со старым backend/выключенным флагом).
 */
export const OrderResourceRequirementShow: React.FC<IResourceComponentsProps> = () => {
  const { orderId: orderIdParam } = useParams<{ orderId: string }>();
  const orderId = Number(orderIdParam);
  const isValidOrderId = Number.isFinite(orderId) && orderId > 0;
  const [state, setState] = useState<LoadState>({ status: isValidOrderId ? 'loading' : 'invalid' });
  const [revision, setRevision] = useState(0);
  const { canManage, manageLoading } = useProcurementPermission();
  const [cardMode, setCardMode] = useStoredViewMode<ResourceCardMode>(
    'order-resource-requirements:card-view',
    RESOURCE_CARD_MODES,
    'tabs',
  );

  useEffect(() => {
    if (!isValidOrderId) {
      setState({ status: 'invalid' });
      return;
    }
    let active = true;
    setState({ status: 'loading' });
    ordersApi.getResourceDemandCard(orderId)
      .then((response) => {
        if (!active) return;
        if (!response.capabilities.cardDetails) {
          setState({ status: 'unavailable' });
          return;
        }
        setState({ status: 'ready', data: response.data, capabilities: response.capabilities });
      })
      .catch((error: unknown) => {
        if (!active) return;
        if (isApiError(error, 'ORDER_NOT_FOUND')) {
          setState({ status: 'error', message: 'Заказ не найден или недоступен.' });
          return;
        }
        if (isApiError(error, 'PERMISSION_DENIED') || isApiError(error, 'AUTH_REQUIRED')) {
          setState({ status: 'error', message: 'Недостаточно прав для просмотра потребностей заказа.' });
          return;
        }
        // Старый backend без этого маршрута, выключенный флаг и т.п. — трактуем как отсутствие возможности.
        setState({ status: 'unavailable' });
      });
    return () => {
      active = false;
    };
  }, [isValidOrderId, orderId, revision]);

  const refresh = useCallback(() => setRevision((value) => value + 1), []);

  return (
    <Show title="Потребности заказа в ресурсах" canDelete={false} canEdit={false} headerButtons={() => null}>
      {state.status === 'loading' && <Spin />}
      {state.status === 'invalid' && (
        <Alert showIcon type="error" message="Некорректный номер заказа" description={BACK_TO_LIST} />
      )}
      {state.status === 'unavailable' && (
        <Alert
          showIcon
          type="info"
          message="Карточка потребностей недоступна"
          description={<>Функция ещё не включена на сервере. {BACK_TO_LIST}</>}
        />
      )}
      {state.status === 'error' && (
        <Alert
          showIcon
          type="error"
          message="Не удалось открыть карточку"
          description={<>{state.message} {BACK_TO_LIST}</>}
        />
      )}
      {state.status === 'ready' && (
        <ResourceDemandCard
          row={state.data}
          mode={cardMode}
          onModeChange={setCardMode}
          capabilities={state.capabilities}
          canManage={canManage}
          manageLoading={manageLoading}
          onProcurementChanged={refresh}
          card={{ data: state.data, loading: false, error: null, refresh }}
        />
      )}
    </Show>
  );
};
