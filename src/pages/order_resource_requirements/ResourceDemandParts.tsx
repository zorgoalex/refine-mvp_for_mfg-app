import { Space, Tag, Typography, theme } from 'antd';
import type { CSSProperties } from 'react';

import { Table } from '../../ui/tooltipDelay';
import {
  RESOURCE_KIND_BY_KEY,
  RESOURCE_KINDS,
  SOURCE_LABELS,
  formatKindTotal,
  formatLineQuantity,
  linesOfKind,
  positionsLabel,
  resourceKindTotal,
  type ResourceDemandLine,
  type ResourceKind,
  type ResourceSource,
} from './resourceKinds';

export const numericStyle = { fontVariantNumeric: 'tabular-nums' } as const;

/** Цвет типа ресурса под текущую тему (светлую или тёмную). */
export function useResourceKindColor(): (kind: ResourceKind) => string {
  const { token } = theme.useToken();
  const dark = isDarkColor(token.colorBgContainer);
  return (kind) => RESOURCE_KIND_BY_KEY[kind].color[dark ? 'dark' : 'light'];
}

export function isDarkColor(color: string): boolean {
  const match = /^#?([0-9a-f]{6})$/i.exec(color.trim());
  if (!match) return false;
  const value = Number.parseInt(match[1], 16);
  const r = (value >> 16) & 0xff;
  const g = (value >> 8) & 0xff;
  const b = value & 0xff;
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255 < 0.5;
}

export function KindDot({ color }: { color: string }) {
  return (
    <span
      aria-hidden
      style={{ display: 'inline-block', width: 8, height: 8, borderRadius: '50%', background: color, flex: 'none' }}
    />
  );
}

export function KindTitle({ kind, short = false }: { kind: ResourceKind; short?: boolean }) {
  const colorOf = useResourceKindColor();
  const meta = RESOURCE_KIND_BY_KEY[kind];
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <KindDot color={colorOf(kind)} />
      {short ? meta.shortLabel : meta.label}
    </span>
  );
}

const SOURCE_TAG_COLORS: Record<ResourceSource, string | undefined> = {
  cut: 'success',
  area: 'warning',
  none: undefined,
};

export function SourceTag({ source }: { source: ResourceSource }) {
  return (
    <Tag color={SOURCE_TAG_COLORS[source]} style={{ marginInlineEnd: 0 }}>
      {SOURCE_LABELS[source]}
    </Tag>
  );
}

/** Ячейка вида «Сводка»: итог по типу, число позиций, главный материал и «+N». */
export function KindSummaryCell({ lines, kind }: { lines: ResourceDemandLine[]; kind: ResourceKind }) {
  const colorOf = useResourceKindColor();
  const kindLines = linesOfKind(lines, kind);
  if (kindLines.length === 0) return <Typography.Text type="secondary">—</Typography.Text>;
  const total = resourceKindTotal(lines, kind);
  const [first, ...rest] = kindLines;
  const restNames = rest.map((line) => line.name).join(', ');
  const ellipsis: CSSProperties = { display: 'block', maxWidth: 240, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
  return (
    <Space direction="vertical" size={0} style={{ minWidth: 0 }}>
      <Space size={6} align="baseline">
        <Typography.Text strong style={{ ...numericStyle, color: colorOf(kind), fontSize: 15 }}>
          {formatKindTotal(total, kind)}
        </Typography.Text>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {positionsLabel(total.count)}
        </Typography.Text>
      </Space>
      <Typography.Text style={ellipsis} title={first.name}>{first.name}</Typography.Text>
      {rest.length > 0 && (
        <Typography.Text type="secondary" style={{ ...ellipsis, fontSize: 12 }} title={restNames}>
          +{rest.length}: {restNames}
        </Typography.Text>
      )}
      {total.missingCount > 0 && (
        <Tag style={{ marginTop: 2, marginInlineEnd: 0, width: 'fit-content' }}>
          {total.missingCount} без раскроя
        </Tag>
      )}
    </Space>
  );
}

/** Полный состав потребности заказа по всем типам — раскрытая строка вида «Сводка». */
export function ResourceDemandBreakdown({
  lines,
  kinds = RESOURCE_KINDS.map((meta) => meta.kind),
}: {
  lines: ResourceDemandLine[];
  kinds?: ResourceKind[];
}) {
  const colorOf = useResourceKindColor();
  const { token } = theme.useToken();
  return (
    <div style={{ display: 'grid', gridTemplateColumns: `repeat(${kinds.length}, minmax(0, 1fr))`, gap: 12 }}>
      {kinds.map((kind) => {
        const kindLines = linesOfKind(lines, kind);
        const total = resourceKindTotal(lines, kind);
        return (
          <div
            key={kind}
            style={{
              border: `1px solid ${token.colorBorderSecondary}`,
              borderTop: `3px solid ${colorOf(kind)}`,
              borderRadius: token.borderRadiusLG,
              background: token.colorBgContainer,
              overflow: 'hidden',
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 12px', borderBottom: `1px solid ${token.colorBorderSecondary}` }}>
              <KindTitle kind={kind} />
              <Typography.Text strong style={{ ...numericStyle, marginLeft: 'auto', color: colorOf(kind) }}>
                {formatKindTotal(total, kind)}
              </Typography.Text>
            </div>
            {kindLines.length === 0 ? (
              <Typography.Text type="secondary" style={{ display: 'block', padding: '8px 12px' }}>
                Нет потребности
              </Typography.Text>
            ) : (
              kindLines.map((line) => <ResourceLineRow key={line.resourceKey} line={line} />)
            )}
          </div>
        );
      })}
    </div>
  );
}

function ResourceLineRow({ line }: { line: ResourceDemandLine }) {
  const { token } = theme.useToken();
  const secondary = [line.supplierLabel, line.secondaryText].filter(Boolean).join(' · ');
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr) auto',
        columnGap: 12,
        padding: '6px 12px',
        borderTop: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <div style={{ minWidth: 0 }}>
        <Typography.Text>{line.name}</Typography.Text>
        {secondary && (
          <div>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{secondary}</Typography.Text>
          </div>
        )}
      </div>
      <div style={{ textAlign: 'right' }}>
        <Typography.Text strong style={numericStyle}>{formatLineQuantity(line)}</Typography.Text>
        <div>
          <Typography.Text type="secondary" style={{ ...numericStyle, fontSize: 12 }}>
            Деталей: {line.detailsCount}
          </Typography.Text>
        </div>
      </div>
    </div>
  );
}

/** Таблица строк потребности; используется в карточке и в панели. */
export function ResourceLinesTable({
  lines,
  showKind,
  compact = false,
}: {
  lines: ResourceDemandLine[];
  showKind: boolean;
  compact?: boolean;
}) {
  return (
    <Table<ResourceDemandLine>
      rowKey="resourceKey"
      size="small"
      dataSource={lines}
      pagination={false}
      locale={{ emptyText: 'Нет потребности' }}
    >
      {showKind && (
        <Table.Column<ResourceDemandLine>
          key="kind"
          title="Тип"
          width={150}
          render={(_, line) => <KindTitle kind={line.kind} short />}
        />
      )}
      <Table.Column<ResourceDemandLine>
        key="name"
        title="Материал"
        render={(_, line) => (
          <>
            <Typography.Text>{line.name}</Typography.Text>
            {compact && line.supplierLabel && (
              <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{line.supplierLabel}</Typography.Text></div>
            )}
          </>
        )}
      />
      {!compact && (
        <Table.Column<ResourceDemandLine>
          key="supplier"
          title="Поставщик / производитель"
          render={(_, line) => <Typography.Text type="secondary">{line.supplierLabel?.replace(/^[^:]+:\s*/, '') ?? '—'}</Typography.Text>}
        />
      )}
      <Table.Column<ResourceDemandLine>
        key="quantity"
        title="Количество"
        align="right"
        render={(_, line) => (
          <>
            <Typography.Text strong style={{ ...numericStyle, whiteSpace: 'nowrap' }}>{formatLineQuantity(line)}</Typography.Text>
            {line.secondaryText && (
              <div><Typography.Text type="secondary" style={{ ...numericStyle, fontSize: 12 }}>{line.secondaryText}</Typography.Text></div>
            )}
          </>
        )}
      />
      <Table.Column<ResourceDemandLine>
        key="details"
        title="Деталей"
        align="right"
        width={80}
        render={(_, line) => <span style={numericStyle}>{line.detailsCount}</span>}
      />
      <Table.Column<ResourceDemandLine>
        key="source"
        title="Источник"
        width={120}
        render={(_, line) => <SourceTag source={line.source} />}
      />
    </Table>
  );
}
