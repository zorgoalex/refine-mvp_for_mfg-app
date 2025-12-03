// Order Notes Section
// Contains: Notes field (full width)

import React from 'react';
import { Form, Row, Col, Input } from 'antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

const { TextArea } = Input;

export const OrderNotesSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  // Debug: log header to check if notes is loaded
  React.useEffect(() => {
    console.log('[OrderNotesSection] header.notes:', header.notes);
  }, [header.notes]);

  return (
    <Form layout="vertical">
      <Row gutter={16}>
        <Col span={24}>
          <Form.Item label="Примечание">
            <TextArea
              value={header.notes ?? ''}
              onChange={(e) => updateHeaderField('notes', e.target.value || null)}
              placeholder="Введите примечание к заказу"
              rows={4}
              maxLength={1000}
              showCount
            />
          </Form.Item>
        </Col>
      </Row>

      {/* ID заказа (read-only) - в самом низу, мелким шрифтом */}
      {header.order_id && (
        <div style={{ fontSize: '0.75em', color: '#999', marginTop: 8 }}>
          ID заказа: {header.order_id}
        </div>
      )}
    </Form>
  );
};
