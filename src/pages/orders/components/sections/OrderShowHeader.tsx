// Order Show Header (Read-only summary for show page)
// Adapted from OrderHeaderSummary for use with props instead of store

import React, { useMemo, useState } from 'react';
import { Tag, Space, Typography, Dropdown } from 'antd';
import type { MenuProps } from 'antd';
import { StarOutlined, EyeOutlined } from '@ant-design/icons';
import { useList } from '@refinedev/core';
import { useNavigate } from 'react-router-dom';
import { formatNumber } from '../../../../utils/numberFormat';
import { CURRENCY_SYMBOL } from '../../../../config/currency';
import { getMaterialColor } from '../../../../config/displayColors';
import { resolveHeaderMaterialName } from '../../../../utils/materialDisplayName';
import { ProductionStagesDisplay } from '../../../../components/ProductionStagesDisplay';
import { useAppSettings, SETTING_KEYS } from '../../../../hooks/useAppSettings';
import { buildProductionStagesDisplayConfig } from '../../../../utils/productionWorkflow';
import type { ProductionStatusRef, ProductionWorkflowConfig } from '../../../../types/productionWorkflow';
import { RowSeparator } from './RowSeparator';
import { collectOrderBasisProjects } from './orderBasisProjects';
import dayjs from 'dayjs';
import { calculateOrderTotalArea } from '../../../../utils/orderArea';
import { resolveCurrentProductionStatusCodes } from '../../currentProductionStatus';
import { useOperationalUi } from '../../../../ui-operational/OperationalPrimitives';
import { can } from '../../../../utils/permissions';
import { featureFlags } from '../../../../config/featureFlags';

const { Text } = Typography;

interface OrderShowHeaderProps {
  record: any; // order record from orders_view
  details: any[]; // order details array
  dowelingLinks?: any[]; // doweling links with nested doweling_order
  compactSticky?: boolean;
  // SP3: server-resolved COALESCE(sheet, material) display names from the parent
  // (order_details_view per detail / orders_view header). Preferred over the
  // internal materials fetch so sheet orders never show the (hidden) shadow name.
  detailMaterialNames?: string[];
  headerMaterialName?: string | null;
  showFinancials?: boolean;
}

export const OrderShowHeader: React.FC<OrderShowHeaderProps> = ({
  record,
  details,
  dowelingLinks = [],
  compactSticky = false,
  detailMaterialNames,
  headerMaterialName,
  showFinancials = true,
}) => {
  const navigate = useNavigate();
  const isOperational = useOperationalUi();
  const { getSetting } = useAppSettings();
  const canViewEmployees = !featureFlags.useBackendPermissions || can('employees.view');
  const canViewReferences = !featureFlags.useBackendPermissions || can('references.view');
  const canViewProductionReferences = !featureFlags.useBackendPermissions || can('production.view');
  const canViewClients = !featureFlags.useBackendPermissions || can('clients.view');

  // State for client context menu
  const [clientMenuOpen, setClientMenuOpen] = useState(false);

  // Get the latest (last added) doweling link for header display
  const latestDowelingLink = useMemo(() => {
    if (!dowelingLinks || dowelingLinks.length === 0) return null;
    return dowelingLinks[dowelingLinks.length - 1];
  }, [dowelingLinks]);

  // Client context menu items
  const clientMenuItems: MenuProps['items'] = useMemo(() => {
    if (!record?.client_id || !canViewClients) return [];
    return [
      {
        key: 'view-client',
        icon: <EyeOutlined />,
        label: 'Просмотр клиента',
        onClick: () => {
          setClientMenuOpen(false);
          navigate(`/clients/show/${record.client_id}`);
        },
      },
    ];
  }, [canViewClients, record?.client_id, navigate]);

  // Load employees for design_engineer lookup
  const { data: employeesData } = useList({
    resource: 'employees',
    pagination: { pageSize: 1000 },
    queryOptions: { enabled: canViewEmployees },
  });

  const employeesMap = useMemo(() => new Map(
    (employeesData?.data || []).map((e: any) => [e.employee_id, e.full_name])
  ), [employeesData]);

  // Calculate totals from details
  const totals = useMemo(() => {
    const positions_count = details.length;
    const parts_count = details.reduce((sum, d) => sum + (d.quantity || 0), 0);
    const total_area = calculateOrderTotalArea(details);

    return {
      positions_count,
      parts_count,
      total_area,
    };
  }, [details]);

  // Get unique material IDs from details
  const uniqueMaterialIds = useMemo(() => {
    const ids = details
      .map(d => d.material_id)
      .filter((id): id is number => id !== null && id !== undefined);
    return [...new Set(ids)];
  }, [details]);

  // Load materials list
  const { data: materialsData } = useList({
    resource: 'materials',
    filters: uniqueMaterialIds.length > 0 ? [
      { field: 'material_id', operator: 'in', value: uniqueMaterialIds }
    ] : [],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: uniqueMaterialIds.length > 0 && canViewReferences,
    },
  });

  // Load client phones
  const { data: clientPhonesData } = useList({
    resource: 'client_phones',
    filters: [
      { field: 'client_id', operator: 'eq', value: record?.client_id },
    ],
    pagination: { pageSize: 100 },
    queryOptions: {
      enabled: !!record?.client_id && canViewClients,
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

  // SP3: prefer the server-resolved COALESCE names from the parent; fall back to
  // the order header's own material (header-only orders), then to the internal
  // materials fetch (legacy safety). Never resolves the hidden shadow name.
  const resolvedMaterialNames = useMemo(() => {
    const fromParent = (detailMaterialNames || [])
      .map(n => (n == null ? '' : String(n).trim()))
      .filter(Boolean);
    if (fromParent.length > 0) return Array.from(new Set(fromParent));
    const headerName = resolveHeaderMaterialName({
      material_name_resolved: headerMaterialName ?? undefined,
      material_name: record?.material_name,
    });
    if (headerName) return [headerName];
    return (materialsData?.data || [])
      .map((m: any) => m.material_name)
      .filter(Boolean);
  }, [detailMaterialNames, headerMaterialName, record?.material_name, materialsData]);

  // Create materials summary string
  const materialsSummary = resolvedMaterialNames.length > 0
    ? resolvedMaterialNames.join(', ')
    : '—';
  const basisProjects = useMemo(() => collectOrderBasisProjects(details || []), [details]);

  // Load all production statuses for mapping
  const { data: allProductionStatusesData } = useList({
    resource: 'production_statuses',
    pagination: { pageSize: 100 },
    // IMPORTANT: explicit is_active filter disables dataProvider auto-filter, so we can map inactive statuses too
    filters: [{ field: 'is_active', operator: 'in', value: [true, false] }],
    sorters: [{ field: 'sort_order', order: 'asc' }, { field: 'production_status_id', order: 'asc' }],
    queryOptions: { enabled: canViewProductionReferences },
  });

  // Create map for production status ID to code
  const productionStatusIdToCode = useMemo(() => {
    const map = new Map<number, string>();
    (allProductionStatusesData?.data || []).forEach((status: any) => {
      map.set(status.production_status_id, status.production_status_code);
    });
    return map;
  }, [allProductionStatusesData]);

  const statusesForWorkflow: ProductionStatusRef[] = useMemo(() => {
    return (allProductionStatusesData?.data || []).map((s: any) => ({
      production_status_id: s.production_status_id,
      production_status_code: s.production_status_code,
      production_status_name: s.production_status_name,
      sort_order: s.sort_order,
      color: s.color,
      is_active: !!s.is_active,
    }));
  }, [allProductionStatusesData]);

  const workflow = getSetting<ProductionWorkflowConfig>(SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT);

  const productionWorkflowDisplay = useMemo(() => {
    if (!statusesForWorkflow || statusesForWorkflow.length === 0) return undefined;
    return buildProductionStagesDisplayConfig({
      workflow,
      statuses: statusesForWorkflow,
      workflowKey: SETTING_KEYS.PRODUCTION_WORKFLOW_DEFAULT,
    }).display;
  }, [workflow, statusesForWorkflow]);

  const currentProductionStatusCodes = useMemo(
    () => resolveCurrentProductionStatusCodes({
      statusId: record?.production_status_id,
      statusName: record?.production_status_name,
      statusIdToCode: productionStatusIdToCode,
    }),
    [productionStatusIdToCode, record?.production_status_id, record?.production_status_name],
  );

  const compactDowelingName =
    latestDowelingLink?.doweling_order?.doweling_order_name ||
    record?.doweling_order_name ||
    null;
  const totalAmount = Number(record?.total_amount) || 0;
  const finalAmount = Number(record?.final_amount) || totalAmount || 0;
  const paidAmount = Number(record?.paid_amount) || 0;
  const discount = Number(record?.discount) || 0;
  const surcharge = Number(record?.surcharge) || 0;
  const remainingAmount = Math.max(0, finalAmount - paidAmount);
  const compactFinanceItems = [
    `${formatNumber(finalAmount, 2)} ${CURRENCY_SYMBOL}`,
    discount > 0 ? `скид. ${formatNumber(discount, 2)} ${CURRENCY_SYMBOL}` : null,
    surcharge > 0 ? `нац. ${formatNumber(surcharge, 2)} ${CURRENCY_SYMBOL}` : null,
    paidAmount > 0 ? `опл. ${formatNumber(paidAmount, 2)} ${CURRENCY_SYMBOL}` : null,
    remainingAmount > 0 ? `ост. ${formatNumber(remainingAmount, 2)} ${CURRENCY_SYMBOL}` : null,
  ].filter(Boolean);
  const compactBasisProjectsSummary = basisProjects.join(', ');
  const compactMaterialSummary = [
    materialsSummary,
    basisProjects.length > 0 ? `Базис: ${compactBasisProjectsSummary}` : null,
  ].filter(Boolean).join(' · ');

  if (isOperational) {
    const paymentPercent = finalAmount > 0 ? Math.min(100, Math.round((paidAmount / finalAmount) * 100)) : 0;
    const deadlineAt = record?.planned_completion_date ? dayjs(record.planned_completion_date) : null;
    const isAtRisk = deadlineAt?.isBefore(dayjs(), 'day') && record?.order_status_name !== 'Готов к выдаче';
    const daysToDeadline = deadlineAt ? deadlineAt.startOf('day').diff(dayjs().startOf('day'), 'day') : null;

    return (
      <div
        className={`order-show-operational-summary${compactSticky ? ' order-show-operational-summary--compact' : ''}`}
        aria-label="Сводка заказа"
      >
        <div className="order-show-operational-summary__primary">
          <strong>{record?.order_name || 'Заказ'}</strong>
          <Tag color={isAtRisk ? 'orange' : 'green'}>{isAtRisk ? 'Под риском' : 'В работе'}</Tag>
          {showFinancials && <Tag>{`${paymentPercent}%`}</Tag>}
        </div>
        <div className="order-show-operational-summary__metric">
          <strong>{record?.client_name || '—'}</strong>
          <small>{primaryPhone ? `Тел.: ${primaryPhone}` : 'Телефон не указан'}</small>
        </div>
        <div className="order-show-operational-summary__metric">
          <strong>
            {record?.order_date ? dayjs(record.order_date).format('DD.MM') : '—'}
            {' — '}
            {record?.planned_completion_date ? dayjs(record.planned_completion_date).format('DD.MM.YYYY') : '—'}
          </strong>
          <small>
            {daysToDeadline == null
              ? 'Срок не указан'
              : daysToDeadline >= 0
                ? `Срок выдачи через ${daysToDeadline} дн.`
                : `Просрочено на ${Math.abs(daysToDeadline)} дн.`}
          </small>
        </div>
        <div className="order-show-operational-summary__metric">
          <strong>{materialsSummary}</strong>
          <small>{`${totals.parts_count} деталей · ${formatNumber(totals.total_area, 2)} м²`}</small>
        </div>
        {showFinancials && (
          <div className="order-show-operational-summary__money">
            <strong>{formatNumber(finalAmount, 0)} {CURRENCY_SYMBOL}</strong>
            <small>{`Оплачено ${formatNumber(paidAmount, 0)} ${CURRENCY_SYMBOL}`}</small>
          </div>
        )}
      </div>
    );
  }

  if (compactSticky) {
    return (
      <div className="order-show-header order-show-header--compact-sticky" aria-label="Сводка заказа">
        <div className="order-show-header__compact-line">
          <span className="order-show-header__compact-primary">
            <Text strong className="order-show-header__compact-text">{record?.order_name || 'Заказ'}</Text>
            <span
              className="order-show-header__compact-priority"
              title={`Приоритет ${record?.priority !== undefined ? formatNumber(record.priority, 0) : '—'}`}
              aria-label={`Приоритет ${record?.priority !== undefined ? formatNumber(record.priority, 0) : '—'}`}
            >
              <StarOutlined aria-hidden style={{ color: record?.priority && record.priority <= 50 ? '#D97706' : 'var(--app-text-muted)' }} />
              {record?.priority !== undefined ? formatNumber(record.priority, 0) : '—'}
            </span>
            <Tag color={record?.order_status_name === 'Готов к выдаче' ? '#059669' : record?.order_status_name === 'Предварительный' ? '#91caff' : '#4F46E5'}>
              {record?.order_status_name || 'Не назначен'}
            </Tag>
          </span>
          <span className="order-show-header__compact-item order-show-header__compact-client" title={record?.client_name || ''}>
            <Text strong className="order-show-header__compact-text">{record?.client_name || '—'}</Text>
            {primaryPhone ? <a href={`tel:${primaryPhone.replace(/[^+\d]/g, '')}`}>{primaryPhone}</a> : null}
          </span>
          {showFinancials && (
            <span className="order-show-header__compact-item order-show-header__compact-money">
              <span className="order-show-header__compact-text">{compactFinanceItems.join(' / ')}</span>
              <Tag color={record?.payment_status_name === 'Оплачен' ? '#059669' : '#D97706'}>
                {record?.payment_status_name || 'Не назначен'}
              </Tag>
            </span>
          )}
          <span className="order-show-header__compact-item order-show-header__compact-dates">
            {record?.order_date ? dayjs(record.order_date).format('DD.MM.YYYY') : '—'}
            {' → '}
            {record?.planned_completion_date ? dayjs(record.planned_completion_date).format('DD.MM.YYYY') : '—'}
            {currentProductionStatusCodes.length > 0 ? (
              <ProductionStagesDisplay
                passedCodes={currentProductionStatusCodes}
                displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
                codeToLetter={productionWorkflowDisplay?.codeToLetter}
                codeToName={productionWorkflowDisplay?.codeToName}
                fontSize={11}
                passedColor="#52c41a"
                showTooltip
              />
            ) : null}
          </span>
          {compactDowelingName ? (
            <span className="order-show-header__compact-item order-show-header__compact-doweling" title={compactDowelingName}>
              Присадка: <Text strong className="order-show-header__compact-text">{compactDowelingName}</Text>
            </span>
          ) : null}
          <span className="order-show-header__compact-item order-show-header__compact-material" title={compactMaterialSummary}>
            <Text strong className="order-show-header__compact-text">{compactMaterialSummary}</Text>
          </span>
          <span className="order-show-header__compact-item order-show-header__compact-metrics">
            поз. <Text strong>{formatNumber(totals.positions_count, 0)}</Text>
            {' · '}
            дет. <Text strong>{formatNumber(totals.parts_count, 0)}</Text>
            {' · '}
            <Text strong>{formatNumber(totals.total_area, 2)} м²</Text>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div
      className="order-show-header"
      style={{
        marginBottom: 24,
        border: '1px solid #1890ff',
        borderRadius: 6,
        background: 'var(--app-surface)',
        overflow: 'hidden',
      }}
    >
      {/* Row 1: Order name, priority, status | Client | Discounted amount, discount %, payment status */}
      <div
        className="order-show-header__row"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
          whiteSpace: 'nowrap',
        }}
      >
        {/* Column 1: Order name + Priority + Order status */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: 'var(--app-text)' }}>
            {record?.order_name || 'Заказ'}
          </Text>
          <Space size={8}>
            <span style={{ display: 'inline-flex', alignItems: 'center' }}>
              <StarOutlined
                style={{
                  fontSize: 14,
                  marginRight: 4,
                  color: record?.priority && record.priority <= 50 ? '#D97706' : 'var(--app-text-muted)'
                }}
              />
              <Text style={{ fontSize: 13, color: 'var(--app-text)' }}>
                {record?.priority !== undefined ? formatNumber(record.priority, 0) : '—'}
              </Text>
            </span>
            <Tag
              color={
                record?.order_status_name === 'Готов к выдаче'
                  ? '#059669'
                  : record?.order_status_name === 'Предварительный'
                  ? '#91caff'
                  : '#4F46E5'
              }
              style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
            >
              {record?.order_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
            </Tag>
          </Space>
        </div>

        {/* Column 2: Client + Phone */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center' }}>
          {record?.client_id ? (
            <Dropdown
              menu={{ items: clientMenuItems }}
              trigger={['contextMenu']}
              open={clientMenuOpen}
              onOpenChange={setClientMenuOpen}
            >
              <Text
                strong
                style={{
                  fontSize: 16,
                  color: 'var(--app-text)',
                  cursor: 'context-menu',
                }}
              >
                {record?.client_name || '—'}
              </Text>
            </Dropdown>
          ) : (
            <Text strong style={{ fontSize: 16, color: 'var(--app-text)' }}>
              {record?.client_name || '—'}
            </Text>
          )}
          {primaryPhone && (
            <>
              <span style={{ margin: '0 16px', color: 'var(--app-border)' }}>|</span>
              <Text style={{ fontSize: 12.8, fontStyle: 'italic', color: 'var(--app-text)' }}>
                <span style={{ fontVariant: 'small-caps' }}>Тел.:</span>{' '}
                <a href={`tel:${primaryPhone.replace(/[^+\d]/g, '')}`}>{primaryPhone}</a>
              </Text>
            </>
          )}
        </div>

        {/* Column 3: Final amount + Payment status */}
        {showFinancials && <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 12 }}>
          <Text strong style={{ fontSize: 15, color: '#4F46E5' }}>
            {formatNumber(record?.final_amount || record?.total_amount || 0, 2)} {CURRENCY_SYMBOL}
          </Text>
          <Tag
            color={
              record?.payment_status_name === 'Оплачен' ? '#059669'
              : record?.payment_status_name === 'Частично оплачен' ? '#D97706'
              : '#D97706'
            }
            style={{ fontSize: '0.64em', padding: '2px 8px', margin: 0, fontWeight: 500, letterSpacing: '0.8px' }}
          >
            {record?.payment_status_name?.toUpperCase() || 'НЕ НАЗНАЧЕН'}
          </Tag>
        </div>}
      </div>

      <RowSeparator />

      {/* Row 2: Dates | Production Stages | Notes | Total amount */}
      <div
        className="order-show-header__row"
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
        }}
      >
        {/* Column 1: Dates + Production Stages */}
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', gap: 12 }}>
          <Text style={{ fontSize: 13, color: 'var(--app-text)' }}>
            {record?.order_date ? dayjs(record.order_date).format('DD.MM.YYYY') : '—'}
            {' → '}
            {record?.planned_completion_date ? dayjs(record.planned_completion_date).format('DD.MM.YYYY') : '—'}
          </Text>
          {/* Production stages display */}
          {currentProductionStatusCodes.length > 0 && (
            <>
              <span style={{ color: 'var(--app-border)' }}>|</span>
              <ProductionStagesDisplay
                passedCodes={currentProductionStatusCodes}
                displayOrderCodes={productionWorkflowDisplay?.displayOrderCodes}
                codeToLetter={productionWorkflowDisplay?.codeToLetter}
                codeToName={productionWorkflowDisplay?.codeToName}
                fontSize={13}
                passedColor="#52c41a"
                showTooltip={true}
              />
            </>
          )}
        </div>

        {/* Column 2: Notes (with ellipsis) */}
        <div style={{ flex: 1 }}>
          <Text
            style={{
              fontSize: 13,
              color: 'var(--app-text-muted)',
              display: 'block',
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
            }}
            title={record?.notes || ''}
          >
            {record?.notes || '—'}
          </Text>
        </div>

        {/* Column 3: Discount/Surcharge | Paid | Remaining - двухстрочный стиль */}
        {showFinancials && <div style={{ flex: 1, display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: 8 }}>
          {(() => {
            const discount = Number(record?.discount) || 0;
            const surcharge = Number(record?.surcharge) || 0;
            const paidAmount = Number(record?.paid_amount) || 0;
            const totalAmount = Number(record?.total_amount) || 0;
            const finalAmount = Number(record?.final_amount) || totalAmount || 0;
            const remainingAmount = Math.max(0, finalAmount - paidAmount);

            const items: React.ReactNode[] = [];

            // Скидка (если > 0)
            if (discount > 0) {
              const discountPercent = totalAmount > 0 ? (discount / totalAmount) * 100 : 0;
              items.push(
                <span key="discount" style={{ display: 'inline-flex', flexDirection: 'column', alignItems: 'flex-end', lineHeight: 1.1 }}>
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: 'var(--app-text)', fontWeight: 400, letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
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
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: 'var(--app-text)', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
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
                  <Text style={{ fontSize: 9.9, fontStyle: 'italic', color: 'var(--app-text)', letterSpacing: '0.5px', fontVariant: 'small-caps' }}>
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
                {index > 0 && <span style={{ color: 'var(--app-border)', margin: '0 4px' }}>|</span>}
                {item}
              </React.Fragment>
            ));
          })()}
        </div>}
      </div>

      <RowSeparator />

      {/* Row 3: ID + Materials + Production metrics */}
      <div
        className="order-show-header__row"
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '6px 16px',
          gap: 16,
          background: 'var(--app-surface-muted)',
        }}
      >
        {/* Doweling Order (Присадка) - показываем последнюю из many-to-many */}
        {latestDowelingLink && (
          <>
            <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>
                {latestDowelingLink.doweling_order?.doweling_order_name || '—'}
              </Text>
              {latestDowelingLink.doweling_order?.design_engineer_id && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: 'var(--app-text-muted)' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: 'var(--app-text)' }}>
                    {employeesMap.get(latestDowelingLink.doweling_order.design_engineer_id) || '—'}
                  </Text>
                </span>
              )}
              {dowelingLinks.length > 1 && (
                <span style={{ marginLeft: 4, color: 'var(--app-text-muted)' }}>
                  +{dowelingLinks.length - 1}
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: 'var(--app-border)' }} />
          </>
        )}
        {/* Fallback для обратной совместимости (из orders_view) */}
        {!latestDowelingLink && record?.doweling_order_name && (
          <>
            <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>
              Присадка: <Text strong style={{ color: '#DC2626' }}>{record.doweling_order_name}</Text>
              {record?.design_engineer && (
                <span style={{ marginLeft: 8, fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: 'var(--app-text-muted)' }}>
                  Конструктор: <Text style={{ fontSize: 11.8, fontStyle: 'italic', letterSpacing: '0.3px', color: 'var(--app-text)' }}>{record.design_engineer}</Text>
                </span>
              )}
            </Text>
            <div style={{ width: 1, height: 12, background: 'var(--app-border)' }} />
          </>
        )}

        {/* Materials */}
        <div style={{ flex: 1 }}>
          <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>Материал: </Text>
          {resolvedMaterialNames.length === 0 ? (
            <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>—</Text>
          ) : (
            resolvedMaterialNames.map((materialName, index) => {
              const color = getMaterialColor(materialName);

              return (
                <React.Fragment key={`${materialName}-${index}`}>
                  {index > 0 && <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>, </Text>}
                  <Text strong style={{ fontSize: 12, color }}>
                    {materialName}
                  </Text>
                </React.Fragment>
              );
            })
          )}
          {basisProjects.length > 0 && (
            <span style={{ marginLeft: 12 }}>
              <Text style={{ fontSize: 12, color: 'var(--app-text-muted)' }}>Базис-проект: </Text>
              <Text strong style={{ fontSize: 12, color: 'var(--app-text)' }}>
                {basisProjects.join(', ')}
              </Text>
            </span>
          )}
        </div>

        {/* Separator */}
        <div style={{ width: 1, height: 12, background: 'var(--app-border)' }} />

        {/* Production metrics */}
        <Space size={16}>
          <Text style={{ fontSize: 12, color: 'var(--app-text)' }}>
            Позиций: <Text strong>{formatNumber(totals.positions_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: 'var(--app-text)' }}>
            Деталей: <Text strong>{formatNumber(totals.parts_count, 0)}</Text>
          </Text>
          <Text style={{ fontSize: 12, color: 'var(--app-text)' }}>
            Площадь: <Text strong>{formatNumber(totals.total_area, 2)} м²</Text>
          </Text>
        </Space>
      </div>
    </div>
  );
};
