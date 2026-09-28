import React, { useMemo } from 'react';
import { Checkbox, Form, Input, InputNumber, Modal, Select, Switch } from 'antd';
import type { OnecEtlEntity } from './onecApi.types';
import {
  ONEC_ETL_ENTITY_FORM_DEFAULTS,
  onecEtlEntityCodeIsDuplicate,
  onecEtlEntityFromFormValues,
  onecEtlEntityToFormValues,
  type OnecEtlEntityFormValues,
} from './onecFormat';

export interface ConfigEntityModalProps {
  initial: OnecEtlEntity | null;
  existingEntities: OnecEtlEntity[];
  onCancel: () => void;
  onSubmit: (entity: OnecEtlEntity) => void;
}

const EDM_TYPE_OPTIONS: Array<{ value: '' | 'Edm.DateTimeOffset' | 'Edm.DateTime'; label: string }> = [
  { value: '', label: '(не задано)' },
  { value: 'Edm.DateTimeOffset', label: 'Edm.DateTimeOffset' },
  { value: 'Edm.DateTime', label: 'Edm.DateTime' },
];

const ODATA_VERSION_OPTIONS: Array<{ value: '' | 3 | 4; label: string }> = [
  { value: '', label: '(по умолчанию)' },
  { value: 3, label: 'OData v3' },
  { value: 4, label: 'OData v4' },
];

export function ConfigEntityModal({ initial, existingEntities, onCancel, onSubmit }: ConfigEntityModalProps) {
  const [form] = Form.useForm<OnecEtlEntityFormValues>();
  const initialValues = useMemo(
    () => (initial ? onecEtlEntityToFormValues(initial) : ONEC_ETL_ENTITY_FORM_DEFAULTS),
    [initial],
  );
  const excludeIndex = initial ? existingEntities.findIndex((entity) => entity.entityCode === initial.entityCode) : -1;

  const submit = async () => {
    const values = await form.validateFields();
    const entity = onecEtlEntityFromFormValues(values);
    if (onecEtlEntityCodeIsDuplicate(existingEntities, entity.entityCode, excludeIndex >= 0 ? excludeIndex : undefined)) {
      form.setFields([{ name: 'entityCode', errors: ['Такой код сущности уже используется'] }]);
      return;
    }
    onSubmit(entity);
  };

  return (
    <Modal
      title={initial ? `Сущность выгрузки: ${initial.entityCode}` : 'Новая сущность выгрузки'}
      open
      onCancel={onCancel}
      onOk={() => void submit()}
      okText="Сохранить"
      cancelText="Отмена"
      width={640}
      destroyOnClose
    >
      <Form form={form} layout="vertical" initialValues={initialValues}>
        <Form.Item
          name="entityCode"
          label="Код сущности"
          rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{0,63}$/, message: 'строчные латинские буквы, цифры, _' }]}
        >
          <Input placeholder="clients" />
        </Form.Item>
        <Form.Item
          name="oDataPath"
          label="OData-путь"
          rules={[{ required: true, message: 'Укажите путь OData' }]}
        >
          <Input placeholder="Catalog_Клиенты" />
        </Form.Item>
        <Form.Item
          name="keyFieldsText"
          label="Ключевые поля"
          tooltip="Через запятую; хотя бы одно из них должно входить в список полей ниже"
          rules={[{ required: true, message: 'Укажите хотя бы одно ключевое поле' }]}
        >
          <Input placeholder="Ref_Key" />
        </Form.Item>
        <Form.Item
          name="selectText"
          label="Выгружаемые поля"
          tooltip="Через запятую"
          rules={[{ required: true, message: 'Укажите хотя бы одно поле' }]}
        >
          <Input.TextArea rows={2} placeholder="Ref_Key, Description, DataVersion" />
        </Form.Item>
        <Form.Item name="updatedAtField" label="Поле версии/даты изменения (опционально)">
          <Input placeholder="DataVersion" />
        </Form.Item>
        <Form.Item name="updatedAtEdmType" label="Тип поля версии/даты (опционально)">
          <Select<'' | 'Edm.DateTimeOffset' | 'Edm.DateTime'> options={EDM_TYPE_OPTIONS} />
        </Form.Item>
        <Form.Item name="deletedField" label="Поле пометки удаления (опционально)">
          <Input placeholder="DeletionMark" />
        </Form.Item>
        <Form.Item name="syncMode" label="Режим синхронизации" rules={[{ required: true, message: 'Укажите режим' }]}>
          <Input placeholder="full" />
        </Form.Item>
        <Form.Item name="pageSize" label="Размер страницы" rules={[{ required: true, type: 'number', min: 1, max: 10000 }]}>
          <InputNumber min={1} max={10000} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item
          name="overlapMinutes"
          label="Перекрытие интервала (мин)"
          rules={[{ required: true, type: 'number', min: 0, max: 10080 }]}
        >
          <InputNumber min={0} max={10080} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="schemaVersion" label="Версия схемы (опционально)">
          <InputNumber min={1} max={1000} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="oDataVersion" label="Версия OData (опционально)">
          <Select<'' | 3 | 4> options={ODATA_VERSION_OPTIONS} />
        </Form.Item>
        <Form.Item name="enabled" label="Включена" valuePropName="checked">
          <Switch />
        </Form.Item>
        <Form.Item
          name="filter"
          label="Фильтр OData (опционально)"
          tooltip="Статическое выражение $filter над набором, например Тип eq 'Телефон'. Смена фильтра у агента — новая базовая выгрузка сущности."
          rules={[{ max: 512, message: 'Не длиннее 512 символов' }]}
        >
          <Input />
        </Form.Item>
        <Form.Item
          name="deleteBatchAfterAck"
          valuePropName="checked"
          tooltip="Только для персональных данных: агент удалит выгруженный пакет у себя сразу после подтверждения ERP, не дожидаясь ретеншена"
        >
          <Checkbox>Удалять пакет у агента сразу после подтверждения (персональные данные)</Checkbox>
        </Form.Item>
      </Form>
    </Modal>
  );
}
