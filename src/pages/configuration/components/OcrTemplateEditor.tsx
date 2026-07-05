import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Divider, Drawer, Input, Select, Space, Switch, Table, Tag, Typography, Upload, message } from 'antd';
import { UploadOutlined } from '@ant-design/icons';
import { ApiError } from '../../../api/apiError';
import { labelsApi } from '../../../api/labelsApi';
import type {
  LabelOcrTemplate,
  OcrFieldCode,
  OcrLabelTextFields,
  OcrTemplateRule,
  OcrTestResult,
} from '../../../api/types/labelsApi.types';
import { OCR_FIELD_LABELS_RU, buildOcrTemplateInput, normalizeBox, suggestAnchor, validateOcrRulesFe } from './ocrTemplateHelpers';

const { Text } = Typography;

interface OcrTemplateEditorProps {
  open: boolean;
  template?: LabelOcrTemplate;
  canManage: boolean;
  onClose: () => void;
  onSaved: () => void;
}

interface RecognizedLine {
  text: string;
  score: number;
  box?: number[][];
}

const FIELD_OPTIONS = (Object.keys(OCR_FIELD_LABELS_RU) as OcrFieldCode[]).map((field) => ({
  value: field,
  label: OCR_FIELD_LABELS_RU[field],
}));

function newIdempotencyKey(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return c?.randomUUID ? c.randomUUID() : `ocr-template-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

// Mirrors ScanPage.handleResolveOcr's catch branches 1:1 — same backend OCR
// codes, same RU copy, so the editor and the live scanner never drift on
// what a given failure means to the user.
function describeOcrError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'OCR_SERVICE_UNAVAILABLE') return 'Распознавание временно недоступно';
    if (error.code === 'OCR_SERVICE_BUSY') return 'Сканер занят, попробуйте через минуту';
    if (error.code === 'UNSUPPORTED_IMAGE_TYPE') return 'Формат изображения не поддерживается';
    if (error.code === 'OCR_IMAGE_UNREADABLE') return 'Не удалось прочитать изображение. Попробуйте другое фото.';
    if (error.status === 403 || error.status === 401) return 'Нет доступа к сканеру бирок. Обратитесь к администратору.';
    return 'Сервис сканера временно недоступен. Попробуйте позже.';
  }
  const name = (error as { name?: string } | null)?.name;
  if (name === 'TimeoutError' || name === 'AbortError') {
    return 'Не удалось распознать за отведённое время. Попробуйте ещё раз или сфотографируйте бирку крупнее.';
  }
  return 'Ошибка сети. Проверьте подключение и попробуйте ещё раз.';
}

const FIELD_ROWS: Array<{ key: keyof OcrLabelTextFields; label: string }> = [
  { key: 'orderName', label: 'Имя заказа' },
  { key: 'detailNumber', label: 'Номер позиции' },
  { key: 'width', label: 'Ширина' },
  { key: 'height', label: 'Высота' },
  { key: 'date', label: 'Дата' },
  { key: 'material', label: 'Материал' },
];

function FieldsComparisonTable({ fields, fallbackFields }: { fields: OcrLabelTextFields; fallbackFields: OcrLabelTextFields }) {
  const rows = FIELD_ROWS.map((row) => ({
    key: row.key,
    label: row.label,
    templateValue: fields[row.key],
    fallbackValue: fallbackFields[row.key],
  }));
  return (
    <Table
      size="small"
      pagination={false}
      dataSource={rows}
      rowKey="key"
      columns={[
        { title: 'Поле', dataIndex: 'label', key: 'label' },
        {
          title: 'Шаблон',
          dataIndex: 'templateValue',
          key: 'templateValue',
          render: (value: unknown) => (value === undefined || value === null || value === '' ? <Text type="secondary">—</Text> : String(value)),
        },
        {
          title: 'Fallback',
          dataIndex: 'fallbackValue',
          key: 'fallbackValue',
          render: (value: unknown) => (value === undefined || value === null || value === '' ? <Text type="secondary">—</Text> : String(value)),
        },
      ]}
    />
  );
}

/**
 * Rule builder for a single OCR label template: upload a sample photo,
 * recognize its text lines, assign a field code (and optional anchor) to
 * each line in order, then test the rule set against another photo before
 * saving. Line ORDER is preserved end-to-end because the backend matcher is
 * order-sensitive — 'ignore' rules are kept in the saved payload for that
 * reason, not filtered out.
 */
export const OcrTemplateEditor: React.FC<OcrTemplateEditorProps> = ({ open, template, canManage, onClose, onSaved }) => {
  const [name, setName] = useState('');
  const [isActive, setIsActive] = useState(true);
  const [lines, setLines] = useState<RecognizedLine[]>([]);
  const [rules, setRules] = useState<OcrTemplateRule[]>([]);

  const [recognizing, setRecognizing] = useState(false);
  const [recognizeError, setRecognizeError] = useState<string | null>(null);

  const [testing, setTesting] = useState(false);
  const [testError, setTestError] = useState<string | null>(null);
  const [testResult, setTestResult] = useState<OcrTestResult | null>(null);

  const [saving, setSaving] = useState(false);

  // Uploaded sample photo + the OCR-processed image's pixel dimensions, used
  // to draw the recognized-line box overlay on top of it. Re-edit (template
  // prop only, no fresh upload) never sets these, so the overlay stays hidden.
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const [imageWidth, setImageWidth] = useState<number | undefined>(undefined);
  const [imageHeight, setImageHeight] = useState<number | undefined>(undefined);
  // Shared by both interaction directions: hovering a line row highlights its
  // box, and clicking a box selects (and scrolls to) its row.
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const rowRefs = useRef<Array<HTMLDivElement | null>>([]);
  const photoUrlRef = useRef<string | null>(null);
  useEffect(() => {
    photoUrlRef.current = photoUrl;
  }, [photoUrl]);

  useEffect(() => {
    if (!open) return;
    if (template) {
      setName(template.name);
      setIsActive(template.isActive);
      setLines(template.sampleLines.map((text) => ({ text, score: 1 })));
      setRules(template.rules.map((rule) => ({ ...rule })));
    } else {
      setName('');
      setIsActive(true);
      setLines([]);
      setRules([]);
    }
    setRecognizeError(null);
    setTestError(null);
    setTestResult(null);
    setPhotoUrl((prev) => {
      if (prev) URL.revokeObjectURL(prev);
      return null;
    });
    setImageWidth(undefined);
    setImageHeight(undefined);
    setActiveIndex(null);
  }, [open, template]);

  // Revoke whatever object URL is live when the editor unmounts entirely
  // (Drawer's destroyOnClose tears the component down on close).
  useEffect(() => {
    return () => {
      if (photoUrlRef.current) URL.revokeObjectURL(photoUrlRef.current);
    };
  }, []);

  const handleRecognize = useCallback(async (file: File) => {
    setRecognizing(true);
    setRecognizeError(null);
    try {
      const result = await labelsApi.previewOcrLabel(file);
      setLines(result.lines);
      setRules(result.lines.map((line) => ({ field: 'ignore' as OcrFieldCode, sampleText: line.text, anchor: null })));
      setTestResult(null);
      setActiveIndex(null);
      setImageWidth(result.imageWidth);
      setImageHeight(result.imageHeight);
      setPhotoUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return URL.createObjectURL(file);
      });
    } catch (error) {
      setRecognizeError(describeOcrError(error));
    } finally {
      setRecognizing(false);
    }
  }, []);

  const handleTest = useCallback(
    async (file: File) => {
      setTesting(true);
      setTestError(null);
      try {
        const result = await labelsApi.testOcrTemplate(file, rules);
        setTestResult(result);
      } catch (error) {
        setTestError(describeOcrError(error));
      } finally {
        setTesting(false);
      }
    },
    [rules],
  );

  const updateRule = useCallback((index: number, patch: Partial<OcrTemplateRule>) => {
    setRules((prev) => prev.map((rule, i) => (i === index ? { ...rule, ...patch } : rule)));
  }, []);

  const validationMessage = validateOcrRulesFe(rules);

  const handleSave = useCallback(async () => {
    if (!canManage || validationMessage) return;
    setSaving(true);
    try {
      const input = buildOcrTemplateInput({
        name: name.trim(),
        isActive,
        rules,
        sampleLines: lines.map((line) => line.text),
        idempotencyKey: newIdempotencyKey(),
      });
      if (template) {
        await labelsApi.updateOcrTemplate(template.labelOcrTemplateId, { ...input, version: template.version });
      } else {
        await labelsApi.createOcrTemplate(input);
      }
      message.success(template ? 'OCR-шаблон обновлён' : 'OCR-шаблон создан');
      onSaved();
      onClose();
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        message.error('OCR-шаблон изменён в другом месте. Список обновлён.');
        onSaved();
        return;
      }
      message.error(describeOcrError(error));
    } finally {
      setSaving(false);
    }
  }, [canManage, validationMessage, name, isActive, rules, lines, template, onSaved, onClose]);

  return (
    <Drawer
      title={template ? `OCR-шаблон: ${template.name}` : 'Новый OCR-шаблон'}
      width={640}
      open={open}
      onClose={onClose}
      destroyOnClose
      extra={
        <Button type="primary" loading={saving} disabled={!canManage || !!validationMessage || lines.length === 0} onClick={() => void handleSave()}>
          Сохранить
        </Button>
      }
    >
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        <Space wrap>
          <Input
            placeholder="Название шаблона"
            value={name}
            disabled={!canManage}
            onChange={(e) => setName(e.target.value)}
            style={{ width: 260 }}
          />
          <Space>
            <Text>Активен</Text>
            <Switch checked={isActive} disabled={!canManage} onChange={setIsActive} />
          </Space>
        </Space>

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong>Загрузить фото бирки → Распознать</Text>
          <div style={{ marginTop: 8 }}>
            <Upload
              accept="image/*"
              showUploadList={false}
              disabled={!canManage || recognizing}
              beforeUpload={(file) => {
                void handleRecognize(file as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={recognizing} disabled={!canManage}>
                Загрузить фото и распознать
              </Button>
            </Upload>
          </div>
          {recognizeError && <Alert type="error" showIcon message={recognizeError} style={{ marginTop: 8 }} />}
        </div>

        {lines.length > 0 && (
          <div>
            <Text strong>Строки бирки</Text>

            {photoUrl && (
              <div style={{ position: 'relative', display: 'inline-block', maxWidth: '100%', marginTop: 8 }}>
                <img src={photoUrl} alt="Фото бирки" style={{ display: 'block', maxWidth: '100%', height: 'auto' }} />
                <div style={{ position: 'absolute', inset: 0 }}>
                  {lines.map((line, index) => {
                    const box = normalizeBox(line.box, imageWidth, imageHeight);
                    if (!box) return null;
                    const rule = rules[index] ?? { field: 'ignore' as OcrFieldCode, anchor: null };
                    const isActive = activeIndex === index;
                    const isIgnored = rule.field === 'ignore';
                    return (
                      <div
                        key={index}
                        role="button"
                        tabIndex={0}
                        onMouseEnter={() => setActiveIndex(index)}
                        onClick={() => {
                          setActiveIndex(index);
                          rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
                        }}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') {
                            setActiveIndex(index);
                            rowRefs.current[index]?.scrollIntoView({ block: 'nearest' });
                          }
                        }}
                        title={line.text}
                        style={{
                          position: 'absolute',
                          left: `${box.left * 100}%`,
                          top: `${box.top * 100}%`,
                          width: `${box.width * 100}%`,
                          height: `${box.height * 100}%`,
                          boxSizing: 'border-box',
                          border: isActive ? '2px solid #1677ff' : isIgnored ? '1px solid rgba(140,140,140,0.5)' : '1px solid #52c41a',
                          background: isActive ? 'rgba(22,119,255,0.12)' : 'transparent',
                          cursor: 'pointer',
                        }}
                      >
                        <span
                          style={{
                            position: 'absolute',
                            top: -1,
                            left: -1,
                            transform: 'translateY(-100%)',
                            fontSize: 10,
                            lineHeight: '14px',
                            padding: '0 3px',
                            color: '#fff',
                            background: isActive ? '#1677ff' : isIgnored ? 'rgba(140,140,140,0.7)' : '#52c41a',
                            borderRadius: 2,
                          }}
                        >
                          {index + 1}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            <Alert
              type="info"
              showIcon
              style={{ marginTop: 8 }}
              message="Порядок правил = порядок распознанных строк (сверху вниз). Размечайте поля в том же порядке, в каком они распознаны на фото."
            />

            <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
              {lines.map((line, index) => {
                const rule = rules[index] ?? { field: 'ignore' as OcrFieldCode, anchor: null };
                const anchorEnabled = typeof rule.anchor === 'string';
                const isActive = activeIndex === index;
                return (
                  <div
                    key={index}
                    ref={(el) => {
                      rowRefs.current[index] = el;
                    }}
                    onMouseEnter={() => setActiveIndex(index)}
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      flexWrap: 'wrap',
                      padding: '6px 8px',
                      border: isActive ? '1px solid #1677ff' : '1px solid var(--app-border, #d9d9d9)',
                      borderRadius: 6,
                      background: isActive ? 'rgba(22,119,255,0.06)' : undefined,
                    }}
                  >
                    <Text code style={{ flex: '1 1 220px', wordBreak: 'break-word' }}>
                      {line.text}
                    </Text>
                    <Select<OcrFieldCode>
                      value={rule.field}
                      disabled={!canManage}
                      options={FIELD_OPTIONS}
                      style={{ width: 180 }}
                      onChange={(field) => updateRule(index, { field })}
                    />
                    <Checkbox
                      checked={anchorEnabled}
                      disabled={!canManage}
                      onChange={(e) => {
                        if (e.target.checked) {
                          updateRule(index, { anchor: suggestAnchor(line.text) });
                        } else {
                          updateRule(index, { anchor: null });
                        }
                      }}
                    >
                      Якорь
                    </Checkbox>
                    {anchorEnabled && (
                      <Input
                        value={rule.anchor ?? ''}
                        disabled={!canManage}
                        style={{ width: 140 }}
                        onChange={(e) => updateRule(index, { anchor: e.target.value })}
                      />
                    )}
                  </div>
                );
              })}
            </Space>
          </div>
        )}

        {validationMessage && <Alert type="warning" showIcon message={validationMessage} />}

        <Divider style={{ margin: '4px 0' }} />

        <div>
          <Text strong>Проверить на фото</Text>
          <div style={{ marginTop: 8 }}>
            <Upload
              accept="image/*"
              showUploadList={false}
              disabled={!canManage || lines.length === 0 || testing}
              beforeUpload={(file) => {
                void handleTest(file as File);
                return false;
              }}
            >
              <Button icon={<UploadOutlined />} loading={testing} disabled={!canManage || lines.length === 0}>
                Загрузить фото для теста
              </Button>
            </Upload>
          </div>
          {testError && <Alert type="error" showIcon message={testError} style={{ marginTop: 8 }} />}

          {testResult && (
            <Space direction="vertical" size={8} style={{ width: '100%', marginTop: 8 }}>
              <Space>
                <Tag color={testResult.matched.templateWon ? 'green' : 'orange'}>
                  {testResult.matched.templateWon ? 'Шаблон победил' : 'Fallback'}
                </Tag>
                <Text type="secondary">score: {testResult.matched.score}</Text>
              </Space>
              <FieldsComparisonTable fields={testResult.matched.fields} fallbackFields={testResult.fallbackFields} />
            </Space>
          )}
        </div>
      </Space>
    </Drawer>
  );
};

export default OcrTemplateEditor;
