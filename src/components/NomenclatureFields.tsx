import React from 'react';
import { Col, Form, Input, Typography } from 'antd';
import { Tooltip } from '../ui/tooltipDelay';
import { categoryDisplay } from '../pages/films/categoryDisplay';

// Тип и категория номенклатуры 1С и примечание — одинаково в плёнках, листовых материалах и «Товарах и услугах».

export interface NomenclatureValues {
  nomenclatureType?: string | null;
  nomenclatureCategory?: string | null;
  note?: string | null;
}

/** Backend знает поля (они есть в ответе API). Старый backend поля не принимает — форма их не показывает и не шлёт. */
export const supportsNomenclature = (dto: object | null | undefined): boolean => Boolean(dto && 'note' in dto);

/** Поля для отправки: только если backend их знает; пустые — null (очистить). */
export function nomenclaturePayload(values: NomenclatureValues, supported: boolean): NomenclatureValues {
  if (!supported) return {};
  const text = (value: string | null | undefined) => (value ?? '').trim() || null;
  return { nomenclatureType: text(values.nomenclatureType), nomenclatureCategory: text(values.nomenclatureCategory), note: text(values.note) };
}

/** Примечание в списке: две строки, остальное — «…», полный текст — в подсказке. */
export const NoteCell: React.FC<{ value: string | null | undefined }> = ({ value }) => {
  if (!value) return <>—</>;
  const text = value.replace(/\s*\n\s*/g, ' · ');
  return (
    <Tooltip title={text}>
      <span style={{ display: '-webkit-box', WebkitBoxOrient: 'vertical', WebkitLineClamp: 2, overflow: 'hidden', overflowWrap: 'anywhere', lineHeight: 1.3 }}>{text}</span>
    </Tooltip>
  );
};

export const CategoryCell: React.FC<{ value: string | null | undefined }> = ({ value }) => <>{value ? categoryDisplay(value) : '—'}</>;

/** Поля формы (camelCase, запись через backend). */
export const NomenclatureFormItems: React.FC<{ colProps?: React.ComponentProps<typeof Col> }> = ({ colProps }) => (
  <>
    <Col {...colProps}>
      <Form.Item name="nomenclatureType" label="Тип номенклатуры" rules={[{ max: 50, message: 'Максимум 50 символов' }]}>
        <Input maxLength={50} allowClear />
      </Form.Item>
    </Col>
    <Col {...colProps}>
      <Form.Item name="nomenclatureCategory" label="Категория номенклатуры" rules={[{ max: 150, message: 'Максимум 150 символов' }]}>
        <Input maxLength={150} allowClear />
      </Form.Item>
    </Col>
    <Col span={24}>
      <Form.Item name="note" label="Примечание" rules={[{ max: 2000, message: 'Максимум 2000 символов' }]}>
        <Input.TextArea maxLength={2000} showCount autoSize={{ minRows: 2, maxRows: 6 }} />
      </Form.Item>
    </Col>
  </>
);

/** Просмотр: три поля. */
export const NomenclatureView: React.FC<{ values: NomenclatureValues | null | undefined }> = ({ values }) => (
  <>
    <Col span={8}><Typography.Title level={5}>Тип номенклатуры</Typography.Title>{values?.nomenclatureType || '—'}</Col>
    <Col span={8}><Typography.Title level={5}>Категория номенклатуры</Typography.Title>{values?.nomenclatureCategory ? categoryDisplay(values.nomenclatureCategory) : '—'}</Col>
    <Col span={24}><Typography.Title level={5}>Примечание</Typography.Title><Typography.Paragraph style={{ whiteSpace: 'pre-wrap' }}>{values?.note || '—'}</Typography.Paragraph></Col>
  </>
);
