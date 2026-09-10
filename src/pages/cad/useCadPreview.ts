import { useEffect, useMemo, useRef, useState } from 'react';
import type { CadGroup, CadVariant } from '@shared/cad-workspace';
import type { CadJob, CadPreviewItem } from '@shared/cad-api';
import { cadApi } from '../../api/cadApi';
import type { CadDraft } from './cadAutosave';

export function previewKey(group: CadGroup, draft: CadDraft) {
  const part = draft.sources.find(s => s.id === group.sourceSnapshotId)?.parts.find(p => p.detailId === group.detailId);
  return JSON.stringify([group.id, group.sourceSnapshotId, part?.widthMm, part?.heightMm, part?.thicknessMm, part?.material, group.recipe]);
}
/** Serial bounded batches. Repositioning/quantity/camera never invalidate geometry. */
export function useCadPreview(base: CadVariant, draft: CadDraft, job: CadJob | null, active: boolean, visible: string[]) {
  const cache = useRef(new Map<string, CadPreviewItem>());
  const [epoch, setEpoch] = useState(0);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const flight = useRef(false), mounted = useRef(true);
  const latest = useRef({ base, draft, active, visible }); latest.current = { base, draft, active, visible };
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    for (const item of job?.items ?? []) {
      const group = base.groups.find(g => g.id === item.part_id);
      if (group && item.result && ['succeeded', 'failed'].includes(item.status) &&
          JSON.stringify(group.recipe) === JSON.stringify(item.result.input_recipe)) cache.current.set(previewKey(group, base), item);
    }
    setEpoch(e => e + 1);
  }, [job, base.id, base.sources]);
  const desired = draft.groups.filter(g => visible.includes(g.id));
  const signature = desired.map(g => previewKey(g, draft)).join('|');
  useEffect(() => {
    let cancelled = false;
    const timer = setTimeout(() => {
      if (flight.current || !active) return;
      flight.current = true; setPending(true);
      void (async () => {
        try {
          while (mounted.current && latest.current.active) {
            const target = latest.current;
            const groups = target.draft.groups.filter(g => target.visible.includes(g.id) && target.base.groups.some(b => b.id === g.id) && !cache.current.has(previewKey(g, target.draft))).slice(0, 20);
            if (!groups.length) break;
            const result = await cadApi.preview(target.base, groups);
            if (!mounted.current) break;
            for (const item of result.items) {
              const group = groups.find(g => g.id === item.part_id);
              if (group) cache.current.set(previewKey(group, target.draft), item);
            }
            if (!result.items.length) throw new Error('Пустой ответ предварительного просмотра');
            setEpoch(e => e + 1); setError(null);
          }
        } catch { if (mounted.current) setError('Предпросмотр недоступен. Сохранённые данные не потеряны.'); }
        finally { flight.current = false; if (mounted.current) { setPending(false); if (cancelled) setEpoch(e => e + 1); } }
      })();
    }, 200);
    return () => { cancelled = true; clearTimeout(timer); };
  }, [signature, base.id, base.version, active]);
  const items = useMemo(() => draft.groups.flatMap(g => {
    const item = cache.current.get(previewKey(g, draft)); return item ? [item] : [];
  }), [signature, draft, epoch]);
  const scene: CadJob = { id: base.id, status: 'running', total: draft.groups.length, completed: items.length, items, package_files: [] };
  return { scene, pending, error };
}
