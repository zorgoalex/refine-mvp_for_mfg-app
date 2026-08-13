import { Tooltip } from '../ui/tooltipDelay';
import React, { useEffect, useState } from 'react';
import { Select } from 'antd';
import {
  exportTemplatesApi,
  type ExportTemplateSource,
  type ExportTemplateTarget,
} from '../api/exportTemplatesApi';

export const ExportTemplateSelect: React.FC<{
  targetScreen: ExportTemplateTarget;
  sourceType: ExportTemplateSource;
  value?: number;
  disabled?: boolean;
  onChange: (templateId: number) => void;
  onReadyChange?: (ready: boolean) => void;
}> = ({ targetScreen, sourceType, value, disabled, onChange, onReadyChange }) => {
  const [options, setOptions] = useState<Array<{ value: number; label: string }>>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true); setError(null); onReadyChange?.(false);
    void exportTemplatesApi.available(targetScreen, sourceType).then((templates) => {
      if (cancelled) return;
      const next = templates.map((template) => ({ value: template.exportTemplateId, label: `${template.name}${template.isDefault ? ' · по умолчанию' : ''}` }));
      setOptions(next);
      const selected = templates.find((template) => template.exportTemplateId === value)
        ?? templates.find((template) => template.isDefault) ?? templates[0];
      if (!selected) {
        setError('Нет активного шаблона'); onReadyChange?.(false); return;
      }
      if (selected.exportTemplateId !== value) onChange(selected.exportTemplateId);
      onReadyChange?.(true);
    }).catch((loadError) => {
      if (cancelled) return;
      setError(loadError instanceof Error ? loadError.message : 'Не удалось загрузить шаблоны');
      onReadyChange?.(false);
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [targetScreen, sourceType]);

  return <Tooltip title={error ?? 'Шаблон определяет колонки и формулы XLS'}>
    <Select aria-label="Шаблон экспорта" value={value} options={options} loading={loading} status={error ? 'error' : undefined}
      disabled={disabled || loading || Boolean(error)} placeholder={error ? 'Шаблоны недоступны' : 'Шаблон экспорта'}
      style={{ minWidth: 260 }} onChange={onChange} />
  </Tooltip>;
};
