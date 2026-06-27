// Order Files Block (Read-only for show page)
// Minimalist design with purple border

import React from 'react';
import { Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';

const { Text, Link } = Typography;

interface OrderFilesBlockProps {
  record: any;
  compact?: boolean;
}

export const OrderFilesBlock: React.FC<OrderFilesBlockProps> = ({ record, compact = false }) => {
  const renderLink = (url?: string | null, label?: string) => {
    if (!url) return <Text style={{ fontSize: compact ? 12 : 13, color: 'var(--app-text-muted)' }}>—</Text>;
    
    return (
      <Link 
        href={url} 
        target="_blank" 
        rel="noopener noreferrer"
        style={{ fontSize: compact ? 12 : 13 }}
      >
        <LinkOutlined style={{ marginRight: 4 }} />
        {label || 'Открыть файл'}
      </Link>
    );
  };

  return (
    <div style={{ padding: compact ? '4px 8px' : '10px 16px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: compact ? 8 : 16,
        }}
      >
        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Файл раскроя
          </Text>
          {renderLink(record?.link_cutting_file)}
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            Изображение раскроя
          </Text>
          {renderLink(record?.link_cutting_image_file)}
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            CAD файл
          </Text>
          {renderLink(record?.link_cad_file)}
        </div>

        <div>
          <Text style={{ fontSize: compact ? 11 : 12, color: 'var(--app-text-muted)', display: 'block', marginBottom: compact ? 1 : 4 }}>
            PDF файл
          </Text>
          {renderLink(record?.link_pdf_file)}
        </div>
      </div>
    </div>
  );
};
