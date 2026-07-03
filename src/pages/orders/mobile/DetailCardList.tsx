import React from 'react';
import { Card, Typography } from 'antd';
import { buildDetailCardModel } from './detailCardModel';
import type { DetailCardLookups } from './detailCardModel';

export const DetailCardList: React.FC<{
  rows: readonly Record<string, unknown>[];
  lookups: DetailCardLookups;
}> = ({ rows, lookups }) => (
  <div>
    {rows.map((row, i) => {
      const m = buildDetailCardModel(row, lookups);
      return (
        <Card key={i} size="small" style={{ marginBottom: 8 }}>
          <Typography.Text strong style={{ display: 'block' }}>{m.num} · {m.size}</Typography.Text>
          <Typography.Text style={{ display: 'block' }}>{m.material}</Typography.Text>
          <Typography.Text type="secondary" style={{ display: 'block' }}>{m.milling}</Typography.Text>
          {m.note && <Typography.Text type="secondary" style={{ display: 'block' }}>{m.note}</Typography.Text>}
        </Card>
      );
    })}
  </div>
);
