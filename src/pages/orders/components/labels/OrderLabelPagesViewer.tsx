import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Input, Select, Space, Typography, message } from 'antd';
import { LeftOutlined, PrinterOutlined, RightOutlined, SearchOutlined } from '@ant-design/icons';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';
import { printLabelSvgPages } from './labelPrint';
import { useOperationalUi } from '../../../../ui-operational/OperationalPrimitives';
import type { LabelPreviewRow } from '../../../../api/types/labelsApi.types';

const { Text } = Typography;

interface OrderLabelPagesViewerProps {
  svgPages: string[];
  rows?: LabelPreviewRow[];
  title: string;
  description?: React.ReactNode;
  printTitle?: string;
  printEnabled?: boolean;
  selectedIndex?: number | null;
  onSelectedIndexChange?: (index: number) => void;
  appendBlankLabelOnPrint?: boolean;
}

export function clampLabelPageIndex(index: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return Math.min(Math.max(index, 0), pageCount - 1);
}

export function labelPageTitle(index: number, pageCount: number): string {
  return `Бирка ${index + 1} из ${pageCount}`;
}

export const OrderLabelPagesViewer: React.FC<OrderLabelPagesViewerProps> = ({
  svgPages,
  rows,
  title,
  description,
  printTitle,
  printEnabled = true,
  selectedIndex: controlledSelectedIndex,
  onSelectedIndexChange,
  appendBlankLabelOnPrint = false,
}) => {
  const isOperational = useOperationalUi();
  const [uncontrolledSelectedIndex, setUncontrolledSelectedIndex] = useState(0);
  const [searchQuery, setSearchQuery] = useState('');
  const [printScope, setPrintScope] = useState<'current' | 'all'>('all');
  const pageCount = svgPages.length;
  const selectedIndex = clampLabelPageIndex(controlledSelectedIndex ?? uncontrolledSelectedIndex, pageCount);
  const selectedSvg = svgPages[selectedIndex] ?? null;
  const selectedRow = rows?.[selectedIndex] ?? null;
  const selectedValues = selectedRow?.values ?? {};
  const pickValue = (...tokens: string[]) => {
    const entries = Object.entries(selectedValues)
      .filter(([, value]) => value !== null && value !== '')
      .map(([key, value]) => ({ key: key.toLocaleLowerCase('ru-RU'), value }));
    for (const token of tokens) {
      const normalizedToken = token.toLocaleLowerCase('ru-RU');
      const exact = entries.find(({ key }) => key === normalizedToken || key.endsWith(`.${normalizedToken}`));
      if (exact) return exact.value;
    }
    for (const token of tokens) {
      const normalizedToken = token.toLocaleLowerCase('ru-RU');
      const partial = entries.find(({ key }) => key.includes(normalizedToken));
      if (partial) return partial.value;
    }
    return null;
  };
  const position = pickValue('position', 'detail_number', 'detail.number') ?? selectedIndex + 1;
  const detailName = pickValue('detail_name', 'detail.name', 'bazis.name', 'name');
  const material = pickValue('material_name', 'material.name', 'material');
  const film = pickValue('film_name', 'film.name', 'film', 'плён');
  const quantity = pickValue('quantity', 'count') ?? selectedRow?.copyCount ?? null;
  const designation = pickValue('designation', 'article');
  const explicitSize = pickValue('dimension', 'size');
  const width = pickValue('width');
  const height = pickValue('height', 'length');
  const detailSize = explicitSize ?? (width && height ? `${width} × ${height}` : width ?? height);
  const pageButtons = useMemo(() => {
    const query = searchQuery.trim().toLocaleLowerCase('ru-RU');
    return svgPages
      .map((_, index) => index)
      .filter((index) => !query || `бирка ${index + 1} позиция ${index + 1}`.includes(query));
  }, [searchQuery, svgPages]);

  useEffect(() => {
    setUncontrolledSelectedIndex((current) => clampLabelPageIndex(current, pageCount));
  }, [controlledSelectedIndex, pageCount]);

  const selectIndex = (index: number) => {
    const next = clampLabelPageIndex(index, pageCount);
    setUncontrolledSelectedIndex(next);
    onSelectedIndexChange?.(next);
  };

  const move = (delta: number) => {
    selectIndex(selectedIndex + delta);
  };

  const runPrint = () => {
    const pages = printScope === 'current' && selectedSvg ? [selectedSvg] : svgPages;
    const opened = printLabelSvgPages(pages, printTitle ?? title, { appendBlankPage: appendBlankLabelOnPrint });
    if (!opened) {
      message.error('Не удалось открыть окно печати');
    }
  };

  if (pageCount === 0 || !selectedSvg) {
    return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Нет бирок для просмотра" />;
  }

  return (
    <div className="order-label-pages-viewer-wrap">
      <style>{`
        .order-label-pages-viewer-wrap {
          width: 100%;
        }

        .order-label-pages-viewer__top {
          align-items: flex-start;
          display: flex;
          gap: 12px;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .order-label-pages-viewer {
          display: grid;
          gap: 12px;
          grid-template-columns: minmax(132px, 180px) minmax(0, 1fr);
          width: 100%;
        }

        [data-ui-variant="line"] .order-label-pages-viewer--operational,
        [data-ui-variant="air"] .order-label-pages-viewer--operational {
          grid-template-columns: minmax(190px, 220px) minmax(360px, 1fr) minmax(230px, 280px);
          min-height: 540px;
        }

        .order-label-pages-viewer__list-panel {
          background: var(--app-surface, #fff);
          border-radius: 12px;
          box-shadow: inset 0 0 0 1px var(--app-border);
          padding: 10px;
        }

        .order-label-pages-viewer__list-title {
          align-items: baseline;
          display: flex;
          gap: 8px;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        .order-label-pages-viewer__list-count {
          font-variant-numeric: tabular-nums;
          white-space: nowrap;
        }

        .order-label-pages-viewer__list {
          display: flex;
          flex-direction: column;
          gap: 6px;
          max-height: 420px;
          overflow: auto;
          padding-right: 2px;
        }

        .order-label-pages-viewer__list-button {
          align-items: center;
          background: var(--app-surface, #fff);
          border: 0;
          border-radius: 8px;
          box-shadow: inset 0 0 0 1px var(--app-border);
          color: inherit;
          cursor: pointer;
          display: flex;
          font: inherit;
          min-height: 40px;
          padding: 8px 10px;
          text-align: left;
          transition-property: background-color, box-shadow, transform;
          transition-duration: 160ms;
          transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
          width: 100%;
        }

        .order-label-pages-viewer__list-button:active {
          transform: scale(0.96);
        }

        .order-label-pages-viewer__list-button--active {
          background: rgba(22, 119, 255, 0.08);
          box-shadow: inset 0 0 0 2px #1677ff;
          color: #0958d9;
          font-weight: 600;
        }

        .order-label-pages-viewer__preview {
          min-width: 0;
        }

        .order-label-pages-viewer__print-toolbar {
          display: none;
        }

        .order-label-pages-viewer__inspector {
          display: none;
        }

        [data-ui-variant="line"] .order-label-pages-viewer__print-toolbar,
        [data-ui-variant="air"] .order-label-pages-viewer__print-toolbar {
          align-items: flex-end;
          display: flex;
          gap: 8px;
          justify-content: flex-start;
          min-height: 66px;
          margin-bottom: 0;
          padding: 10px 12px 8px;
          border-bottom: 1px solid var(--app-border);
        }

        .order-label-pages-viewer__print-field {
          display: grid;
          min-width: 140px;
          gap: 4px;
        }

        .order-label-pages-viewer__print-field > span {
          color: var(--app-text-muted);
          font-size: 9px;
          font-weight: 700;
        }

        [data-ui-variant="line"] .order-label-pages-viewer__inspector,
        [data-ui-variant="air"] .order-label-pages-viewer__inspector {
          background: var(--app-surface, #fff);
          border-radius: var(--operational-radius);
          box-shadow: inset 0 0 0 1px var(--app-border);
          display: flex;
          flex-direction: column;
          min-width: 0;
          overflow: hidden;
        }

        .order-label-pages-viewer__inspector-head {
          border-bottom: 1px solid var(--app-border);
          padding: 14px;
        }

        .order-label-pages-viewer__inspector-body {
          display: flex;
          flex: 1;
          flex-direction: column;
          gap: 12px;
          padding: 14px;
        }

        .order-label-pages-viewer__definition {
          display: grid;
          grid-template-columns: repeat(2, minmax(0, 1fr));
          gap: 10px 12px;
          margin: 0;
        }

        .order-label-pages-viewer__definition div {
          display: grid;
          min-width: 0;
          gap: 3px;
        }

        .order-label-pages-viewer__definition dt {
          color: var(--app-text-muted);
        }

        .order-label-pages-viewer__definition dd {
          margin: 0;
          font-weight: 600;
        }

        .order-label-pages-viewer__relations {
          display: grid;
          gap: 7px;
        }

        .order-label-pages-viewer__relation {
          display: grid;
          gap: 2px;
          padding: 9px 10px;
          border: 1px solid var(--app-border);
          border-radius: calc(var(--operational-radius) - 3px);
          background: var(--app-surface);
        }

        .order-label-pages-viewer__relation small {
          color: var(--app-text-muted);
        }

        .order-label-pages-viewer__toolbar {
          align-items: center;
          display: flex;
          gap: 8px;
          justify-content: space-between;
          margin-bottom: 8px;
        }

        [data-ui-variant="line"] .order-label-pages-viewer--operational .order-label-pages-viewer__preview,
        [data-ui-variant="air"] .order-label-pages-viewer--operational .order-label-pages-viewer__preview {
          display: flex;
          min-height: 0;
          flex-direction: column;
          overflow: hidden;
          border: 1px solid var(--app-border);
          border-radius: var(--operational-radius);
          background: var(--app-surface);
        }

        [data-ui-variant="line"] .order-label-pages-viewer--operational .order-label-pages-viewer__toolbar,
        [data-ui-variant="air"] .order-label-pages-viewer--operational .order-label-pages-viewer__toolbar {
          min-height: 42px;
          margin: 0;
          padding: 6px 12px;
          border-bottom: 1px solid var(--app-border);
        }

        [data-ui-variant="line"] .order-label-pages-viewer--operational .order-label-pages-viewer__frame,
        [data-ui-variant="air"] .order-label-pages-viewer--operational .order-label-pages-viewer__frame {
          display: flex;
          min-height: 430px;
          flex: 1;
          align-items: center;
          justify-content: center;
          padding: 30px;
          background: var(--app-bg);
        }

        .order-label-pages-viewer__frame {
          display: inline-block;
          max-width: 100%;
          overflow: hidden;
        }

        .order-label-pages-viewer__frame svg {
          display: block;
          height: auto;
          max-height: min(54vh, 520px);
          max-width: 100%;
          width: auto;
        }

        @media (max-width: 720px) {
          .order-label-pages-viewer {
            grid-template-columns: 1fr;
          }

          [data-ui-variant="line"] .order-label-pages-viewer--operational,
          [data-ui-variant="air"] .order-label-pages-viewer--operational {
            grid-template-columns: 1fr;
          }

          .order-label-pages-viewer__list-panel {
            padding: 8px;
          }

          .order-label-pages-viewer__list {
            flex-direction: row;
            max-height: none;
            overflow-x: auto;
            padding-bottom: 2px;
          }

          .order-label-pages-viewer__list-button {
            min-width: 112px;
          }
        }
      `}</style>
      <div className="order-label-pages-viewer__top">
        <Space direction="vertical" size={0}>
          <Text strong>{title}</Text>
          <Text type="secondary">
            {description ?? (isOperational
              ? `Подготовлено к печати: ${pageCount} шт.`
              : 'Список бирок слева, на телефоне — сверху. В системном окне печати номера страниц совпадают с номерами бирок.')}
          </Text>
        </Space>
        {printEnabled && !isOperational && (
          <Button icon={<PrinterOutlined />} onClick={runPrint}>
            Печать
          </Button>
        )}
      </div>
      <div className={`order-label-pages-viewer${isOperational ? ' order-label-pages-viewer--operational' : ''}`}>
        <div className="order-label-pages-viewer__list-panel">
          <div className="order-label-pages-viewer__list-title">
            <Text strong>Список бирок</Text>
            <Text type="secondary" className="order-label-pages-viewer__list-count">
              {pageCount} шт.
            </Text>
          </div>
          {isOperational ? (
            <Input
              allowClear
              prefix={<SearchOutlined />}
              placeholder="Номер или деталь"
              aria-label="Поиск бирки"
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              style={{ marginBottom: 8 }}
            />
          ) : null}
          <div className="order-label-pages-viewer__list" aria-label="Список бирок" role="list">
            {pageButtons.map((index) => (
              <button
                key={index}
                type="button"
                className={[
                  'order-label-pages-viewer__list-button',
                  index === selectedIndex ? 'order-label-pages-viewer__list-button--active' : '',
                ].filter(Boolean).join(' ')}
                aria-current={index === selectedIndex ? 'page' : undefined}
                onClick={() => selectIndex(index)}
              >
                Бирка {index + 1}
              </button>
            ))}
          </div>
        </div>
        <div className="order-label-pages-viewer__preview">
          {isOperational && printEnabled ? (
            <div className="order-label-pages-viewer__print-toolbar">
              <label className="order-label-pages-viewer__print-field">
                <span>Шаблон</span>
                <Select
                  aria-label="Шаблон печати"
                  value="current"
                  options={[{ value: 'current', label: 'Текущая генерация' }]}
                />
              </label>
              <label className="order-label-pages-viewer__print-field">
                <span>Диапазон</span>
                <Select
                  aria-label="Диапазон печати"
                  value={printScope}
                  options={[
                    { value: 'current', label: 'Текущая бирка' },
                    { value: 'all', label: `Все ${pageCount}` },
                  ]}
                  onChange={setPrintScope}
                />
              </label>
              <Button onClick={() => {
                const opened = printLabelSvgPages([selectedSvg], printTitle ?? title, { appendBlankPage: appendBlankLabelOnPrint });
                if (!opened) message.error('Не удалось открыть окно печати');
              }}>
                Пробная печать
              </Button>
              <Button type="primary" icon={<PrinterOutlined />} onClick={runPrint}>
                Печатать
              </Button>
            </div>
          ) : null}
          <div className="order-label-pages-viewer__toolbar">
            <Space>
              <Button
                size="small"
                icon={<LeftOutlined />}
                onClick={() => move(-1)}
                disabled={selectedIndex <= 0}
              >
                Предыдущая
              </Button>
              <Button
                size="small"
                icon={<RightOutlined />}
                onClick={() => move(1)}
                disabled={selectedIndex >= pageCount - 1}
              >
                Следующая
              </Button>
            </Space>
            <Text type="secondary" style={{ fontVariantNumeric: 'tabular-nums' }}>
              {labelPageTitle(selectedIndex, pageCount)}
            </Text>
          </div>
          <LabelSvgPreviewFrame
            svg={selectedSvg}
            className="order-label-pages-viewer__frame"
          />
          {printEnabled && (
            <div className="order-label-pages-viewer__print-help" style={{ marginTop: 8 }}>
              <Text type="secondary">
                Для печати части списка в окне печати выберите диапазон страниц, например 1-3 или 2,5.
              </Text>
            </div>
          )}
        </div>
        {isOperational ? (
          <aside className="order-label-pages-viewer__inspector">
            <div className="order-label-pages-viewer__inspector-head">
              <Text type="secondary">Данные бирки</Text>
              <Typography.Title level={3} style={{ margin: '4px 0 0' }}>
                Позиция {String(position)}
              </Typography.Title>
            </div>
            <div className="order-label-pages-viewer__inspector-body">
              <Text type="success">Бирка сформирована и готова к печати.</Text>
              <dl className="order-label-pages-viewer__definition">
                <div><dt>Наименование</dt><dd>{String(detailName ?? '—')}</dd></div>
                <div><dt>Размер</dt><dd>{String(detailSize ?? '—')}</dd></div>
                <div><dt>Материал</dt><dd>{String(material ?? '—')}</dd></div>
                <div><dt>Плёнка</dt><dd>{String(film ?? '—')}</dd></div>
                <div><dt>Количество</dt><dd>{String(quantity ?? '—')}</dd></div>
                <div><dt>Обозначение</dt><dd>{String(designation ?? '—')}</dd></div>
              </dl>
              {selectedRow ? (
                <>
                  <Text strong>Связи</Text>
                  <div className="order-label-pages-viewer__relations">
                    <div className="order-label-pages-viewer__relation">
                      <strong>Заказ {selectedRow.orderId}</strong>
                      <small>{pageCount} бирок в текущей генерации</small>
                    </div>
                    <div className="order-label-pages-viewer__relation">
                      <strong>Деталь #{selectedRow.detailId}</strong>
                      <small>{`Копия ${selectedRow.copyIndex + 1} из ${selectedRow.copyCount}`}</small>
                    </div>
                  </div>
                </>
              ) : null}
              <span style={{ flex: 1 }} />
              {printEnabled ? (
                <Button
                  type="primary"
                  icon={<PrinterOutlined />}
                  onClick={() => {
                    setPrintScope('current');
                    const opened = printLabelSvgPages([selectedSvg], printTitle ?? title, { appendBlankPage: appendBlankLabelOnPrint });
                    if (!opened) message.error('Не удалось открыть окно печати');
                  }}
                >
                  Печать выбранной
                </Button>
              ) : null}
            </div>
          </aside>
        ) : null}
      </div>
    </div>
  );
};
