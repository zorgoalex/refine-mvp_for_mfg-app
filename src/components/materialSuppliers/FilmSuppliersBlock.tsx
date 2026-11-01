import { useGetIdentity } from '@refinedev/core';
import { Alert, Button, Space, Tag, Typography, message } from 'antd';
import { useCallback, useEffect, useState } from 'react';
import { isApiError } from '../../api/apiError';
import { materialSuppliersApi, type FilmSuppliersDto } from '../../api/materialSuppliersApi';
import { SuppliersSelect } from './SuppliersSelect';

/**
 * Поставщики плёнки — отдельный блок карточки со своей кнопкой сохранения (своя команда backend, независимо от формы
 * плёнки): нет частичного сохранения «плёнка сохранилась, поставщики — нет». Править — с правом references.manage.
 */
export const FilmSuppliersBlock: React.FC<{ filmId?: number | null }> = ({ filmId }) => {
  const { data: identity } = useGetIdentity<{ permissions?: string[] }>();
  const canManage = (identity?.permissions ?? []).includes('references.manage');
  const [loaded, setLoaded] = useState<FilmSuppliersDto | null>(null);
  const [draft, setDraft] = useState<number[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    if (!filmId) return;
    try {
      const [item] = await materialSuppliersApi.films([filmId]);
      const next = item ?? { filmId, suppliers: [], onecSuppliers: [] };
      setLoaded(next);
      setDraft(next.suppliers.map((s) => s.id));
      setError(null);
    } catch {
      setLoaded(null);
      setError('Не удалось загрузить поставщиков плёнки');
    }
  }, [filmId]);

  useEffect(() => { void load(); }, [load]);

  const saved = loaded?.suppliers.map((s) => s.id) ?? [];
  const changed = draft.length !== saved.length || draft.some((id, index) => id !== saved[index]);

  const save = async () => {
    if (!filmId || !loaded) return;
    setSaving(true);
    try {
      const next = await materialSuppliersApi.replaceFilm(filmId, draft, saved);
      setLoaded(next);
      setDraft(next.suppliers.map((s) => s.id));
      void message.success('Поставщики плёнки сохранены');
    } catch (cause) {
      if (isApiError(cause, 'FILM_SUPPLIERS_STALE')) {
        void message.warning('Поставщиков плёнки уже изменили — показан актуальный список');
        await load();
      } else {
        void message.error(isApiError(cause) ? cause.message : 'Не удалось сохранить поставщиков');
      }
    } finally {
      setSaving(false);
    }
  };

  if (!filmId) return null;
  return (
    <div data-testid="film-suppliers-block">
      <Typography.Title level={5}>Поставщики</Typography.Title>
      {error && <Alert type="warning" showIcon message={error} style={{ marginBottom: 8 }} />}
      {loaded && (canManage ? (
        <Space direction="vertical" style={{ width: '100%' }}>
          <SuppliersSelect value={draft} onChange={setDraft} disabled={saving} />
          <Space>
            <Button type="primary" onClick={() => void save()} loading={saving} disabled={!changed}>Сохранить поставщиков</Button>
            {changed && <Button onClick={() => setDraft(saved)} disabled={saving}>Отменить</Button>}
          </Space>
        </Space>
      ) : (
        <Space wrap>
          {loaded.suppliers.length === 0
            ? <Typography.Text type="secondary">Не указаны</Typography.Text>
            : loaded.suppliers.map((s, index) => <Tag key={s.id} color={index === 0 ? 'blue' : undefined}>{s.name}{s.isActive ? '' : ' (отключён)'}</Tag>)}
        </Space>
      ))}
      {loaded && loaded.onecSuppliers.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <Typography.Text type="secondary">По приходам 1С: </Typography.Text>
          <Space wrap size={4}>{loaded.onecSuppliers.map((s) => <Tag key={s.key}>{s.name}</Tag>)}</Space>
        </div>
      )}
    </div>
  );
};
