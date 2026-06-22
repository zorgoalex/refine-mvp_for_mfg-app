import React, { useCallback, useEffect, useState } from 'react';
import {
  Button,
  Card,
  Col,
  Form,
  InputNumber,
  Radio,
  Row,
  Segmented,
  Slider,
  Space,
  Switch,
  Typography,
  message,
} from 'antd';
import { cutConfigApi, type CutConfig } from '../../../api/cutConfigApi';
import { ApiError } from '../../../api/httpClient';
import {
  DEFAULT_PARAM_FORM,
  type FreecutLayoutMode,
  type FreecutObjective,
  type FreecutQuality,
  type ParamProfileForm,
  formToParams,
  paramsToForm,
} from './cutConfigHelpers';

const { Text } = Typography;

interface SliderMeta {
  label: string;
  extra: string;
  tooltip: string;
  min: number;
  max: number;
  step: number;
  unit: string;
}

const SLIDER_META: Record<'kerf_mm' | 'spacing_mm' | 'time_limit_ms' | 'restarts', SliderMeta> = {
  kerf_mm: {
    label: 'Пропил (kerf)',
    extra: 'Ширина реза пилой',
    tooltip: 'Толщина пропила пильного диска — на эту величину «съедается» материал между соседними деталями. Обычно 2–4 мм.',
    min: 0, max: 10, step: 0.5, unit: 'мм',
  },
  spacing_mm: {
    label: 'Зазор (spacing)',
    extra: 'Доп. отступ между деталями',
    tooltip: 'Технологический зазор между соседними деталями сверх пропила. Обычно 0–2 мм.',
    min: 0, max: 5, step: 0.5, unit: 'мм',
  },
  time_limit_ms: {
    label: 'Лимит времени',
    extra: 'Бюджет на расчёт раскроя',
    tooltip: 'Максимум времени работы оптимизатора на одну группу. Больше времени — потенциально плотнее раскрой, но дольше. Прод-дефолт 1200 мс.',
    min: 100, max: 6000, step: 100, unit: 'мс',
  },
  restarts: {
    label: 'Перезапуски',
    extra: 'Число попыток оптимизации',
    tooltip: 'Сколько раз оптимизатор стартует заново с разных начальных точек и берёт лучший результат. Больше — качественнее и дольше.',
    min: 1, max: 20, step: 1, unit: '',
  },
};

const TRIM_META: Record<'trim_left' | 'trim_right' | 'trim_top' | 'trim_bottom', { label: string; tooltip: string }> = {
  trim_left: { label: 'Слева', tooltip: 'Сколько мм обрезается с левого края листа перед раскроем (некондиционная кромка).' },
  trim_right: { label: 'Справа', tooltip: 'Сколько мм обрезается с правого края листа перед раскроем (некондиционная кромка).' },
  trim_top: { label: 'Сверху', tooltip: 'Сколько мм обрезается с верхнего края листа перед раскроем (некондиционная кромка).' },
  trim_bottom: { label: 'Снизу', tooltip: 'Сколько мм обрезается с нижнего края листа перед раскроем (некондиционная кромка).' },
};

interface Props {
  config: CutConfig;
  canManage: boolean;
  onSaved: () => void | Promise<void>;
}

export const CutDefaultSettingsCard: React.FC<Props> = ({ config, canManage, onSaved }) => {
  const [form, setForm] = useState<ParamProfileForm>(DEFAULT_PARAM_FORM);
  const [saving, setSaving] = useState(false);

  const defaultProfile = config.paramProfiles.find((p) => p.isDefault) ?? null;

  useEffect(() => {
    setForm(defaultProfile ? paramsToForm(defaultProfile.params) : DEFAULT_PARAM_FORM);
  }, [defaultProfile]);

  const setField = useCallback(<K extends keyof ParamProfileForm>(key: K, value: ParamProfileForm[K]) => {
    setForm((prev) => ({ ...prev, [key]: value }));
  }, []);

  const save = useCallback(async () => {
    setSaving(true);
    try {
      const input = {
        name: defaultProfile?.name ?? 'По умолчанию',
        params: formToParams(form),
        isDefault: true,
      };
      if (defaultProfile) {
        await cutConfigApi.updateParamProfile(defaultProfile.cutParamProfileId, input, defaultProfile.version);
      } else {
        await cutConfigApi.createParamProfile(input);
      }
      message.success('Настройки раскроя по умолчанию сохранены');
      await onSaved();
    } catch (error) {
      message.error(error instanceof ApiError ? error.message : 'Не удалось сохранить настройки');
    } finally {
      setSaving(false);
    }
  }, [defaultProfile, form, onSaved]);

  const sliderField = (key: 'kerf_mm' | 'spacing_mm' | 'time_limit_ms' | 'restarts') => {
    const m = SLIDER_META[key];
    const value = form[key] as number;
    return (
      <Form.Item label={m.label} tooltip={m.tooltip} extra={<Text type="secondary" style={{ fontSize: 12 }}>{m.extra}</Text>} style={{ marginBottom: 12 }}>
        <Row gutter={8} align="middle">
          <Col flex="auto">
            <Slider min={m.min} max={m.max} step={m.step} value={value} onChange={(v) => setField(key, Number(v) as never)} disabled={!canManage} />
          </Col>
          <Col flex="130px">
            <InputNumber
              min={m.min}
              max={m.max}
              step={m.step}
              value={value}
              onChange={(v) => setField(key, Number(v ?? 0) as never)}
              addonAfter={m.unit || undefined}
              disabled={!canManage}
              style={{ width: '100%' }}
            />
          </Col>
        </Row>
      </Form.Item>
    );
  };

  const trimField = (key: 'trim_left' | 'trim_right' | 'trim_top' | 'trim_bottom') => {
    const m = TRIM_META[key];
    return (
      <Form.Item label={m.label} tooltip={m.tooltip} style={{ marginBottom: 12 }}>
        <InputNumber min={0} max={50} step={1} value={form[key] as number} onChange={(v) => setField(key, Number(v ?? 0) as never)} disabled={!canManage} style={{ width: '100%' }} addonAfter="мм" />
      </Form.Item>
    );
  };

  return (
    <Card size="small" title="Настройки раскроя по умолчанию">
      <Form layout="vertical">
        <Row gutter={16}>
          <Col span={12}>{sliderField('kerf_mm')}</Col>
          <Col span={12}>{sliderField('spacing_mm')}</Col>
        </Row>

        <Text type="secondary" style={{ fontSize: 12 }}>Обрезка кромки листа (trim), мм</Text>
        <Row gutter={12}>
          <Col span={6}>{trimField('trim_left')}</Col>
          <Col span={6}>{trimField('trim_right')}</Col>
          <Col span={6}>{trimField('trim_top')}</Col>
          <Col span={6}>{trimField('trim_bottom')}</Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Качество"
              tooltip="Быстро — считает быстрее, упаковка чуть свободнее. Баланс — рекомендуемый компромисс. Качество — плотнее раскрой, дольше расчёт."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Скорость против плотности</Text>}
              style={{ marginBottom: 12 }}
            >
              <Segmented
                value={form.quality}
                onChange={(v) => setField('quality', v as FreecutQuality)}
                options={[
                  { value: 'fast', label: 'Быстро' },
                  { value: 'balanced', label: 'Баланс' },
                  { value: 'quality', label: 'Качество' },
                ]}
                disabled={!canManage}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Сжимать группы деталей"
              tooltip="Постобработка: сдвигает отдельно стоящие группы деталей к плотному кластеру, закрывая узкие коридоры — остаток листа цельнее. Может немного удлинить расчёт."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Подтягивать крайние группы к центру</Text>}
              style={{ marginBottom: 12 }}
            >
              <Switch checked={form.groupShift} onChange={(v) => setField('groupShift', v)} disabled={!canManage} />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={12}>
            <Form.Item
              label="Цель оптимизации"
              tooltip="Меньше отхода — плотнее упаковка, меньше обрезков. Меньше листов — задействовать как можно меньше листов (может вырасти отход)."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Что минимизировать</Text>}
              style={{ marginBottom: 12 }}
            >
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={form.objective}
                onChange={(e) => setField('objective', e.target.value as FreecutObjective)}
                disabled={!canManage}
                options={[
                  { value: 'min_waste', label: 'Меньше отхода' },
                  { value: 'min_sheets', label: 'Меньше листов' },
                ]}
              />
            </Form.Item>
          </Col>
          <Col span={12}>
            <Form.Item
              label="Тип раскладки"
              tooltip="Гильотинная — только сквозные резы от края до края (для форматно-раскроечного станка). Вложенная — произвольное размещение, плотнее, но требует другого оборудования."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Схема резов</Text>}
              style={{ marginBottom: 12 }}
            >
              <Radio.Group
                optionType="button"
                buttonStyle="solid"
                value={form.layout_mode}
                onChange={(e) => setField('layout_mode', e.target.value as FreecutLayoutMode)}
                disabled={!canManage}
                options={[
                  { value: 'guillotine', label: 'Гильотинная' },
                  { value: 'nested', label: 'Вложенная' },
                ]}
              />
            </Form.Item>
          </Col>
        </Row>

        <Row gutter={16}>
          <Col span={8}>{sliderField('time_limit_ms')}</Col>
          <Col span={8}>{sliderField('restarts')}</Col>
          <Col span={8}>
            <Form.Item
              label="Умные ретраи при таймауте"
              tooltip="Отключены — вернуть лучший результат в рамках лимита времени (стабильно ~1.5 с). Умные — дополнительные попытки при таймауте слайса (может удлинить расчёт до ~3 с)."
              extra={<Text type="secondary" style={{ fontSize: 12 }}>Поведение при нехватке времени</Text>}
              style={{ marginBottom: 12 }}
            >
              <Switch
                checked={form.retry_strategy === 'smart'}
                onChange={(v) => setField('retry_strategy', v ? 'smart' : 'disabled')}
                disabled={!canManage}
              />
            </Form.Item>
          </Col>
        </Row>

        <Space>
          <Button type="primary" loading={saving} disabled={!canManage} onClick={save}>
            Сохранить
          </Button>
          <Button disabled={!canManage} onClick={() => setForm(DEFAULT_PARAM_FORM)}>
            Сбросить к рекомендуемым
          </Button>
        </Space>
      </Form>
    </Card>
  );
};
