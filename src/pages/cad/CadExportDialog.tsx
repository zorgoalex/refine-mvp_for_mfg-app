import React, { useEffect, useRef, useState } from 'react';
import { Alert, Button, Checkbox, Input, Modal, Space, Spin } from 'antd';
import { useQuery } from '@tanstack/react-query';
import type { CadVariant } from '@shared/cad-workspace';
import type { CadApprovalCommand, CadExportReview } from '@shared/cad-api';
import { cadApi } from '../../api/cadApi';
import { can } from '../../utils/permissions';

interface Props { open: boolean; flush: () => Promise<CadVariant>; onClose: () => void }
export function CadExportDialog({ open, flush, onClose }: Props) {
  const [target, setTarget] = useState<CadVariant | null>(null), [review, setReview] = useState<CadExportReview | null>(null);
  const [phase, setPhase] = useState<'saving' | 'rendering' | 'review' | 'packing' | 'ready' | 'error'>('saving');
  const [error, setError] = useState(''), [ack, setAck] = useState(false), [busy, setBusy] = useState(false);
  const [approval, setApproval] = useState<{ groupId: string; hash: string } | null>(null), [reason, setReason] = useState('');
  const [command, setCommand] = useState<CadApprovalCommand | null>(null);
  const packageKey = useRef(crypto.randomUUID()), approvalKey = useRef(crypto.randomUUID());
  const generation = useRef(0), isOpen = useRef(open); isOpen.current = open;
  const run = useQuery(['cad-export-run', target?.id, target?.version], () => cadApi.run(target!.id, target!.version), {
    enabled: open && Boolean(target), retry: false,
    refetchInterval: open && ['rendering', 'packing'].includes(phase) ? 1500 : false,
  });
  const receipt = useQuery(['cad-approval-command', command?.id], () => cadApi.approval(command!.id), {
    enabled: open && command?.status === 'pending', retry: false, refetchInterval: data => data?.status === 'pending' || !data ? 1500 : false,
  });
  const reviewTarget = async (v: CadVariant) => { const epoch = generation.current, value = await cadApi.preflight(v);
    if (!isOpen.current || epoch !== generation.current) return;
    setReview(value); setPhase('review'); setAck(false); packageKey.current = crypto.randomUUID(); };
  useEffect(() => {
    generation.current++;
    if (!open) return;
    let cancelled = false;
    setTarget(null); setReview(null); setError(''); setCommand(null); setApproval(null); setPhase('saving');
    void (async () => {
      try {
        const v = await flush(); if (cancelled) return;
        const current = await cadApi.run(v.id, v.version); if (cancelled) return;
        if (!current.run) await cadApi.render(v);
        if (cancelled) return; setTarget(v); setPhase('rendering');
      } catch (e) { if (!cancelled) { setError(e instanceof Error ? e.message : 'Не удалось подготовить файлы'); setPhase('error'); } }
    })();
    return () => { cancelled = true; };
  }, [open]);
  useEffect(() => {
    if (!open || !target) return;
    const epoch = generation.current;
    if (phase === 'rendering' && run.data?.run?.status === 'succeeded') {
      setPhase('saving');
      void cadApi.preflight(target).then(value => { if (isOpen.current && epoch === generation.current) { setReview(value); setPhase('review'); setAck(false); packageKey.current = crypto.randomUUID(); } })
        .catch(e => { if (isOpen.current && epoch === generation.current) { setError(e instanceof Error ? e.message : 'Не удалось проверить версию'); setPhase('error'); } });
    } else if (phase === 'rendering' && ['failed', 'partial'].includes(run.data?.run?.status ?? '')) {
      setError('Не все детали рассчитаны. Исправьте отмеченные детали; они не будут исключены из ZIP автоматически.'); setPhase('error');
    } else if (phase === 'packing' && run.data?.run?.packageId) setPhase('ready');
    else if (phase === 'packing' && run.data?.run?.lastError) { setError('Не удалось собрать ZIP. Проверьте одобрения и повторите.'); setPhase('error'); }
  }, [run.data, open, target, phase]);
  useEffect(() => {
    if (!receipt.data || receipt.data.status === 'pending' || !target) return;
    setCommand(receipt.data);
    if (receipt.data.status === 'succeeded') { setApproval(null); void reviewTarget(target).catch(() => setError('Одобрение сохранено. Повторите проверку сводки.')); }
    else setError('Одобрение не подтверждено. Проверьте права и повторите: ' + (receipt.data.lastError ?? 'ошибка связи'));
  }, [receipt.data]);
  const act = async (fn: () => Promise<void>) => { if (busy) return; setBusy(true); setError(''); try { await fn(); } catch (e) { setError(e instanceof Error ? e.message : 'Ошибка связи. Повторите действие.'); } finally { setBusy(false); } };
  const partLabel = (id: string) => { const g = target?.groups.find(g => g.id === id); const p = target?.sources.find(s => s.id === g?.sourceSnapshotId)?.parts.find(p => p.detailId === g?.detailId); return `Позиция ${p?.detailNumber ?? '?'} · заказ ${g?.orderId ?? ''}`; };
  return <Modal className="cad-compact" open={open} title="Скачать фрезеровки" width={680} onCancel={onClose} footer={<Button onClick={onClose}>Закрыть</Button>}>
    <p>SVG и DXF каждой детали, manifest.json и ZIP. Файлы требуют настройки обработки в CAM.</p>
    {['saving', 'rendering', 'packing'].includes(phase) && <Space role="status"><Spin size="small" />{phase === 'saving' ? 'Сохраняем и проверяем редакцию…' : phase === 'packing' ? 'Собираем ZIP…' : `Рассчитываем все включённые детали: ${run.data?.job?.completed ?? 0} / ${target?.groups.length ?? '…'}`}</Space>}
    {(error || run.error) && <Alert type="error" message={error || 'Не удалось получить состояние расчёта'} />}
    {target && review && <>
      <dl className="cad-export-summary"><dt>Вариант</dt><dd>{review.variantName} · редакция {review.version}</dd><dt>Состав</dt><dd>{review.positions} позиций · {review.quantity} шт.</dd><dt>Заказы</dt><dd>{review.sourceStatus.map(s => s.orderName).join(', ')}</dd><dt>Отличия от оригинала</dt><dd>{review.changedGroupIds.length} групп</dd></dl>
      <p className="cad-hint">ZIP сохранит эту редакцию, даже если вы продолжите редактирование.</p>
      {review.sourceStatus.filter(s => s.stale).map(s => <Alert key={s.orderId} type="warning" message={`Заказ «${s.orderName}» изменился`} description={`Изменённых исходных позиций: ${s.changedDetailIds.length}. В ZIP останутся данные сохранённой редакции.`} />)}
      {review.sourceStatus.some(s => s.stale) && <Checkbox checked={ack} onChange={e => setAck(e.target.checked)}>Подтверждаю выгрузку сохранённого состава, несмотря на изменения заказов</Checkbox>}
      {review.readiness.items.filter(i => !i.ready).map(i => <div className="cad-export-issue" key={i.part_id}><strong>{partLabel(i.part_id)}</strong><p>{i.status === 'succeeded' ? 'Настройки рассчитаны, но требуют одобрения технолога.' : 'Исправьте параметры и повторите расчёт.'}</p>
        {can('cad.approve') && i.status === 'succeeded' && i.manufacturing_hash && <Button onClick={() => { setApproval({ groupId: i.part_id, hash: i.manufacturing_hash! }); setReason(''); setCommand(null); approvalKey.current = crypto.randomUUID(); }}>Одобрить для этой детали</Button>}</div>)}
      {approval && <div className="cad-approval-form"><p>{partLabel(approval.groupId)}. Одобрение не распространяется на другие детали или варианты.</p><Input.TextArea aria-label="Причина индивидуального одобрения" value={reason} maxLength={1000} disabled={command?.status === 'pending'} onChange={e => setReason(e.target.value)} placeholder="Почему эти настройки допустимы для данной детали" />
        <Button loading={busy || command?.status === 'pending'} disabled={!reason.trim() || command?.status === 'pending'} onClick={() => void act(async () => { setCommand(await cadApi.approve(target, approval.groupId, approval.hash, reason, approvalKey.current)); })}>Подтвердить одобрение</Button>
        {command?.status === 'pending' && <p role="status">Ожидаем подтверждение CAD. Деталь ещё не считается одобренной.</p>}</div>}
      {phase === 'review' && review.ready && <Button type="primary" loading={busy} disabled={review.sourceStatus.some(s => s.stale) && !ack} onClick={() => void act(async () => { await cadApi.package(target, review.reviewId!, ack, packageKey.current); setPhase('packing'); await run.refetch(); })}>Подтвердить и подготовить ZIP</Button>}
      {phase === 'ready' && <><Alert type="success" message="Готово к скачиванию" /><Button type="primary" loading={busy} onClick={() => void act(() => cadApi.download(review.runId, run.data!.run!.packageId!, `cad-${target.name}.zip`, review.reviewId!))}>Скачать ZIP</Button>
        <details><summary>Отдельные файлы</summary>{[...(run.data?.job?.package_files.filter(f => f.name === 'manifest.json') ?? []), ...(run.data?.job?.items.flatMap(i => i.result?.files ?? []) ?? [])].map(f => <Button key={f.id} type="link" onClick={() => void act(() => cadApi.download(review.runId, f.id, f.name.split('/').at(-1) ?? f.id, review.reviewId!))}>{f.name}</Button>)}</details></>}
      <Button disabled={busy || command?.status === 'pending'} onClick={() => void act(() => reviewTarget(target))}>Проверить сводку заново</Button>
    </>}
    {phase === 'error' && <p>Закройте окно, исправьте причины и повторите скачивание. Сохранённая версия остаётся доступна.</p>}
  </Modal>;
}
