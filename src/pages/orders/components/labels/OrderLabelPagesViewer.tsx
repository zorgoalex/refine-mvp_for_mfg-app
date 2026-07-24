import React, { useEffect, useMemo, useState } from 'react';
import { Button, Empty, Space, Typography, message } from 'antd';
import { LeftOutlined, PrinterOutlined, RightOutlined } from '@ant-design/icons';
import { LabelSvgPreviewFrame } from './LabelSvgPreviewFrame';
import { printLabelSvgPages } from './labelPrint';

const { Text } = Typography;

interface OrderLabelPagesViewerProps {
  svgPages: string[];
  title: string;
  description?: React.ReactNode;
  printTitle?: string;
  printEnabled?: boolean;
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
  title,
  description,
  printTitle,
  printEnabled = true,
}) => {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const pageCount = svgPages.length;
  const selectedSvg = svgPages[clampLabelPageIndex(selectedIndex, pageCount)] ?? null;
  const pageButtons = useMemo(() => svgPages.map((_, index) => index), [svgPages]);

  useEffect(() => {
    setSelectedIndex((current) => clampLabelPageIndex(current, pageCount));
  }, [pageCount]);

  const move = (delta: number) => {
    setSelectedIndex((current) => clampLabelPageIndex(current + delta, pageCount));
  };

  const runPrint = () => {
    const opened = printLabelSvgPages(svgPages, printTitle ?? title);
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

        .order-label-pages-viewer__toolbar {
          align-items: center;
          display: flex;
          gap: 8px;
          justify-content: space-between;
          margin-bottom: 8px;
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
            {description ?? 'Выберите бирку в списке. В системном окне печати номера страниц совпадают с номерами бирок.'}
          </Text>
        </Space>
        {printEnabled && (
          <Button icon={<PrinterOutlined />} onClick={runPrint}>
            Печать
          </Button>
        )}
      </div>
      <div className="order-label-pages-viewer">
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
              onClick={() => setSelectedIndex(index)}
            >
              Бирка {index + 1}
            </button>
          ))}
        </div>
        <div className="order-label-pages-viewer__preview">
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
            <div style={{ marginTop: 8 }}>
              <Text type="secondary">
                Для печати части списка в окне печати выберите диапазон страниц, например 1-3 или 2,5.
              </Text>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
