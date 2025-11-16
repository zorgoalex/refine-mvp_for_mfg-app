// Order Files Block (Read-only for show page)
// Minimalist design with purple border

import React from 'react';
import { Typography } from 'antd';
import { LinkOutlined } from '@ant-design/icons';

const { Text, Link } = Typography;

interface OrderFilesBlockProps {
  record: any;
}

export const OrderFilesBlock: React.FC<OrderFilesBlockProps> = ({ record }) => {
  const renderLink = (url?: string | null, label?: string) => {
    if (!url) return <Text style={{ fontSize: 13, color: '#8c8c8c' }}>—</Text>;
    
    return (
      <Link 
        href={url} 
        target="_blank" 
        rel="noopener noreferrer"
        style={{ fontSize: 13 }}
      >
        <LinkOutlined style={{ marginRight: 4 }} />
        {label || 'Открыть файл'}
      </Link>
    );
  };

  return (
    <div style={{ padding: '10px 16px' }}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(2, 1fr)',
          gap: 16,
        }}
      >
        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Файл раскроя
          </Text>
          {renderLink(record?.link_cutting_file)}
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            Изображение раскроя
          </Text>
          {renderLink(record?.link_cutting_image_file)}
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            CAD файл
          </Text>
          {renderLink(record?.link_cad_file)}
        </div>

        <div>
          <Text style={{ fontSize: 12, color: '#8c8c8c', display: 'block', marginBottom: 4 }}>
            PDF файл
          </Text>
          {renderLink(record?.link_pdf_file)}
        </div>
      </div>
    </div>
  );
};
