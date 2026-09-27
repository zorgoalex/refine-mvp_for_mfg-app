import { Space, Tabs, Typography, theme } from 'antd';
import { Link } from 'react-router-dom';

import { Segmented } from '../../ui/Segmented';
import { formatDate } from '../../utils/dateFormat';
import {
  KindDot,
  KindTitle,
  ResourceLinesTable,
  SourceTag,
  numericStyle,
  useResourceKindColor,
} from './ResourceDemandParts';
import {
  RESOURCE_KINDS,
  formatKindTotal,
  linesOfKind,
  orderDisplayName,
  positionsLabel,
  resourceDemandLines,
  resourceKindTotal,
  type OrderResourceDemandRow,
  type ResourceDemandLine,
  type ResourceKind,
  type ResourceSource,
} from './resourceKinds';

export type ResourceCardMode = 'tabs' | 'summary';
export const RESOURCE_CARD_MODES: readonly ResourceCardMode[] = ['tabs', 'summary'];
const CARD_MODE_OPTIONS = [
  { value: 'tabs', label: 'Вкладки' },
  { value: 'summary', label: 'Сводка' },
];

/**
 * Потребности одного заказа в двух видах: «Вкладки» (по типу ресурса)
 * и «Сводка» (итоги по типам и разделы). Строится из строки списка.
 */
export function ResourceDemandCard({
  row,
  mode,
  onModeChange,
  compact = false,
}: {
  row: OrderResourceDemandRow;
  mode: ResourceCardMode;
  onModeChange?: (mode: ResourceCardMode) => void;
  compact?: boolean;
}) {
  const lines = resourceDemandLines(row);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <Space direction="vertical" size={0}>
          <Typography.Title level={compact ? 5 : 4} style={{ margin: 0 }}>
            Заказ {orderDisplayName(row)}
          </Typography.Title>
          <Typography.Text type="secondary">
            {[row.clientName || 'Клиент не указан', row.orderDate ? formatDate(row.orderDate) : null]
              .filter(Boolean)
              .join(' · ')}
          </Typography.Text>
        </Space>
        <span style={{ flex: 1 }} />
        {onModeChange && (
          <Segmented
            aria-label="Вид карточки"
            value={mode}
            options={CARD_MODE_OPTIONS}
            onChange={(value) => onModeChange(value as ResourceCardMode)}
          />
        )}
        <Link to={`/orders/show/${row.orderId}`}>Открыть заказ</Link>
      </div>
      {lines.length === 0 ? (
        <Typography.Text type="secondary">
          Потребности не рассчитаны: у заказа нет деталей с материалом.
        </Typography.Text>
      ) : mode === 'tabs' ? (
        <ResourceCardTabs lines={lines} />
      ) : (
        <ResourceCardSummary lines={lines} compact={compact} />
      )}
    </Space>
  );
}

function ResourceCardTabs({ lines }: { lines: ResourceDemandLine[] }) {
  const colorOf = useResourceKindColor();
  const items = [
    {
      key: 'all',
      label: <TabLabel title="Все" count={lines.length} />,
      children: <ResourceLinesTable lines={lines} showKind />,
    },
    ...RESOURCE_KINDS.map((meta) => {
      const kindLines = linesOfKind(lines, meta.kind);
      const total = resourceKindTotal(lines, meta.kind);
      return {
        key: meta.kind,
        label: <TabLabel title={meta.label} count={kindLines.length} color={colorOf(meta.kind)} />,
        children: (
          <Space direction="vertical" size={8} style={{ width: '100%' }}>
            <Typography.Text>
              Итого:{' '}
              <Typography.Text strong style={{ ...numericStyle, color: colorOf(meta.kind) }}>
                {formatKindTotal(total, meta.kind)}
              </Typography.Text>
              {total.missingCount > 0 && (
                <Typography.Text type="secondary">
                  {' '}· {total.missingCount} без раскроя, в итог не входят
                </Typography.Text>
              )}
            </Typography.Text>
            <ResourceLinesTable lines={kindLines} showKind={false} />
          </Space>
        ),
      };
    }),
  ];
  return <Tabs items={items} />;
}

function TabLabel({ title, count, color }: { title: string; count: number; color?: string }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {color && <KindDot color={color} />}
      {title}
      <Typography.Text type="secondary" style={{ ...numericStyle, fontSize: 12 }}>{count}</Typography.Text>
    </span>
  );
}

function ResourceCardSummary({ lines, compact }: { lines: ResourceDemandLine[]; compact: boolean }) {
  const colorOf = useResourceKindColor();
  const { token } = theme.useToken();
  const presentKinds = RESOURCE_KINDS.filter((meta) => linesOfKind(lines, meta.kind).length > 0);
  return (
    <Space direction="vertical" size={12} style={{ width: '100%' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${compact ? 2 : RESOURCE_KINDS.length}, minmax(0, 1fr))`,
          gap: 12,
        }}
      >
        {RESOURCE_KINDS.map((meta) => {
          const total = resourceKindTotal(lines, meta.kind);
          return (
            <div
              key={meta.kind}
              style={{
                border: `1px solid ${token.colorBorderSecondary}`,
                borderTop: `3px solid ${colorOf(meta.kind)}`,
                borderRadius: token.borderRadiusLG,
                padding: '10px 12px',
                background: token.colorBgContainer,
              }}
            >
              <KindTitle kind={meta.kind} />
              <div style={{ ...numericStyle, fontSize: 20, fontWeight: 600, marginTop: 4 }}>
                {formatKindTotal(total, meta.kind)}
              </div>
              <Space size={6} wrap>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {total.count === 0 ? 'нет потребности' : positionsLabel(total.count)}
                </Typography.Text>
                {total.count > 0 && <SourceTag source={kindSource(lines, meta.kind)} />}
                {total.missingCount > 0 && (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {total.missingCount} без раскроя
                  </Typography.Text>
                )}
              </Space>
            </div>
          );
        })}
      </div>
      {presentKinds.map((meta) => (
        <div key={meta.kind} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          <Space size={8}>
            <Typography.Text strong><KindTitle kind={meta.kind} /></Typography.Text>
            <Typography.Text strong style={{ ...numericStyle, color: colorOf(meta.kind) }}>
              {formatKindTotal(resourceKindTotal(lines, meta.kind), meta.kind)}
            </Typography.Text>
          </Space>
          <ResourceLinesTable lines={linesOfKind(lines, meta.kind)} showKind={false} compact={compact} />
        </div>
      ))}
    </Space>
  );
}

/** Худший источник среди строк типа: «нет раскроя» важнее «по площади», та — «по раскрою». */
export function kindSource(lines: ResourceDemandLine[], kind: ResourceKind): ResourceSource {
  const sources = new Set(linesOfKind(lines, kind).map((line) => line.source));
  if (sources.has('none')) return 'none';
  if (sources.has('area')) return 'area';
  return 'cut';
}
