import { Table, Tooltip } from '../../../ui/tooltipDelay';
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Button, Card, Col, Input, InputNumber, Row, Segmented, Slider, Space, Switch, Tag, Typography, message } from 'antd';
import {
  CheckCircleOutlined,
  CopyOutlined,
  FileImageOutlined,
  PlusOutlined,
  ReloadOutlined,
  SaveOutlined,
} from '@ant-design/icons';
import {
  CUT_RENDER_STYLES_SETTING_KEY,
  CUT_RENDER_STYLE_DEFAULT,
  CUT_RENDER_STYLE_MDF_BOARD_PREVIEW,
  CutRenderStyleValidationError,
  DEFAULT_CUT_RENDER_STYLES_SETTING,
  cutRenderStyleProfileJson,
  parseCutRenderStylesSetting,
  type CutRenderStyleProfile,
  type CutRenderStyleTemplate,
  type CutRenderStylesSetting,
} from '@shared/cut-render-style';
import { cutConfigApi, type CutConfig, type CutSettingRow } from '../../../api/cutConfigApi';
import { ApiError } from '../../../api/httpClient';
import { buildStyledSvgUploadPreview } from '../../cut/svgCutRenderPreview';
import { parseSvgCutUploadFile, type ParsedSvgUpload } from '../../cut/svgCutUploadParser';
import {
  findCutRenderStylesSetting,
  readCutRenderStylesSetting,
} from './cutConfigHelpers';

const { Text, Title } = Typography;

interface CutRenderStylesFormProps {
  config: CutConfig;
  canManage: boolean;
  onSaved: (setting: CutSettingRow) => Promise<void> | void;
}

interface TemplateDraft {
  id: string;
  name: string;
  active: boolean;
  profile: CutRenderStyleProfile;
}

const SOURCE_STROKE_MODE_OPTIONS = [
  { value: 'piece-pastel', label: 'Цвет детали' },
  { value: 'fixed', label: 'Фиксированный' },
  { value: 'preserve', label: 'Как в SVG' },
] as const;

const LABEL_FILL_OPTIONS = [
  { value: 'contrast', label: 'Контраст' },
  { value: 'fixed', label: 'Фиксированный' },
] as const;

export const CutRenderStylesForm: React.FC<CutRenderStylesFormProps> = ({
  config,
  canManage,
  onSaved,
}) => {
  const settingRow = useMemo(() => findCutRenderStylesSetting(config.settings), [config.settings]);
  const resolvedSetting = useMemo(() => readCutRenderStylesSetting(config.settings), [config.settings]);
  const [selectedTemplateId, setSelectedTemplateId] = useState(resolvedSetting.defaultProfileId);
  const [draft, setDraft] = useState<TemplateDraft>(() => templateToDraft(templateById(resolvedSetting, resolvedSetting.defaultProfileId)));
  const [saving, setSaving] = useState(false);
  const [previewParsed, setPreviewParsed] = useState<ParsedSvgUpload>(() => samplePreviewUpload());
  const [previewName, setPreviewName] = useState('Тестовый SVG');
  const [previewError, setPreviewError] = useState<string | null>(null);

  const selectedTemplate = useMemo(
    () => templateById(resolvedSetting, selectedTemplateId),
    [resolvedSetting, selectedTemplateId],
  );

  useEffect(() => {
    const exists = resolvedSetting.templates.some((template) => template.id === selectedTemplateId);
    if (!exists) {
      setSelectedTemplateId(resolvedSetting.defaultProfileId);
    }
  }, [resolvedSetting, selectedTemplateId]);

  useEffect(() => {
    setDraft(templateToDraft(selectedTemplate));
  }, [selectedTemplate]);

  const previewSetting = useMemo(() => {
    try {
      return buildSettingWithDraft(resolvedSetting, draft, selectedTemplateId, selectedTemplateId);
    } catch {
      return resolvedSetting;
    }
  }, [draft, resolvedSetting, selectedTemplateId]);

  const previewSvg = useMemo(
    () => buildStyledSvgUploadPreview(previewParsed, previewSetting),
    [previewParsed, previewSetting],
  );
  const previewUrl = useObjectUrl(previewSvg);

  const persist = useCallback(async (nextSetting: CutRenderStylesSetting, nextSelectedId: string) => {
    if (!settingRow) {
      message.error(`Настройка ${CUT_RENDER_STYLES_SETTING_KEY} не создана миграцией`);
      return;
    }
    setSaving(true);
    try {
      const savedSetting = await cutConfigApi.updateSetting(CUT_RENDER_STYLES_SETTING_KEY, nextSetting, settingRow.version);
      await onSaved(savedSetting);
      setSelectedTemplateId(nextSelectedId);
      message.success('Настройки рендера сохранены');
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить настройки рендера');
    } finally {
      setSaving(false);
    }
  }, [onSaved, settingRow]);

  const saveCurrent = useCallback(() => {
    try {
      const nextSetting = buildSettingWithDraft(resolvedSetting, draft, selectedTemplateId, resolvedSetting.defaultProfileId);
      void persist(nextSetting, selectedTemplateId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [draft, persist, resolvedSetting, selectedTemplateId]);

  const saveAsCopy = useCallback(() => {
    try {
      const copyId = nextTemplateId(resolvedSetting.templates, `${draft.id}-copy`);
      const copyName = copyNameFor(draft.name);
      const copyDraft: TemplateDraft = {
        ...draft,
        id: copyId,
        name: copyName,
        active: true,
        profile: cloneProfile(draft.profile),
      };
      const templates = [...resolvedSetting.templates.map(cloneTemplate), draftToTemplate(copyDraft)];
      const nextSetting = buildSetting(resolvedSetting, templates, resolvedSetting.defaultProfileId);
      void persist(nextSetting, copyId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [draft, persist, resolvedSetting]);

  const saveCurrentAsDefault = useCallback(() => {
    try {
      const nextSetting = buildSettingWithDraft(resolvedSetting, draft, selectedTemplateId, selectedTemplateId);
      void persist(nextSetting, selectedTemplateId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [draft, persist, resolvedSetting, selectedTemplateId]);

  const copyStoredTemplate = useCallback((template: CutRenderStyleTemplate) => {
    try {
      const copyId = nextTemplateId(resolvedSetting.templates, `${template.id}-copy`);
      const nextTemplate: CutRenderStyleTemplate = {
        id: copyId,
        name: copyNameFor(template.name),
        active: true,
        profile: cloneProfile(template.profile),
      };
      const nextSetting = buildSetting(
        resolvedSetting,
        [...resolvedSetting.templates.map(cloneTemplate), nextTemplate],
        resolvedSetting.defaultProfileId,
      );
      void persist(nextSetting, copyId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [persist, resolvedSetting]);

  const setDefaultTemplate = useCallback((templateId: string) => {
    try {
      const templates = resolvedSetting.templates.map((template) => ({
        ...cloneTemplate(template),
        active: template.id === templateId ? true : template.active,
      }));
      const nextSetting = buildSetting(resolvedSetting, templates, templateId);
      void persist(nextSetting, templateId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [persist, resolvedSetting]);

  const setTemplateActive = useCallback((templateId: string, active: boolean) => {
    if (!active && templateId === resolvedSetting.defaultProfileId) {
      message.warning('Действующий по умолчанию шаблон нельзя деактивировать');
      return;
    }
    try {
      const templates = resolvedSetting.templates.map((template) => (
        template.id === templateId ? { ...cloneTemplate(template), active } : cloneTemplate(template)
      ));
      const nextSetting = buildSetting(resolvedSetting, templates, resolvedSetting.defaultProfileId);
      void persist(nextSetting, selectedTemplateId);
    } catch (error) {
      showRenderStyleError(error);
    }
  }, [persist, resolvedSetting, selectedTemplateId]);

  const updateProfile = useCallback((updater: (profile: CutRenderStyleProfile) => CutRenderStyleProfile) => {
    setDraft((current) => ({
      ...current,
      profile: updater(cloneProfile(current.profile)),
    }));
  }, []);

  const updatePiece = useCallback((patch: Partial<CutRenderStyleProfile['piece']>) => {
    updateProfile((profile) => ({ ...profile, piece: { ...profile.piece, ...patch } }));
  }, [updateProfile]);

  const updateLabel = useCallback((patch: Partial<CutRenderStyleProfile['label']>) => {
    updateProfile((profile) => ({ ...profile, label: { ...profile.label, ...patch } }));
  }, [updateProfile]);

  const updateSourceSvg = useCallback((patch: Partial<CutRenderStyleProfile['sourceSvg']>) => {
    updateProfile((profile) => ({ ...profile, sourceSvg: { ...profile.sourceSvg, ...patch } }));
  }, [updateProfile]);

  const updateRawSvg = useCallback((patch: Partial<CutRenderStyleProfile['rawSvgScreenshot']>) => {
    updateProfile((profile) => ({ ...profile, rawSvgScreenshot: { ...profile.rawSvgScreenshot, ...patch } }));
  }, [updateProfile]);

  const handlePreviewFile = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;
    setPreviewError(null);
    try {
      const parsed = await parseSvgCutUploadFile(file, {
        allowGeometryFallbackItems: true,
        includeVisualLabelOnlyItems: true,
      });
      if (parsed.cutLayout.items.length === 0) {
        setPreviewError(parsed.cutLayout.reasons.join('; ') || 'В SVG нет деталей для предпросмотра');
        return;
      }
      setPreviewParsed(parsed);
      setPreviewName(file.name);
      if (parsed.cutLayout.status !== 'valid') {
        setPreviewError(parsed.cutLayout.reasons.join('; ') || 'SVG принят только для предпросмотра');
      }
    } catch (error) {
      setPreviewError(error instanceof Error ? error.message : 'Не удалось прочитать SVG');
    }
  }, []);

  return (
    <Space direction="vertical" size="middle" style={{ width: '100%' }}>
      {!settingRow && (
        <Alert
          type="warning"
          showIcon
          message={`В базе нет строки ${CUT_RENDER_STYLES_SETTING_KEY}`}
          description="После применения миграций настройку можно будет сохранять. Сейчас показан встроенный fallback."
        />
      )}
      <Alert
        type="info"
        showIcon
        message="Эти правила используются для MDF-превью, карточек файлов станка и Telegram-скринов SVG-раскроя."
      />

      <Card
        size="small"
        title="Шаблоны правил рендера"
        extra={settingRow ? <Tag>version {settingRow.version}</Tag> : <Tag color="warning">fallback</Tag>}
      >
        <Table<CutRenderStyleTemplate>
          size="small"
          rowKey="id"
          pagination={false}
          dataSource={resolvedSetting.templates}
          rowClassName={(template) => template.id === selectedTemplateId ? 'cut-render-template-row-selected' : ''}
          columns={[
            {
              title: 'Название',
              key: 'name',
              render: (_, template) => (
                <Space size={6} wrap>
                  <Button type="link" className="cut-render-template-link" onClick={() => setSelectedTemplateId(template.id)}>
                    {template.name}
                  </Button>
                  {template.id === resolvedSetting.defaultProfileId && <Tag color="blue">по умолчанию</Tag>}
                </Space>
              ),
            },
            {
              title: 'Статус',
              key: 'active',
              width: 120,
              render: (_, template) => template.active ? <Tag color="green">активен</Tag> : <Tag>выключен</Tag>,
            },
            {
              title: 'Действия',
              key: 'actions',
              width: 420,
              render: (_, template) => (
                <Space wrap>
                  <Button size="small" onClick={() => setSelectedTemplateId(template.id)}>
                    Редактировать
                  </Button>
                  <Tooltip title="Сохранить копию этого шаблона">
                    <Button
                      size="small"
                      icon={<CopyOutlined />}
                      disabled={!canManage || !settingRow}
                      onClick={() => copyStoredTemplate(template)}
                    >
                      Копия
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    icon={<CheckCircleOutlined />}
                    disabled={!canManage || !settingRow || template.id === resolvedSetting.defaultProfileId}
                    onClick={() => setDefaultTemplate(template.id)}
                  >
                    По умолчанию
                  </Button>
                  <Button
                    size="small"
                    disabled={!canManage || !settingRow}
                    onClick={() => setTemplateActive(template.id, !template.active)}
                  >
                    {template.active ? 'Деактивировать' : 'Активировать'}
                  </Button>
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Row gutter={[16, 16]} align="top">
        <Col xs={24} xl={14}>
          <Card
            size="small"
            title="Редактор шаблона"
            extra={<Tag>{draft.id}</Tag>}
          >
            <Space direction="vertical" size="large" style={{ width: '100%' }}>
              <Row gutter={[12, 12]}>
                <Col xs={24} md={16}>
                  <Text className="cut-render-field-label">Название шаблона</Text>
                  <Input
                    value={draft.name}
                    disabled={!canManage}
                    maxLength={80}
                    onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))}
                  />
                </Col>
                <Col xs={24} md={8}>
                  <Text className="cut-render-field-label">Активен</Text>
                  <div className="cut-render-switch-line">
                    <Switch
                      checked={draft.active}
                      disabled={!canManage || draft.id === resolvedSetting.defaultProfileId}
                      onChange={(active) => setDraft((current) => ({ ...current, active }))}
                    />
                    {draft.id === resolvedSetting.defaultProfileId && <Text type="secondary">шаблон по умолчанию</Text>}
                  </div>
                </Col>
              </Row>

              <div className="cut-render-form-section">
                <Title level={5}>Детали и заказы</Title>
                <Row gutter={[16, 12]}>
                  <Col xs={24} md={12}>
                    <ColorField label="Фон листа и деталей" value={draft.profile.piece.defaultFill} disabled={!canManage} onChange={(value) => updatePiece({ defaultFill: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Контур детали" value={draft.profile.piece.stroke} disabled={!canManage} onChange={(value) => updatePiece({ stroke: value })} />
                  </Col>
                  <Col xs={24}>
                    <NumberSlider label="Толщина контура детали, мм" value={draft.profile.piece.strokeWidthMm} min={0.1} max={20} step={0.1} disabled={!canManage} onChange={(value) => updatePiece({ strokeWidthMm: value })} />
                  </Col>
                  <Col xs={24}>
                    <PaletteEditor
                      value={draft.profile.piece.orderPalette}
                      disabled={!canManage}
                      onChange={(orderPalette) => updatePiece({ orderPalette })}
                    />
                  </Col>
                </Row>
              </div>

              <div className="cut-render-form-section">
                <Title level={5}>Надписи</Title>
                <Row gutter={[16, 12]}>
                  <Col xs={24}>
                    <Text className="cut-render-field-label">Цвет надписей</Text>
                    <Segmented
                      value={draft.profile.label.fillStrategy}
                      options={LABEL_FILL_OPTIONS as unknown as Array<{ value: string; label: string }>}
                      disabled={!canManage}
                      onChange={(value) => updateLabel({ fillStrategy: value as CutRenderStyleProfile['label']['fillStrategy'] })}
                    />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Темный текст" value={draft.profile.label.darkFill} disabled={!canManage} onChange={(value) => updateLabel({ darkFill: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Светлый текст" value={draft.profile.label.lightFill} disabled={!canManage} onChange={(value) => updateLabel({ lightFill: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Обводка темного текста" value={draft.profile.label.darkTextStroke} disabled={!canManage} onChange={(value) => updateLabel({ darkTextStroke: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Обводка светлого текста" value={draft.profile.label.lightTextStroke} disabled={!canManage} onChange={(value) => updateLabel({ lightTextStroke: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Обводка темного текста" value={draft.profile.label.darkTextStrokeWidthRatio} min={0} max={0.25} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ darkTextStrokeWidthRatio: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Обводка светлого текста" value={draft.profile.label.lightTextStrokeWidthRatio} min={0} max={0.25} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ lightTextStrokeWidthRatio: value })} />
                  </Col>
                  <Col xs={24}>
                    <NumberSlider label="Жирность текста" value={draft.profile.label.fontWeight} min={100} max={1000} step={50} disabled={!canManage} onChange={(value) => updateLabel({ fontWeight: Math.round(value / 50) * 50 })} />
                  </Col>
                  <Col xs={24} md={8}>
                    <NumberSlider label="Размер строки 1: заказ" value={draft.profile.label.orderFontRatio} min={0.2} max={2.5} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ orderFontRatio: value })} />
                  </Col>
                  <Col xs={24} md={8}>
                    <NumberSlider label="Размер строки 2: позиция" value={draft.profile.label.positionFontRatio} min={0.2} max={2.5} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ positionFontRatio: value })} />
                  </Col>
                  <Col xs={24} md={8}>
                    <NumberSlider label="Размер строки 3: размеры" value={draft.profile.label.sizeFontRatio} min={0.2} max={2.5} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ sizeFontRatio: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Интервал заказ - позиция" value={draft.profile.label.orderPositionGapRatio} min={-0.3} max={1.5} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ orderPositionGapRatio: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Интервал позиция - размеры" value={draft.profile.label.positionSizeGapRatio} min={-0.3} max={1.5} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ positionSizeGapRatio: value })} />
                  </Col>
                  <Col xs={24}>
                    <NumberSlider label="Плотность букв" value={draft.profile.label.letterSpacingRatio} min={-0.2} max={0.4} step={0.01} disabled={!canManage} onChange={(value) => updateLabel({ letterSpacingRatio: value })} />
                  </Col>
                </Row>
              </div>

              <div className="cut-render-form-section">
                <Title level={5}>SVG-слои и фрезеровка</Title>
                <Row gutter={[16, 12]}>
                  <Col xs={24}>
                    <Text className="cut-render-field-label">Цвет линий SVG</Text>
                    <Segmented
                      value={draft.profile.sourceSvg.strokeColorMode}
                      options={SOURCE_STROKE_MODE_OPTIONS as unknown as Array<{ value: string; label: string }>}
                      disabled={!canManage}
                      onChange={(value) => updateSourceSvg({ strokeColorMode: value as CutRenderStyleProfile['sourceSvg']['strokeColorMode'] })}
                    />
                  </Col>
                  <Col xs={24} md={12}>
                    <ColorField label="Фиксированный цвет линий" value={draft.profile.sourceSvg.fixedStroke} disabled={!canManage} onChange={(value) => updateSourceSvg({ fixedStroke: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <Text className="cut-render-field-label">Не масштабировать толщину</Text>
                    <div className="cut-render-switch-line">
                      <Switch
                        checked={draft.profile.sourceSvg.nonScalingStroke}
                        disabled={!canManage}
                        onChange={(nonScalingStroke) => updateSourceSvg({ nonScalingStroke })}
                      />
                      <Text type="secondary">держит линии читаемыми при зуме</Text>
                    </div>
                  </Col>
                  <Col xs={24}>
                    <NullableNumberSlider
                      label="Минимальная толщина линий SVG, px"
                      value={draft.profile.sourceSvg.minStrokePx}
                      min={0.1}
                      max={20}
                      step={0.1}
                      nullLabel="Использовать исходную толщину"
                      disabled={!canManage}
                      onChange={(minStrokePx) => updateSourceSvg({ minStrokePx })}
                    />
                  </Col>
                  <Col xs={24}>
                    <NumberSlider label="Прозрачность линий SVG" value={draft.profile.sourceSvg.strokeOpacity} min={0.05} max={1} step={0.05} disabled={!canManage} onChange={(value) => updateSourceSvg({ strokeOpacity: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Насыщенность pastel, %" value={draft.profile.sourceSvg.pastelSaturationPercent} min={0} max={100} step={1} disabled={!canManage} onChange={(value) => updateSourceSvg({ pastelSaturationPercent: value })} />
                  </Col>
                  <Col xs={24} md={12}>
                    <NumberSlider label="Светлота pastel, %" value={draft.profile.sourceSvg.pastelLightnessPercent} min={0} max={100} step={1} disabled={!canManage} onChange={(value) => updateSourceSvg({ pastelLightnessPercent: value })} />
                  </Col>
                  <Col xs={24}>
                    <NumberSlider label="Fallback скрин: минимум линий, px" value={draft.profile.rawSvgScreenshot.minStrokePx} min={0.1} max={20} step={0.1} disabled={!canManage} onChange={(value) => updateRawSvg({ minStrokePx: value })} />
                  </Col>
                </Row>
              </div>

              <Space wrap>
                <Button
                  type="primary"
                  icon={<SaveOutlined />}
                  disabled={!canManage || !settingRow}
                  loading={saving}
                  onClick={saveCurrent}
                >
                  Сохранить в текущий
                </Button>
                <Button
                  icon={<CopyOutlined />}
                  disabled={!canManage || !settingRow}
                  loading={saving}
                  onClick={saveAsCopy}
                >
                  Сохранить как копию
                </Button>
                <Button
                  icon={<CheckCircleOutlined />}
                  disabled={!canManage || !settingRow || draft.id === resolvedSetting.defaultProfileId}
                  loading={saving}
                  onClick={saveCurrentAsDefault}
                >
                  Сделать по умолчанию
                </Button>
                <Button
                  icon={<ReloadOutlined />}
                  disabled={!canManage}
                  onClick={() => setDraft(templateToDraft(selectedTemplate))}
                >
                  Сбросить изменения
                </Button>
                <Button
                  icon={<PlusOutlined />}
                  disabled={!canManage}
                  onClick={() => setDraft((current) => ({
                    ...current,
                    name: 'MDF-превью',
                    active: true,
                    profile: cloneProfile(DEFAULT_CUT_RENDER_STYLES_SETTING.profiles[CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]),
                  }))}
                >
                  Встроенный профиль
                </Button>
              </Space>
            </Space>
          </Card>
        </Col>

        <Col xs={24} xl={10}>
          <Card size="small" title="Предпросмотр SVG" extra={<Tag>{previewName}</Tag>}>
            <Space direction="vertical" size="middle" style={{ width: '100%' }}>
              <label className={`cut-render-upload${canManage ? '' : ' is-disabled'}`}>
                <FileImageOutlined />
                <span>Загрузить тестовый SVG</span>
                <input
                  type="file"
                  accept=".svg,image/svg+xml"
                  disabled={!canManage}
                  onChange={(event) => void handlePreviewFile(event)}
                />
              </label>
              {previewError && <Alert type="warning" showIcon message={previewError} />}
              <div className="cut-render-preview-frame">
                {previewUrl ? <img src={previewUrl} alt="Предпросмотр правил рендера" /> : <Text type="secondary">Нет SVG для предпросмотра</Text>}
              </div>
              <RenderStyleSummary profile={draft.profile} />
            </Space>
          </Card>
        </Col>
      </Row>
    </Space>
  );
};

function ColorField({
  label,
  value,
  disabled,
  onChange,
}: {
  label: string;
  value: string;
  disabled?: boolean;
  onChange: (value: string) => void;
}) {
  return (
    <div className="cut-render-color-field">
      <Text className="cut-render-field-label">{label}</Text>
      <div className="cut-render-color-control">
        <input
          type="color"
          value={isHexColor(value) ? value : '#000000'}
          disabled={disabled}
          aria-label={label}
          onChange={(event) => onChange(event.target.value)}
        />
        <Input
          value={value}
          disabled={disabled}
          onChange={(event) => onChange(event.target.value)}
        />
      </div>
    </div>
  );
}

function NumberSlider({
  label,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  disabled?: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="cut-render-number-field">
      <div className="cut-render-number-header">
        <Text className="cut-render-field-label">{label}</Text>
        <Text className="cut-render-number-value">{value}</Text>
      </div>
      <div className="cut-render-number-control">
        <Slider
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(next) => onChange(Array.isArray(next) ? next[0] ?? value : next)}
        />
        <InputNumber
          min={min}
          max={max}
          step={step}
          value={value}
          disabled={disabled}
          onChange={(next) => {
            if (typeof next === 'number' && Number.isFinite(next)) onChange(next);
          }}
        />
      </div>
    </div>
  );
}

function NullableNumberSlider({
  label,
  value,
  min,
  max,
  step,
  nullLabel,
  disabled,
  onChange,
}: {
  label: string;
  value: number | null;
  min: number;
  max: number;
  step: number;
  nullLabel: string;
  disabled?: boolean;
  onChange: (value: number | null) => void;
}) {
  const enabled = value !== null;
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div className="cut-render-switch-line">
        <Switch
          checked={!enabled}
          disabled={disabled}
          onChange={(checked) => onChange(checked ? null : min)}
        />
        <Text>{nullLabel}</Text>
      </div>
      {enabled && (
        <NumberSlider
          label={label}
          value={value}
          min={min}
          max={max}
          step={step}
          disabled={disabled}
          onChange={onChange}
        />
      )}
    </Space>
  );
}

function PaletteEditor({
  value,
  disabled,
  onChange,
}: {
  value: readonly string[];
  disabled?: boolean;
  onChange: (value: string[]) => void;
}) {
  const colors = [...value];
  return (
    <Space direction="vertical" size={8} style={{ width: '100%' }}>
      <div className="cut-render-number-header">
        <Text className="cut-render-field-label">Палитра контуров заказов</Text>
        <Button
          size="small"
          icon={<PlusOutlined />}
          disabled={disabled || colors.length >= 24}
          onClick={() => onChange([...colors, '#d7e9ff'])}
        >
          Цвет
        </Button>
      </div>
      <div className="cut-render-palette-grid">
        {colors.map((color, index) => (
          <div className="cut-render-palette-item" key={`${index}-${color}`}>
            <ColorField
              label={`Заказ ${index + 1}`}
              value={color}
              disabled={disabled}
              onChange={(next) => onChange(colors.map((item, itemIndex) => itemIndex === index ? next : item))}
            />
            <Button
              size="small"
              disabled={disabled || colors.length <= 1}
              onClick={() => onChange(colors.filter((_item, itemIndex) => itemIndex !== index))}
            >
              Убрать
            </Button>
          </div>
        ))}
      </div>
    </Space>
  );
}

function RenderStyleSummary({ profile }: { profile: CutRenderStyleProfile }) {
  return (
    <div className="cut-render-summary">
      <Space direction="vertical" size={4}>
        <Text strong>MDF-превью</Text>
        <Text type="secondary">Контур: {profile.piece.stroke}, {profile.piece.strokeWidthMm} мм</Text>
        <Text type="secondary">Фрезеровка: {profile.sourceSvg.strokeColorMode}, минимум {profile.sourceSvg.minStrokePx ?? 'исходная'} px</Text>
        <Text type="secondary">
          Текст: {profile.label.fillStrategy === 'contrast' ? 'контрастный' : 'фиксированный'}, weight {profile.label.fontWeight}, строки {profile.label.orderFontRatio}/{profile.label.positionFontRatio}/{profile.label.sizeFontRatio}
        </Text>
      </Space>
    </div>
  );
}

function useObjectUrl(svg: string | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!svg || typeof URL === 'undefined' || typeof URL.createObjectURL !== 'function') {
      setUrl(null);
      return undefined;
    }
    const nextUrl = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [svg]);
  return url;
}

function templateById(setting: CutRenderStylesSetting, id: string): CutRenderStyleTemplate {
  return setting.templates.find((template) => template.id === id)
    ?? setting.templates.find((template) => template.id === setting.defaultProfileId)
    ?? setting.templates[0]
    ?? DEFAULT_CUT_RENDER_STYLES_SETTING.templates[0];
}

function templateToDraft(template: CutRenderStyleTemplate): TemplateDraft {
  return {
    id: template.id,
    name: template.name,
    active: template.active,
    profile: cloneProfile(template.profile),
  };
}

function draftToTemplate(draft: TemplateDraft): CutRenderStyleTemplate {
  return {
    id: draft.id,
    name: draft.name,
    active: draft.active,
    profile: cloneProfile(draft.profile),
  };
}

function cloneTemplate(template: CutRenderStyleTemplate): CutRenderStyleTemplate {
  return {
    id: template.id,
    name: template.name,
    active: template.active,
    profile: cloneProfile(template.profile),
  };
}

function cloneProfile(profile: CutRenderStyleProfile): CutRenderStyleProfile {
  return cutRenderStyleProfileJson(profile);
}

function buildSettingWithDraft(
  current: CutRenderStylesSetting,
  draft: TemplateDraft,
  selectedTemplateId: string,
  defaultProfileId: string,
): CutRenderStylesSetting {
  const templates = current.templates.map((template) => (
    template.id === selectedTemplateId ? draftToTemplate(draft) : cloneTemplate(template)
  ));
  return buildSetting(current, templates, defaultProfileId);
}

function buildSetting(
  current: CutRenderStylesSetting,
  templates: CutRenderStyleTemplate[],
  defaultProfileId: string,
): CutRenderStylesSetting {
  let nextTemplates = templates.map(cloneTemplate);
  let nextDefaultId = defaultProfileId;
  if (!nextTemplates.some((template) => template.id === nextDefaultId)) {
    nextDefaultId = nextTemplates.find((template) => template.active)?.id ?? nextTemplates[0]?.id ?? CUT_RENDER_STYLE_MDF_BOARD_PREVIEW;
  }
  nextTemplates = nextTemplates.map((template) => ({
    ...template,
    name: template.name.trim() || 'MDF-превью',
    active: template.id === nextDefaultId ? true : template.active,
  }));
  const defaultTemplate = nextTemplates.find((template) => template.id === nextDefaultId) ?? nextTemplates[0];
  return parseCutRenderStylesSetting({
    version: 1,
    defaultProfileId: nextDefaultId,
    profiles: {
      [CUT_RENDER_STYLE_DEFAULT]: cloneProfile(current.profiles[CUT_RENDER_STYLE_DEFAULT]),
      [CUT_RENDER_STYLE_MDF_BOARD_PREVIEW]: cloneProfile(defaultTemplate.profile),
    },
    templates: nextTemplates,
  });
}

function nextTemplateId(templates: readonly CutRenderStyleTemplate[], seed: string): string {
  const ids = new Set(templates.map((template) => template.id));
  const base = slugifyTemplateId(seed) || 'render-style';
  for (let index = 1; index < 1000; index += 1) {
    const id = `${base}-${index}`.slice(0, 64).replace(/[-_]+$/g, '');
    if (!ids.has(id) && /^[a-z0-9][a-z0-9_-]{1,63}$/.test(id)) return id;
  }
  return `render-${Date.now().toString(36)}`;
}

function slugifyTemplateId(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/[-_]{2,}/g, '-')
    .replace(/^[-_]+|[-_]+$/g, '')
    .slice(0, 48);
}

function copyNameFor(name: string): string {
  const trimmed = name.trim() || 'MDF-превью';
  return trimmed.endsWith('копия') ? trimmed : `${trimmed} копия`;
}

function isHexColor(value: string): boolean {
  return /^#[0-9a-f]{6}$/i.test(value);
}

function showRenderStyleError(error: unknown): void {
  if (error instanceof CutRenderStyleValidationError) {
    message.error(error.message);
    return;
  }
  message.error(error instanceof Error ? error.message : 'Настройки рендера некорректны');
}

function samplePreviewUpload(): ParsedSvgUpload {
  return {
    fileName: 'preview.svg',
    svgContentHash: 'preview',
    items: [],
    cutLayout: {
      status: 'valid',
      reasons: [],
      sheet: { widthMm: 1200, heightMm: 800 },
      rawCommentCount: 3,
      partContourCount: 3,
      acceptedItemCount: 3,
      items: [
        {
          orderName: '2723',
          detailNumber: 1,
          widthMm: 420,
          heightMm: 250,
          quantity: 1,
          xMm: 40,
          yMm: 50,
          placedWidthMm: 420,
          placedHeightMm: 250,
          rotated: false,
          sourceSvg: {
            viewBox: { xMm: 0, yMm: 0, widthMm: 420, heightMm: 250 },
            body: '<path d="M20 30 L400 220 M40 210 C120 80 300 80 380 210" stroke="#333333" stroke-width="0.5" fill="none"/>',
          },
          visualLabel: { rawLines: ['2723', '# 01', '420*250'] },
        },
        {
          orderName: '2724',
          detailNumber: 8,
          widthMm: 320,
          heightMm: 300,
          quantity: 1,
          xMm: 500,
          yMm: 50,
          placedWidthMm: 320,
          placedHeightMm: 300,
          rotated: false,
          sourceSvg: {
            viewBox: { xMm: 0, yMm: 0, widthMm: 320, heightMm: 300 },
            body: '<circle cx="160" cy="150" r="86" stroke="#333333" stroke-width="0.5" fill="none"/><line x1="30" y1="30" x2="290" y2="270" stroke="#333333" stroke-width="0.5"/>',
          },
          visualLabel: { rawLines: ['2724', '# 08', '320*300'] },
        },
        {
          orderName: '2723',
          detailNumber: 12,
          widthMm: 260,
          heightMm: 430,
          quantity: 1,
          xMm: 860,
          yMm: 50,
          placedWidthMm: 260,
          placedHeightMm: 430,
          rotated: false,
          sourceSvg: {
            viewBox: { xMm: 0, yMm: 0, widthMm: 260, heightMm: 430 },
            body: '<rect x="40" y="60" width="180" height="300" rx="18" stroke="#333333" stroke-width="0.5" fill="none"/><line x1="40" y1="210" x2="220" y2="210" stroke="#333333" stroke-width="0.5"/>',
          },
          visualLabel: { rawLines: ['2723', '# 12', '260*430'] },
        },
      ],
    },
  };
}
