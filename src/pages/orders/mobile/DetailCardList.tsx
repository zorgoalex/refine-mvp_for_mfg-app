import React, { useEffect, useRef } from 'react';
import { Card, Typography } from 'antd';
import { buildDetailCardModel } from './detailCardModel';
import type { DetailCardLookups } from './detailCardModel';

export const DetailCardList: React.FC<{
  rows: readonly Record<string, unknown>[];
  lookups: DetailCardLookups;
  /** detail_id to highlight (from ?highlightDetail=) and scroll into view on mount. */
  highlightDetailId?: number | null;
}> = ({ rows, lookups, highlightDetailId = null }) => {
  const highlightRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (highlightDetailId != null) {
      highlightRef.current?.scrollIntoView({ block: 'center' });
    }
    // Only run once on mount for the current highlight target — rows can
    // re-render frequently and we don't want to keep re-scrolling.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div>
      {rows.map((row, i) => {
        const m = buildDetailCardModel(row, lookups);
        const isHighlighted = highlightDetailId != null && Number(row.detail_id) === highlightDetailId;
        return (
          <Card
            key={i}
            ref={isHighlighted ? highlightRef : undefined}
            size="small"
            style={{
              marginBottom: 8,
              ...(isHighlighted
                ? { border: '2px solid var(--ant-color-primary, #1677ff)', background: 'var(--app-highlight)' }
                : {}),
            }}
          >
            <Typography.Text strong style={{ display: 'block' }}>{m.num} · {m.size}</Typography.Text>
            <Typography.Text style={{ display: 'block' }}>{m.material}</Typography.Text>
            <Typography.Text type="secondary" style={{ display: 'block' }}>{m.milling}</Typography.Text>
            {m.note && <Typography.Text type="secondary" style={{ display: 'block' }}>{m.note}</Typography.Text>}
          </Card>
        );
      })}
    </div>
  );
};
