// Order Notes Section
// Contains: Notes field (full width)

import React from 'react';
import { Form, Row, Col, Input } from 'antd';
import { RightOutlined } from '@ant-design/icons';
import { useOrderFormStore } from '../../../../stores/orderFormStore';
import { useOptionalUiVariant } from '../../../../ui-variant/UiVariantProvider';

const { TextArea } = Input;

export const OrderNotesSection: React.FC = () => {
  const { header, updateHeaderField } = useOrderFormStore();

  // Debug: log header to check if notes is loaded
  React.useEffect(() => {
    console.log('[OrderNotesSection] header.notes:', header.notes);
  }, [header.notes]);

  const isWorkbench = useOptionalUiVariant()?.variant === 'workbench';
  const [notesOpen, setNotesOpen] = React.useState(false);

  if (isWorkbench) {
    // «NewLine»: примечание свёрнуто, пока его не открыли; текст виден в строке-заголовке.
    const notes = typeof header.notes === 'string' ? header.notes.trim() : '';
    return (
      <div className={`wb-form-notes${notesOpen ? ' wb-form-notes--open' : ''}`}>
        <div className="wb-form-notes__head">
          <button
            type="button"
            className="wb-form-notes__toggle"
            aria-expanded={notesOpen}
            onClick={() => setNotesOpen((open) => !open)}
          >
            <RightOutlined className="wb-form-notes__chevron" aria-hidden />
            <span className="wb-form-notes__label">Примечание</span>
            {!notesOpen ? (
              <span className="wb-form-notes__preview" data-empty={notes.length === 0}>
                {notes.length > 0 ? notes : 'нет — нажмите, чтобы добавить'}
              </span>
            ) : null}
          </button>
          {header.order_id ? <span className="wb-form-notes__id">ID заказа: {header.order_id}</span> : null}
        </div>
        {notesOpen ? (
          <TextArea
            autoFocus
            value={header.notes ?? ''}
            onChange={(e) => updateHeaderField('notes', e.target.value || null)}
            placeholder="Введите примечание к заказу"
            autoSize={{ minRows: 2, maxRows: 8 }}
            maxLength={1000}
            showCount
          />
        ) : null}
      </div>
    );
  }

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
