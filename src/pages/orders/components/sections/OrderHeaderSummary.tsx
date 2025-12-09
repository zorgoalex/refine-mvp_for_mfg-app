// Order Header Summary (Read-only)
// Compact minimalist design - 3 rows with minimal padding

import React, { useMemo } from 'react';
import { Tag, Space, Typography } from 'antd';
import { StarOutlined } from '@ant-design/icons';
import { useOne, useList } from '@refinedev/core';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { getMaterialColor } from '../../../../config/displayColors';
import dayjs from 'dayjs';

const { Text } = Typography;

export const OrderHeaderSummary: React.FC = () => {
  const { header, details, payments, isPaymentStatusManual, dowelingLinks } = useOrderFormStore();

  // FIX: Calculate totals directly from details/payments for proper reactivity
  const totals = useMemo(() => ({
    positions_count: details.length,
    parts_count: details.reduce((sum, d) => sum + (d.quantity || 0), 0),
    total_area: details.reduce((sum, d) => sum + (d.area || 0), 0),
    total_paid: payments.reduce((sum, p) => sum + (p.amount || 0), 0),
    total_amount: details.reduce((sum, d) => sum + (d.detail_cost || 0), 0),
  }), [details, payments]);

  // Get the latest (last added) doweling link for header display
  const latestDowelingLink = useMemo(() => {
    if (!dowelingLinks || dowelingLinks.length === 0) return null;
    // Return the last one (most recently added)
    return dowelingLinks[dowelingLinks.length - 1];
  }, [dowelingLinks]);

  // Load employees for design_engineer lookup
  const { data: employeesData } = useList({
    resource: 'employees',
    pagination: { pageSize: 1000 },
  });

  const employeesMap = useMemo(() => new Map(
    (employeesData?.data || []).map((e: any) => [e.employee_id, e.full_name])
  ), [employeesData]);

  // Get unique material IDs from details
  const uniqueMaterialIds = useMemo(() => {
    const ids = details
      .map(d => d.material_id)
      .filter((id): id is number => id !== null && id !== undefined);
    return [...new Set(ids)];
  }, [details]);

  // Load client name
  const { data: clientData } = useOne({
    resource: 'clients',
    id: header.client_id,
    queryOptions: {
      enabled: !!header.client_id,
    },
  });

  // Load client phones
  const { data: clientPhonesData } = useList({
    resource: 'client_phones',
    filters: [
      { field: 'client_id', operator: 'eq', value: header.client_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!header.client_id,
    },
  });

  // Format phone number as "8 xxx xxx xxxx"
  const formatPhone = (phone: string): string => {
    const digits = phone.replace(/\D/g, '');
    if (digits.length === 11) {
      return `8 ${digits.slice(1, 4)} ${digits.slice(4, 7)} ${digits.slice(7, 11)}`;
    } else if (digits.length === 10) {
      return `8 ${digits.slice(0, 3)} ${digits.slice(3, 6)} ${digits.slice(6, 10)}`;
    }
    return phone;
  };

  // Find primary phone (or first available)
  const primaryPhone = useMemo(() => {
    const phones = clientPhonesData?.data || [];
    const primary = phones.find((p: any) => p.is_primary);
    const phoneNumber = primary?.phone_number || phones[0]?.phone_number;
    return phoneNumber ? formatPhone(phoneNumber) : null;
  }, [clientPhonesData]);

  // Load order status
  const { data: orderStatusData } = useOne({
    resource: 'order_statuses',
    id: header.order_status_id,
    queryOptions: {
      enabled: !!header.order_status_id,
    },
  });

  // Load payment status
  const { data: paymentStatusData } = useOne({
    resource: 'payment_statuses',
    id: header.payment_status_id,
    queryOptions: {
      enabled: !!header.payment_status_id,
    },
  });

  // Load materials list
  const { data: materialsData } = useList({
    resource: 'materials',
    filters: uniqueMaterialIds.length > 0 ? [
      { field: 'material_id', operator: 'in', value: uniqueMaterialIds }
    ] : [],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: uniqueMaterialIds.length > 0,
    },
  });

  // Create materials summary string
  const materialsSummary = useMemo(() => {
    if (!materialsData?.data || materialsData.data.length === 0) return '—';
    return materialsData.data
      .map(m => m.material_name)
      .filter(Boolean)
      .join(', ');
  }, [materialsData]);

  // Load milling types, edge types, films для lookup
  const { data: millingTypesData } = useList({
    resource: 'milling_types',
    pagination: { pageSize: 10000 },
  });

  const { data: edgeTypesData } = useList({
    resource: 'edge_types',
    pagination: { pageSize: 10000 },
  });

  const { data: filmsData } = useList({
    resource: 'films',
    pagination: { pageSize: 10000 },
    filters: [],
  });

  // Создаем lookup maps
  const millingTypesMap = new Map(
    (millingTypesData?.data || []).map((item: any) => [item.milling_type_id, item.milling_type_name])
  );
  const edgeTypesMap = new Map(
    (edgeTypesData?.data || []).map((item: any) => [item.edge_type_id, item.edge_type_name])
  );
  const filmsMap = new Map(
    (filmsData?.data || []).map((item: any) => [item.film_id, item.film_name])
  );

  // Вычисляем общие значения для всех деталей
  const commonProductionValues = useMemo(() => {
    if (!details || details.length === 0) {
      return {
        millingTypeName: '—',
        edgeTypeName: '—',
        filmName: '—',
      };
    }

    // Проверяем milling_type_id
    const millingTypeIds = details.map(d => d.milling_type_id).filter(id => id !== null && id !== undefined);
    const uniqueMillingTypeIds = [...new Set(millingTypeIds)];
    const millingTypeName = uniqueMillingTypeIds.length === 1 && uniqueMillingTypeIds[0]
      ? millingTypesMap.get(uniqueMillingTypeIds[0]) || '—'
      : '—';

    // Проверяем edge_type_id
    const edgeTypeIds = details.map(d => d.edge_type_id).filter(id => id !== null && id !== undefined);
    const uniqueEdgeTypeIds = [...new Set(edgeTypeIds)];
    const edgeTypeName = uniqueEdgeTypeIds.length === 1 && uniqueEdgeTypeIds[0]
      ? edgeTypesMap.get(uniqueEdgeTypeIds[0]) || '—'
      : '—';

    // Проверяем film_id
    const filmIds = details.map(d => d.film_id).filter(id => id !== null && id !== undefined);
    const uniqueFilmIds = [...new Set(filmIds)];
    const filmName = uniqueFilmIds.length === 1 && uniqueFilmIds[0]
      ? filmsMap.get(uniqueFilmIds[0]) || '—'
      : '—';

    return {
      millingTypeName,
      edgeTypeName,
      filmName,
    };
  }, [details, millingTypesMap, edgeTypesMap, filmsMap]);

  // Row separator line
  const RowSeparator = () => (
    <div style={{ height: 1, background: '#E5E7EB', margin: 0 }} />
  );

  return (
    <div
      style={{
        marginTop: -12,
        marginBottom: 16,
        border: '1px solid #1890ff',
        borderRadius: 6,
        background: '#FFFFFF',
        overflow: 'hidden',
      }}
    >
      {/* Row 1: Order name, priority, status | Client | Discounted amount, discount %, payment status */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        {/* Column 1: Order name + Priority + Order status */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#111827' }}>
            {header.order_name || 'Новый заказ'}
          </Text>
          <Space size={8}>
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <StarOutlined
                style={{
                  fontSize: 14,
                  marginRight: 4,
                  color: header.priority && header.priority <= 50 ? '#D97706' : '#6B7280'
                }}
              />
              <Text style={{ fontSize: 13, color: '#111827' }}>
                {header.priority !== undefined ? formatNumber(header.priority, 0) : '—'}
              </Text>
            </span>
            <Tag
              color={
                orderStatusData?.data?.order_status_name === 'Готов к выдаче'
                  ? '#059669'
                  : orderStatusData?.data?.order_status_name === 'Предварительный'
                  ? '#91caff'
                  : '#4F46E5'
              }
              style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
            >
              {orderStatusData?.data?.order_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
            </Tag>
          </Space>
        </div>

        {/* Column 2: Client + Phone */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          <Text strong style={{ fontSize: 16, color: '#111827' }}>
            {clientData?.data?.client_name || '—'}
          </Text>
          {primaryPhone && (
            <>
              <span style={{ margin: '0 16px', color: '#E5E7EB' }}>|</span>
              <Text style={{ fontSize: 12.8, fontStyle: 'italic', color: '#111827' }}>
                <span style={{ fontVariant: 'small-caps' }}>Тел.:</span> {primaryPhone}
              </Text>
            </>
          )}
        </div>

        {/* Column 3: Final amount + discount % + Payment status */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#4F46E5' }}>
            {formatNumber(header.final_amount || header.total_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
          {(header.discount != null && Number(header.discount) > 0) && (() => {
            // Calculate discount percent from absolute discount amount
            const totalAmount = Number(header.total_amount) || 0;
            const discountAmount = Number(header.discount) || 0;
            const discountPercent = totalAmount > 0 ? (discountAmount / totalAmount) * 100 : 0;
            return (
              <Text style={{ fontSize: 13, color: '#DC2626' }}>
                -{formatNumber(discountPercent, 1)}%
              </Text>
            );
          })()}
          <Tag
            color={
              paymentStatusData?.data?.payment_status_name === 'Оплачен' ? '#059669' : '#D97706'
            }
            style={{
              fontSize: '0.64em',
              padding: '2px 8px',
              margin: 0,
              fontWeight: 500,
              letterSpacing: '0.8px',
              ...(isPaymentStatusManual && {
                border: '2px solid #000',
                boxShadow: '0 0 0 1px #000'
              })
            }}
          >
            {paymentStatusData?.data?.payment_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
        </div>
      </div>

      <RowSeparator />

      {/* Row 2: Dates | Notes | Total amount */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        {/* Column 1: Dates */}
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 13, color: '#111827' }}>
            {header.order_date ? dayjs(header.order_date).format('DD.MM.YYYY') : '—'}
            {' → '}
            {header.planned_completion_date ? dayjs(header.planned_completion_date).format('DD.MM.YYYY') : '—'}
          </Text>
        </div>

        {/* Column 2: Notes (with ellipsis) */}
        <div style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 13,
              color: '#6B7280',
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={header.notes || ''}
          >
            {header.notes || '—'}
          </Text>
        </div>

        {/* Column 3: Discount/Surcharge | Paid | Remaining - двухстрочный стиль */}
        <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {(() => {
            const discount = Number(header.discount) || 0;
            const surcharge = Number(header.surcharge) || 0;
            const paidAmount = Number(header.paid_amount) || 0;
            const finalAmount = Number(header.final_amount) || Number(header.total_amount) || 0;
            const remainingAmount = Math.max(0, finalAmount - paidAmount);
            const totalAmount = Number(header.total_amount) || 0;

            const items: React.ReactNode[] = [];

            // Скидка (если > 0)
            if (discount > 0) {
              const discountPercent = totalAmount > 0 ? (discount / totalAmount) * 100 : 0;
              items.push(
                <span key="discount" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', fontWeight: 400, letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Скидка {formatNumber(discountPercent, 1)}%:
                  </Text>
                  <Text style={{ fontSize: 12, fontStyle: 'italic', color: '#cf1322', fontWeight: 600 }}>
                    -{formatNumber(discount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Наценка (если > 0) - показываем как двойную голубую линию-индикатор
            if (surcharge > 0) {
              items.push(
                <span
                  key="surcharge"
                  title={`Наценка: +${formatNumber(surcharge, 2)} ${CURRENCY_SYMBOL}`}
                  style={{
                    display: 'inline-flex',
                    flexDirection: 'column',
                    justifyContent: 'flex-end',
                    alignItems: 'center',
                    width: 40,
                    height: 28,
                    paddingBottom: 2,
                  }}
                >
                  <div style={{ width: '100%', height: 2, background: '#1890ff', marginBottom: 3 }} />
                  <div style={{ width: '100%', height: 2, background: '#1890ff' }} />
                </span>
              );
            }

            // Оплачено (если > 0)
            if (paidAmount > 0) {
              items.push(
                <span key="paid" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Оплачено:
                  </Text>
                  <Text strong style={{ fontSize: 12, fontStyle: 'italic', color: '#52c41a' }}>
                    {formatNumber(paidAmount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Осталось оплатить (если > 0)
            if (remainingAmount > 0) {
              items.push(
                <span key="remaining" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: '#111827', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
                    Остаток оплаты:
                  </Text>
                  <Text strong style={{ fontSize: 12, fontStyle: 'italic', color: '#D97706' }}>
                    {formatNumber(remainingAmount, 2)} {CURRENCY_SYMBOL}
                  </Text>
                </span>
              );
            }

            // Добавляем разделители между элементами
            return items.map((item, index) => (
              <React.Fragment key={index}>
                {index > 0 && <span style={{ color: '#E5E7EB', margin: '0 4px' }}>|</span>}
                {item}
              </React.Fragment>
            ));
          })()}
        </div>
      </div>

      <RowSeparator />

      {/* Row 3: ID + Materials + Production metrics */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
          background: '#FAFBFC',
        }}
      >
        {/* Doweling Order (Присадка) - показываем последнюю */}
        {latestDowelingLink && (
          <>
            <Text style={{ fontSize: 12, color: '#6B7280' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>
                {latestDowelingLink.doweling_order?.doweling_order_name || '—'}
              </Text>
              {latestDowelingLink.doweling_order?.design_engineer_id && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#6B7280' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#111827' }}>
                    {employeesMap.get(latestDowelingLink.doweling_order.design_engineer_id) || '—'}
                  </Text>
                </span>
              )}
              {dowelingLinks.length > 1 && (
                <span style={{ marginLeft: 4, color: '#6B7280' }}>
                  +{dowelingLinks.length - 1}
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />
          </>
        )}
        {/* Fallback для обратной совместимости */}
        {!latestDowelingLink && header.doweling_order_id && (
          <>
            <Text style={{ fontSize: 12, color: '#6B7280' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>{header.doweling_order_name || '—'}</Text>
              {header.design_engineer_id && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#6B7280' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: '#111827' }}>
                    {employeesMap.get(header.design_engineer_id) || '—'}
                  </Text>
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />
          </>
        )}

        {/* Materials */}
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: '#6B7280' }}>Материал: </Text>
          {materialsSummary === '—' ? (
            <Text style={{ fontSize: 12, color: '#6B7280' }}>—</Text>
          ) : (
            materialsData?.data?.map((material, index) => {
              const materialName = material.material_name || '';
              const color = getMaterialColor(materialName);

              return (
                <React.Fragment key={material.material_id}>
                  {index > 0 && <Text style={{ fontSize: 12, color: '#6B7280' }}>, </Text>}
                  <Text strong style={{ fontSize: 12, color }}>
                    {materialName}
                  </Text>
                </React.Fragment>
              );
            })
          )}
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />

        {/* Production metrics */}
        <Space size={16}>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Позиций: <Text strong>{formatNumber(totals.positions_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Деталей: <Text strong>{formatNumber(totals.parts_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: '#111827' }}>
            Площадь: <Text strong>{formatNumber(totals.total_area, 2)} м²</Text>
          </Text>
        </Space>
      </div>

      <RowSeparator />

      {/* Row 4: Production fields (показываются только если все детали имеют одинаковое значение) */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: '#8c8c8c' }}>Фрезеровка: </Text>
          <Text strong style={{ fontSize: 13, color: '#262626' }}>
            {commonProductionValues.millingTypeName}
          </Text>
        </div>

        <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />

        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: '#8c8c8c' }}>Обкат: </Text>
          <Text strong style={{ fontSize: 13, color: '#262626' }}>
            {commonProductionValues.edgeTypeName}
          </Text>
        </div>

        <div style={{ width: 1, height: 12, background: '#E5E7EB' }} />

        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: '#8c8c8c' }}>Плёнка: </Text>
          <Text strong style={{ fontSize: 13, color: '#262626' }}>
            {commonProductionValues.filmName}
          </Text>
        </div>
      </div>
    </div>
  );
};
