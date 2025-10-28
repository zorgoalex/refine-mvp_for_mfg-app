// Order Files Section
// Contains: Links to cutting file, image, CAD, PDF

import React from 'react';
import { Form, Input, Row, Col, Collapse } from 'antd';
import { LinkOutlined } from '@ant-design/icons';
import { useOrderFormStore } from '../../../../stores/orderFormStore';

const { Panel } = Collapse;

export const OrderFilesSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  return (
    <Collapse>
      <Panel header="Ссылки на файлы" key="1">
        <Form layout="vertical">
          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Ссылка на файл раскроя">
                <Input
                  value={header.link_cutting_file || ''}
                  onChange={(e) => updateHeaderField('link_cutting_file', e.target.value || null)}
                  placeholder="https://..."
                  prefix={<LinkOutlined />}
                />
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item label="Ссылка на изображение раскроя">
                <Input
                  value={header.link_cutting_image_file || ''}
                  onChange={(e) => updateHeaderField('link_cutting_image_file', e.target.value || null)}
                  placeholder="https://..."
                  prefix={<LinkOutlined />}
                />
              </Form.Item>
            </Col>
          </Row>

          <Row gutter={16}>
            <Col span={12}>
              <Form.Item label="Ссылка на CAD файл">
                <Input
                  value={header.link_cad_file || ''}
                  onChange={(e) => updateHeaderField('link_cad_file', e.target.value || null)}
                  placeholder="https://..."
                  prefix={<LinkOutlined />}
                />
              </Form.Item>
            </Col>

            <Col span={12}>
              <Form.Item label="Ссылка на PDF файл">
                <Input
                  value={header.link_pdf_file || ''}
                  onChange={(e) => updateHeaderField('link_pdf_file', e.target.value || null)}
                  placeholder="https://..."
                  prefix={<LinkOutlined />}
                />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Panel>
    </Collapse>
  );
};
