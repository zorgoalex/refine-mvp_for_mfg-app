// Order Dates Section
// Contains: Planned Completion Date, Completion Date, Issue Date

import React from 'react';
import { Form, DatePicker, Row, Col } from 'antd';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import dayjs from 'dayjs';

export const OrderDatesSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  return (
    <Form layout="vertical">
      <Row gutter={16}>
        <Col span={8}>
          <Form.Item label="Плановая дата завершения">
            <DatePicker
              value={header.planned_completion_date ? dayjs(header.planned_completion_date) : null}
              onChange={(date) =>
                updateHeaderField('planned_completion_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item label="Дата завершения">
            <DatePicker
              value={header.completion_date ? dayjs(header.completion_date) : null}
              onChange={(date) =>
                updateHeaderField('completion_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>

        <Col span={8}>
          <Form.Item label="Дата выдачи">
            <DatePicker
              value={header.issue_date ? dayjs(header.issue_date) : null}
              onChange={(date) =>
                updateHeaderField('issue_date', date ? date.format('YYYY-MM-DD') : null)
              }
              style={{ width: '100%' }}
              format="DD.MM.YYYY"
            />
          </Form.Item>
        </Col>
      </Row>
    </Form>
  );
};
