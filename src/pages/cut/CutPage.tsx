import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigation } from '@refinedev/core';
import { useSearchParams } from 'react-router-dom';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import type { CutParamProfile, CutSettingRow } from '../../api/cutConfigApi';
import { ApiError } from '../../api/httpClient';
import { resolveProfileLabel, formatArea } from './cutProfileHelpers';
import type {
  CutGroupDto,
  CutJobDto,
  CutJobItemDto,
  EligibleDetailDto,
} from '../../api/types/cutApi.types';
import { can } from '../../utils/permissions';
import { useCutSheetTypeOptions } from '../../hooks/useCutSheetTypeOptions';
import {
  CUT_JOB_STATUS_FILTER_ALL,
  CUT_JOB_STATUS_FILTER_OPTIONS,
  cutJobCounts,
  cutJobSourceLabel,
  cutJobStatusLabel,
  distinctOrderIdsFromItems,
  filterJobsByStatus,
  formatGroupSummary,
  noSheetSpecMessage,
  parseIdCsv,
  parseJobQueryParam,
  pollPdf,
  safeHttpHref,
  selectableDetailIds,
  triggerBlobDownload,
} from './cutPageHelpers';

// Built-in fallback preset names (used until the backend config list loads).
const DEFAULT_PRESET_OPTIONS = [
  { value: 'thumb', label: 'thumb' },
  { value: 'screen', label: 'screen' },
  { value: 'print', label: 'print' },
];

const { Title, Text } = Typography;

const INELIGIBLE_LABELS: Record<string, string> = {
  deleted: 'Удалена',
  wrong_status: 'Неподходящий статус',
  not_cuttable: 'Нераскраиваемый материал',
  no_sheet_spec: 'Нет спецификации',
};

const STATUS_TAG_COLORS: Record<string, string> = {
  draft: 'default',
  calculating: 'processing',
  ready: 'green',
  failed: 'red',
  archived: 'default',
};

/** Revoke every blob object URL in a key->url map (leak guard on reset/unmount). */
const revokeObjectUrls = (map: Record<string, string>): void => {
  Object.values(map).forEach((url) => URL.revokeObjectURL(url));
};

/**
 * Backend-owned /cut page (CLAUDE.md principle 2/3): all reads and commands go
 * through cutApi (`/api/v1/cut-jobs`); the read-layer is never written from here.
 * Flow: criteria -> draft job -> eligible details (no_sheet_spec surfaced) ->
 * basket -> calculate -> per-sheet PNG.
 */
export const CutPage: React.FC = () => {
  const canManage = can('cut.manage');
  // Variant B Task 11: cut.view-gated sheet-type options for the filter Select.
  // Gated on cut.view only — no sheet_materials.view required (worker can use filter).
  const { enabled: sheetFilterEnabled, options: sheetTypeOptions } = useCutSheetTypeOptions();
  // Open orders inside the app's keep-alive workspace tabs (same as the orders
  // list double-click), not a new browser tab.
  const { show } = useNavigation();
  const [form] = Form.useForm<{ name: string; orderIds?: string; sheetMaterialTypeIds?: number[]; filmIds?: string }>();
  const [job, setJob] = useState<CutJobDto | null>(null);
  const [eligible, setEligible] = useState<EligibleDetailDto[] | null>(null);
  const [noSheetSpecCount, setNoSheetSpecCount] = useState(0);
  const [selected, setSelected] = useState<number[]>([]);
  const [busy, setBusy] = useState(false);
  const [sheetImages, setSheetImages] = useState<Record<string, string>>({});
  // Auto-loaded small layout previews (preset 'thumb') for a ready job's sheets,
  // keyed `${cutGroupId}:${sheetIndex}`. thumbReqRef dedupes in-flight/done fetches.
  const [sheetThumbs, setSheetThumbs] = useState<Record<string, string>>({});
  const thumbReqRef = useRef<Set<string>>(new Set());
  // Generation counter bumped on every job-context switch/reset; an async sheet
  // fetch captures it and discards its result if it changed (job switched).
  const viewEpochRef = useRef(0);
  // Mirror of the live blob maps so the unmount cleanup (stale-closure-safe) can
  // revoke any outstanding object URLs even though /cut is kept mounted.
  const blobsRef = useRef<{ images: Record<string, string>; thumbs: Record<string, string> }>({
    images: {},
    thumbs: {},
  });

  // Clear both per-sheet view caches, revoking blob URLs so a recalculated or
  // reopened job never shows a stale preview and never leaks blobs.
  const resetSheetViews = useCallback(() => {
    setSheetImages((prev) => {
      revokeObjectUrls(prev);
      return {};
    });
    setSheetThumbs((prev) => {
      revokeObjectUrls(prev);
      return {};
    });
    thumbReqRef.current = new Set();
    // Invalidate in-flight sheet/thumb fetches so a late completion can't
    // repopulate the just-cleared maps with a stale-job blob.
    viewEpochRef.current += 1;
  }, []);

  useEffect(() => {
    blobsRef.current = { images: sheetImages, thumbs: sheetThumbs };
  }, [sheetImages, sheetThumbs]);
  useEffect(
    () => () => {
      revokeObjectUrls(blobsRef.current.images);
      revokeObjectUrls(blobsRef.current.thumbs);
    },
    [],
  );
  const [preset, setPreset] = useState<string>('screen');
  const [presetOptions, setPresetOptions] = useState(DEFAULT_PRESET_OPTIONS);
  const [profiles, setProfiles] = useState<CutParamProfile[]>([]);
  const [cutSettings, setCutSettings] = useState<CutSettingRow[]>([]);
  const [jobs, setJobs] = useState<CutJobDto[]>([]);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(CUT_JOB_STATUS_FILTER_ALL);

  // Render presets are config-driven (/configuration "Раскрой"): load the active
  // names from the backend, falling back to the built-ins.
  useEffect(() => {
    cutConfigApi
      .get()
      .then((cfg) => {
        const options = cfg.renderPresets
          .filter((p) => p.isActive)
          .map((p) => ({ value: p.name, label: p.name }));
        if (options.length > 0) setPresetOptions(options);
        setProfiles(cfg.paramProfiles); // FULL list (active + inactive)
        setCutSettings(cfg.settings);
      })
      .catch(() => undefined);
  }, []);

  const criteriaFromForm = useCallback(() => {
    const values = form.getFieldsValue();
    // sheetMaterialTypeIds: comes from a Select<number[]> (not a CSV string) when the
    // sheet filter is enabled; falls back to empty array otherwise.
    const sheetMaterialTypeIds: number[] | undefined =
      values.sheetMaterialTypeIds && values.sheetMaterialTypeIds.length > 0
        ? values.sheetMaterialTypeIds
        : undefined;
    return {
      orderIds: parseIdCsv(values.orderIds ?? ''),
      sheetMaterialTypeIds,
      filmIds: parseIdCsv(values.filmIds ?? ''),
    };
  }, [form]);

  const handleError = useCallback((error: unknown, fallback: string) => {
    const text = error instanceof ApiError ? error.message : fallback;
    message.error(text);
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      setJobs(await cutApi.list());
    } catch (error) {
      handleError(error, 'Не удалось загрузить список раскроев');
    } finally {
      setJobsLoading(false);
    }
  }, [handleError]);

  const setJobProfile = useCallback(
    async (paramProfileId: number | null) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setProfile(job.cutJobId, paramProfileId, job.version);
        setJob(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить профиль раскроя');
      } finally {
        setBusy(false);
      }
    },
    [job, loadJobs, handleError],
  );

  // Load the existing (non-archived) jobs on mount so an operator can reopen a
  // job created earlier — including jobs staged from the Orders "Добавить в
  // раскрой" action, which previously had no surface to be reopened on.
  useEffect(() => {
    if (can('cut.view')) void loadJobs();
  }, [loadJobs]);

  // Deep-link: /cut?job=<id> opens that job once on mount (e.g. from the order
  // show page «Раскрой» column). Guarded so it fires a single time per mount.
  // openJob(id) loads ANY existing job by id (getJob/loadJob do not filter
  // archived) and shows it; a missing/invalid id throws and is caught by
  // openJob's handleError toast. The column only links ready jobs, so the normal
  // flow never deep-links archived — only a stale/hand-edited URL can. Mutate
  // controls are disabled for archived jobs (isArchivedJob guard) so this is truly read-only.
  const [searchParams] = useSearchParams();
  const deepLinkHandledRef = useRef(false);
  useEffect(() => {
    if (deepLinkHandledRef.current) return;
    if (!can('cut.view')) return;
    const jobId = parseJobQueryParam(`?${searchParams.toString()}`);
    if (jobId === null) return;
    deepLinkHandledRef.current = true;
    void openJob(jobId);
  }, [searchParams, openJob]);

  const openJob = useCallback(
    async (cutJobId: number) => {
      setBusy(true);
      try {
        const fresh = await cutApi.get(cutJobId);
        setJob(fresh);
        // Prefill the eligible-load criteria with the order(s) this job was built
        // from (the reserved items' orders) so "Загрузить подходящие детали" is
        // scoped to those orders instead of scanning everything. Material/film
        // filters are cleared to avoid stale criteria leaking from a prior job.
        const orderIds = distinctOrderIdsFromItems(fresh.items);
        form.setFieldsValue({
          name: fresh.name,
          orderIds: orderIds.length > 0 ? orderIds.join(',') : undefined,
          sheetMaterialTypeIds: undefined, // Variant B sunset: cleared the post-034 filter key
          filmIds: undefined,
        });
        setEligible(null);
        setSelected([]);
        resetSheetViews();
      } catch (error) {
        handleError(error, 'Не удалось открыть раскрой');
      } finally {
        setBusy(false);
      }
    },
    [form, handleError, resetSheetViews],
  );

  const archiveJob = useCallback(
    async (target: CutJobDto) => {
      setBusy(true);
      try {
        const fresh = await cutApi.get(target.cutJobId);
        await cutApi.archive(fresh.cutJobId, fresh.version);
        message.success('Раскрой архивирован');
        if (job?.cutJobId === target.cutJobId) {
          setJob(null);
          setEligible(null);
          setSelected([]);
          resetSheetViews();
        }
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось архивировать раскрой');
      } finally {
        setBusy(false);
      }
    },
    [job, loadJobs, handleError, resetSheetViews],
  );

  const createJob = useCallback(async () => {
    setBusy(true);
    try {
      const values = await form.validateFields();
      const created = await cutApi.create({ name: values.name, criteria: criteriaFromForm() });
      setJob(created);
      setEligible(null);
      setSelected([]);
      resetSheetViews(); // new job context: drop any previewed prior job's blobs
      message.success('Раскрой создан');
      await loadJobs();
    } catch (error) {
      if (error && (error as { errorFields?: unknown }).errorFields) return; // antd validation
      handleError(error, 'Не удалось создать раскрой');
    } finally {
      setBusy(false);
    }
  }, [form, criteriaFromForm, loadJobs, handleError, resetSheetViews]);

  const loadEligible = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const response = await cutApi.listEligibleDetails(job.cutJobId, criteriaFromForm());
      setEligible(response.details);
      setNoSheetSpecCount(response.noSheetSpecCount);
      setSelected(selectableDetailIds(response.details));
    } catch (error) {
      handleError(error, 'Не удалось загрузить детали');
    } finally {
      setBusy(false);
    }
  }, [job, criteriaFromForm, handleError]);

  const addToBasket = useCallback(async () => {
    if (!job || selected.length === 0) return;
    setBusy(true);
    try {
      const updated = await cutApi.addItems(job.cutJobId, { detailIds: selected, version: job.version });
      setJob(updated);
      message.success('Детали добавлены в раскрой');
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось добавить детали');
    } finally {
      setBusy(false);
    }
  }, [job, selected, loadJobs, handleError]);

  const removeJobItem = useCallback(
    async (cutJobItemId: number) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.removeItem(job.cutJobId, cutJobItemId, job.version);
        setJob(updated);
        message.success('Деталь убрана из раскроя');
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось убрать деталь');
      } finally {
        setBusy(false);
      }
    },
    [job, loadJobs, handleError],
  );

  const calculate = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const calculated = await cutApi.calculate(job.cutJobId, job.version);
      setJob(calculated);
      resetSheetViews();
      message.success('Раскрой рассчитан');
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось рассчитать раскрой');
      // Reload so the now-failed job shows its persisted reason (Alert) and a
      // fresh version for an immediate retry — the failure bumped the version
      // server-side, so the stale in-memory job would otherwise 409 on retry.
      try {
        setJob(await cutApi.get(job.cutJobId));
        await loadJobs();
      } catch {
        // best-effort refresh; the toast already explained the failure
      }
    } finally {
      setBusy(false);
    }
  }, [job, loadJobs, handleError, resetSheetViews]);

  const loadSheet = useCallback(
    async (group: CutGroupDto, sheetIndex: number) => {
      if (!job) return;
      const key = `${group.cutGroupId}:${sheetIndex}`;
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(job.cutJobId, group.cutGroupId, sheetIndex, preset);
        // Discard a completion that lands after a job switch/reset (stale blob).
        if (viewEpochRef.current !== epoch) return;
        setSheetImages((prev) => {
          if (prev[key]) URL.revokeObjectURL(prev[key]);
          return { ...prev, [key]: URL.createObjectURL(blob) };
        });
      } catch (error) {
        handleError(error, 'Не удалось загрузить лист раскроя');
      }
    },
    [job, preset, handleError],
  );

  // Small layout preview for a ready job's sheet, fetched once with the light
  // 'thumb' preset. Deduped via thumbReqRef so the auto-load effect is idempotent.
  const loadThumb = useCallback(
    async (cutJobId: number, group: CutGroupDto, sheetIndex: number) => {
      const key = `${group.cutGroupId}:${sheetIndex}`;
      const reqKey = `${cutJobId}:${key}`;
      if (thumbReqRef.current.has(reqKey)) return;
      thumbReqRef.current.add(reqKey);
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(cutJobId, group.cutGroupId, sheetIndex, 'thumb');
        // Discard a completion that lands after a job switch/reset (stale blob).
        if (viewEpochRef.current !== epoch) return;
        setSheetThumbs((prev) => {
          if (prev[key]) URL.revokeObjectURL(prev[key]);
          return { ...prev, [key]: URL.createObjectURL(blob) };
        });
      } catch {
        // Preview is best-effort; the full-size "Лист N" view still works on click.
        thumbReqRef.current.delete(reqKey);
      }
    },
    [],
  );

  // Auto-load per-sheet previews when a ready job's layout is present, so an
  // operator sees the cut result inline without clicking each sheet.
  useEffect(() => {
    if (!job || job.status !== 'ready') return;
    for (const group of job.groups) {
      for (const sheet of group.sheets) {
        void loadThumb(job.cutJobId, group, sheet.sheetIndex);
      }
    }
  }, [job, loadThumb]);

  const downloadSheetSvg = useCallback(
    async (group: CutGroupDto, sheetIndex: number) => {
      if (!job) return;
      try {
        const blob = await cutApi.fetchSheetSvg(job.cutJobId, group.cutGroupId, sheetIndex);
        triggerBlobDownload(blob, `cut-${job.cutJobId}-g${group.cutGroupId}-s${sheetIndex + 1}.svg`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить SVG');
      }
    },
    [job, handleError],
  );

  const downloadGroupPdf = useCallback(
    async (group: CutGroupDto) => {
      if (!job) return;
      setBusy(true);
      try {
        const result = await pollPdf(() => cutApi.fetchGroupPdf(job.cutJobId, group.cutGroupId));
        triggerBlobDownload(result.blob, result.fileName ?? `cut-group-${group.cutGroupId}.pdf`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить PDF группы');
      } finally {
        setBusy(false);
      }
    },
    [job, handleError],
  );

  const downloadJobPdf = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const result = await pollPdf(() => cutApi.fetchJobPdf(job.cutJobId));
      triggerBlobDownload(result.blob, result.fileName ?? `cut-job-${job.cutJobId}.pdf`);
    } catch (error) {
      handleError(error, 'Не удалось выгрузить PDF раскроя');
    } finally {
      setBusy(false);
    }
  }, [job, handleError]);

  const filteredJobs = useMemo(() => filterJobsByStatus(jobs, statusFilter), [jobs, statusFilter]);

  const jobColumns: ColumnsType<CutJobDto> = useMemo(
    () => [
      { title: '#', dataIndex: 'cutJobId', key: 'id', width: 70 },
      { title: 'Название', dataIndex: 'name', key: 'name' },
      {
        title: 'Статус',
        key: 'status',
        width: 120,
        render: (_: unknown, row: CutJobDto) => {
          const tag = <Tag color={STATUS_TAG_COLORS[row.status] ?? 'default'}>{cutJobStatusLabel(row.status)}</Tag>;
          // A failed job carries a human-readable reason — surface it on hover so
          // the bare red "Ошибка" tag is never an unexplained dead end.
          return row.status === 'failed' && row.failureReason ? (
            <Tooltip title={row.failureReason}>{tag}</Tooltip>
          ) : (
            tag
          );
        },
      },
      {
        title: 'Источник',
        key: 'source',
        width: 100,
        render: (_: unknown, row: CutJobDto) => cutJobSourceLabel(row.source),
      },
      {
        title: 'Позиции',
        key: 'positions',
        width: 90,
        render: (_: unknown, row: CutJobDto) => row.totals.positions,
      },
      {
        title: 'Группы',
        key: 'groups',
        width: 80,
        render: (_: unknown, row: CutJobDto) => cutJobCounts(row).groups,
      },
      {
        title: 'Деталей',
        key: 'details',
        width: 90,
        render: (_: unknown, row: CutJobDto) => row.totals.details,
      },
      {
        title: 'Площадь, итого',
        key: 'area',
        width: 120,
        render: (_: unknown, row: CutJobDto) => formatArea(row.totals.area),
      },
      {
        title: 'Кол-во листов раскроя',
        key: 'sheets',
        width: 120,
        render: (_: unknown, row: CutJobDto) => (row.status === 'ready' ? row.totals.sheets : '—'),
      },
      {
        title: 'Профиль',
        key: 'profile',
        width: 180,
        render: (_: unknown, row: CutJobDto) => resolveProfileLabel(row.paramProfileId, profiles, cutSettings),
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 200,
        render: (_: unknown, row: CutJobDto) => (
          <Space>
            <Button size="small" type="link" onClick={() => openJob(row.cutJobId)} disabled={busy}>
              Открыть
            </Button>
            {canManage && (
              <Button size="small" type="link" danger onClick={() => archiveJob(row)} disabled={busy}>
                Архивировать
              </Button>
            )}
          </Space>
        ),
      },
    ],
    [busy, canManage, openJob, archiveJob, profiles, cutSettings],
  );

  const eligibleColumns: ColumnsType<EligibleDetailDto> = useMemo(
    () => [
      { title: 'Деталь', dataIndex: 'orderDetailId', key: 'detail' },
      { title: 'Заказ', dataIndex: 'orderId', key: 'order' },
      { title: 'Кол-во', dataIndex: 'quantity', key: 'qty' },
      {
        title: 'Статус',
        key: 'status',
        render: (_: unknown, row: EligibleDetailDto) =>
          row.eligible ? (
            <Tag color="green">Готова к раскрою</Tag>
          ) : (
            <Tag color="orange">{INELIGIBLE_LABELS[row.ineligibleReason ?? ''] ?? row.ineligibleReason}</Tag>
          ),
      },
    ],
    [],
  );

  // Archived jobs are genuinely read-only: all mutate controls are disabled so
  // an operator deep-linked to an archived job (e.g. from the order show Раскрой
  // column via a stale/hand-edited URL) cannot accidentally mutate it.
  const isArchivedJob = job?.status === 'archived';

  // The details an operator actually reserved into this job (cut_job_item rows),
  // including those staged from the Orders "Добавить в раскрой" action. Showing
  // them is what makes a reopened job legible: "Загрузить подходящие детали" only
  // surfaces the candidate pool, never the selection already in the job.
  const jobItemColumns: ColumnsType<CutJobItemDto> = useMemo(() => {
    const dash = (value: unknown) => (value === null || value === undefined || value === '' ? '—' : String(value));
    return [
      { title: 'Поз.', key: 'pos', width: 60, fixed: 'left', render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.detailNumber) },
      { title: 'Наименование', key: 'name', width: 180, fixed: 'left', render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.detailName) },
      {
        title: 'Заказ',
        dataIndex: 'orderId',
        key: 'order',
        width: 80,
        // Click the order number to open its card as an in-app workspace tab
        // (push = new keep-alive tab, same as the orders list double-click).
        render: (_: unknown, r: CutJobItemDto) => (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => show('orders_view', r.orderId, 'push')}>
            {r.orderId}
          </Button>
        ),
      },
      { title: 'Деталь', dataIndex: 'orderDetailId', key: 'detailId', width: 90 },
      {
        title: 'Размер (Ш×В)',
        key: 'size',
        width: 130,
        render: (_: unknown, r: CutJobItemDto) =>
          r.detail && (r.detail.width !== null || r.detail.height !== null)
            ? `${dash(r.detail.width)}×${dash(r.detail.height)}`
            : '—',
      },
      { title: 'Кол-во', dataIndex: 'qty', key: 'qty', width: 80 },
      { title: 'Площадь', key: 'area', width: 90, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.area) },
      { title: 'Материал', key: 'material', width: 160, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.materialName) },
      { title: 'Фрезеровка', key: 'milling', width: 140, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.millingTypeName) },
      { title: 'Кромка', key: 'edge', width: 120, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.edgeTypeName) },
      { title: 'Плёнка', key: 'film', width: 140, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.filmName) },
      { title: 'Статус', key: 'pstatus', width: 130, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.productionStatusName) },
      { title: 'Приоритет', key: 'priority', width: 100, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.priority) },
      { title: 'Соед. заказ', key: 'joint', width: 110, render: (_: unknown, r: CutJobItemDto) => dash(r.detail?.jointOrderId) },
      {
        title: 'Примечание',
        key: 'note',
        width: 200,
        render: (_: unknown, r: CutJobItemDto) =>
          r.detail?.note ? (
            <Tooltip title={r.detail.note}>
              <Text ellipsis style={{ maxWidth: 180, display: 'inline-block' }}>{r.detail.note}</Text>
            </Tooltip>
          ) : (
            '—'
          ),
      },
      {
        title: 'Файлы',
        key: 'files',
        width: 150,
        render: (_: unknown, r: CutJobItemDto) => {
          const links: Array<[string, string | null | undefined]> = [
            ['Рез', r.detail?.linkCuttingFile],
            ['Фото', r.detail?.linkCuttingImageFile],
            ['CAD', r.detail?.linkCadFile],
            ['PDF', r.detail?.linkPdfFile],
          ];
          const present = links.filter(([, href]) => Boolean(href));
          if (present.length === 0) return '—';
          return (
            <Space size={4} wrap>
              {present.map(([label, href]) => {
                // Fail-closed: only http(s)/app-relative links become clickable;
                // a javascript:/data: stored link renders as inert text (no XSS).
                const safe = safeHttpHref(href);
                return safe ? (
                  <a key={label} href={safe} target="_blank" rel="noreferrer">
                    {label}
                  </a>
                ) : (
                  <Tooltip key={label} title="Небезопасная ссылка — открытие заблокировано">
                    <Text type="secondary" delete>
                      {label}
                    </Text>
                  </Tooltip>
                );
              })}
            </Space>
          );
        },
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 110,
        fixed: 'right',
        render: (_: unknown, row: CutJobItemDto) =>
          canManage ? (
            <Button size="small" type="link" danger onClick={() => removeJobItem(row.cutJobItemId)} disabled={busy || isArchivedJob}>
              Убрать
            </Button>
          ) : null,
      },
    ];
  }, [busy, canManage, isArchivedJob, removeJobItem, show]);

  const noSheetMsg = noSheetSpecMessage(noSheetSpecCount);

  if (!can('cut.view')) {
    return <Alert type="error" message="Недостаточно прав для просмотра раскроя" showIcon />;
  }

  return (
    <Space direction="vertical" size="large" style={{ width: '100%' }}>
      <Title level={3}>Раскрой</Title>

      <Card title="Критерии выборки" size="small">
        <Form form={form} layout="inline" disabled={busy || !canManage}>
          <Form.Item name="name" rules={[{ required: true, message: 'Укажите название' }]}>
            <Input placeholder="Название раскроя" />
          </Form.Item>
          <Form.Item name="orderIds">
            <Input placeholder="Заказы (9,10)" />
          </Form.Item>
          {sheetFilterEnabled && (
            <Form.Item name="sheetMaterialTypeIds">
              <Select<number[]>
                mode="multiple"
                allowClear
                placeholder="Типы листов"
                options={sheetTypeOptions}
                fieldNames={{ label: 'label', value: 'value' }}
                style={{ minWidth: 200 }}
                data-testid="cut-sheet-type-filter"
              />
            </Form.Item>
          )}
          <Form.Item name="filmIds">
            <Input placeholder="Плёнки" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" onClick={createJob} loading={busy} disabled={!canManage}>
              Создать раскрой
            </Button>
          </Form.Item>
        </Form>
      </Card>

      <Card
        size="small"
        title="Раскрои"
        extra={
          <Space>
            <Select<string>
              value={statusFilter}
              onChange={setStatusFilter}
              options={[...CUT_JOB_STATUS_FILTER_OPTIONS]}
              style={{ width: 160 }}
            />
            <Button onClick={loadJobs} loading={jobsLoading}>
              Обновить
            </Button>
          </Space>
        }
      >
        <Table<CutJobDto>
          size="small"
          rowKey="cutJobId"
          columns={jobColumns}
          dataSource={filteredJobs}
          loading={jobsLoading}
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: 'Нет раскроев' }}
          rowClassName={(row) => (row.cutJobId === job?.cutJobId ? 'ant-table-row-selected' : '')}
          onRow={(row) => ({
            onDoubleClick: () => {
              if (!busy) void openJob(row.cutJobId);
            },
          })}
        />
      </Card>

      {job && (
        <Card
          size="small"
          title={`Раскрой #${job.cutJobId} — ${job.name}`}
          extra={
            <Tag color={STATUS_TAG_COLORS[job.status] ?? 'default'}>{cutJobStatusLabel(job.status)}</Tag>
          }
        >
          {job.status === 'failed' && job.failureReason && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message="Не удалось рассчитать раскрой"
              description={job.failureReason}
            />
          )}
          {(() => {
            const activeOptions = profiles
              .filter((p) => p.isActive)
              .map((p) => ({ value: p.cutParamProfileId, label: resolveProfileLabel(p.cutParamProfileId, profiles, cutSettings) }));
            const chosen = job.paramProfileId;
            const chosenInactive = chosen !== null && !profiles.some((p) => p.cutParamProfileId === chosen && p.isActive);
            const profileOptions = chosenInactive
              ? [...activeOptions, { value: chosen, label: resolveProfileLabel(chosen, profiles, cutSettings), disabled: true }]
              : activeOptions;
            return (
              <>
                <Space size="large" style={{ marginBottom: 12 }}>
                  <span>Позиции: <b>{job.totals.positions}</b></span>
                  <span>Деталей: <b>{job.totals.details}</b></span>
                  <span>Площадь, итого: <b>{formatArea(job.totals.area)}</b></span>
                  {job.status === 'ready' && <span>Листов раскроя: <b>{job.totals.sheets}</b></span>}
                </Space>
                <div style={{ marginBottom: 12 }}>
                  <span style={{ marginRight: 8 }}>Профиль раскроя:</span>
                  <Select<number | null>
                    value={job.paramProfileId}
                    onChange={(v) => void setJobProfile(v ?? null)}
                    disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                    style={{ minWidth: 240 }}
                    placeholder={resolveProfileLabel(null, profiles, cutSettings)}
                    allowClear
                    options={profileOptions}
                  />
                  {job.status === 'ready' && (
                    <span style={{ marginLeft: 8, color: '#ad8b00' }}>
                      изменение профиля применится после команды «Повторить расчёт»
                    </span>
                  )}
                </div>
              </>
            );
          })()}
          <Space>
            <Button onClick={loadEligible} loading={busy}>
              Загрузить подходящие детали
            </Button>
            <Button onClick={addToBasket} disabled={!canManage || selected.length === 0 || isArchivedJob} loading={busy}>
              Добавить выбранные ({selected.length})
            </Button>
            <Button type="primary" onClick={calculate} disabled={!canManage || job.items.length === 0 || isArchivedJob} loading={busy}>
              {job.status === 'failed' ? 'Повторить расчёт' : 'Рассчитать'}
            </Button>
            <Select<string>
              value={preset}
              onChange={setPreset}
              options={presetOptions}
              style={{ width: 140 }}
            />
            {job.groups.length > 0 && (
              <Button onClick={downloadJobPdf} loading={busy}>
                Скачать PDF (весь раскрой)
              </Button>
            )}
          </Space>
        </Card>
      )}

      {job && (
        <Card size="small" title={`Детали задания (${job.items.length})`}>
          <Table<CutJobItemDto>
            size="small"
            rowKey="cutJobItemId"
            columns={jobItemColumns}
            dataSource={job.items}
            pagination={false}
            scroll={{ x: 1900 }}
            locale={{ emptyText: 'В задании пока нет деталей — добавьте их из заказа или через «Загрузить подходящие детали»' }}
          />
        </Card>
      )}

      {noSheetMsg && <Alert type="warning" showIcon message={noSheetMsg} />}

      {eligible && (
        <Table<EligibleDetailDto>
          size="small"
          rowKey="orderDetailId"
          columns={eligibleColumns}
          dataSource={eligible}
          pagination={false}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: (keys) => setSelected(keys.map(Number)),
            getCheckboxProps: (row) => ({ disabled: !row.eligible }),
          }}
        />
      )}

      {job?.groups.map((group) => (
        <Card
          key={group.cutGroupId}
          size="small"
          title={`Группа #${group.cutGroupId}`}
          extra={
            <Button size="small" onClick={() => downloadGroupPdf(group)} loading={busy}>
              Скачать PDF
            </Button>
          }
        >
          <Text type="secondary">{formatGroupSummary(group.summary)}</Text>
          <Space direction="vertical" style={{ width: '100%' }}>
            {group.sheets.map((sheet) => {
              const key = `${group.cutGroupId}:${sheet.sheetIndex}`;
              return (
                <div key={key}>
                  <Space>
                    <Button size="small" onClick={() => loadSheet(group, sheet.sheetIndex)}>
                      Лист {sheet.sheetIndex + 1}
                    </Button>
                    <Button size="small" onClick={() => downloadSheetSvg(group, sheet.sheetIndex)}>
                      SVG
                    </Button>
                  </Space>
                  {/* Inline auto-preview (~5 detail rows tall); click to open full size. */}
                  {sheetThumbs[key] && !sheetImages[key] && (
                    <div style={{ marginTop: 4 }}>
                      <Tooltip title="Открыть лист в полном размере">
                        <img
                          src={sheetThumbs[key]}
                          alt={`Превью листа ${sheet.sheetIndex + 1}`}
                          onClick={() => loadSheet(group, sheet.sheetIndex)}
                          style={{ height: 170, width: 'auto', maxWidth: '100%', cursor: 'pointer', border: '1px solid #f0f0f0' }}
                        />
                      </Tooltip>
                    </div>
                  )}
                  {sheetImages[key] && (
                    <div>
                      <img src={sheetImages[key]} alt={`Лист ${sheet.sheetIndex + 1}`} style={{ maxWidth: '100%' }} />
                    </div>
                  )}
                </div>
              );
            })}
          </Space>
        </Card>
      ))}
    </Space>
  );
};
