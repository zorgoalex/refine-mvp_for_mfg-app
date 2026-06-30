import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Form,
  Input,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { useNavigation } from '@refinedev/core';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import type { CutParamProfile, CutSettingRow } from '../../api/cutConfigApi';
import { ApiError } from '../../api/httpClient';
import { resolveProfileLabel, formatArea, describeCutProfile } from './cutProfileHelpers';
import { jobMaterialTypeIds, partitionSheetOptions, isMixedMaterialSelection, formatSheetOptionLabel } from './cutSheetSelectHelpers';
import { buildSheetPieceOverlays, loadSheetOrientationPortrait, saveSheetOrientationPortrait, selectVariantSheets } from './cutPreviewHelpers';
import { TableTopScroll } from '../../components/TableTopScroll';
import { SheetPreview } from './SheetPreview';
import { SheetEditor } from './SheetEditor';
import { CutSheetLabelGenerateAction } from './CutSheetLabelGenerateAction';
import { authSession } from '../../api/authSession';
import type {
  CutGroupDto,
  CutJobDto,
  CutJobItemDto,
  EligibleDetailDto,
  SheetPlacements,
} from '../../api/types/cutApi.types';
import { validateSheetPlacements, movesFromSheets } from './cutLayoutGeometry';
import type { ManualViolation } from './cutLayoutGeometry';
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
  buildFilmTextureMap,
} from './cutPageHelpers';
import { can } from '../../utils/permissions';
import { useCutSheetTypeOptions } from '../../hooks/useCutSheetTypeOptions';
import { useTabStore } from '../../stores/tabStore';
import { useKeepAlive } from '../../components/workspace/KeepAliveContext';
const { Panel } = Collapse;

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

const sheetPreviewListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 16,
  marginTop: 8,
};

function sheetPreviewRotate90(widthMm: number, heightMm: number, portrait: boolean): boolean {
  if (widthMm === heightMm) return false;
  return portrait ? widthMm > heightMm : widthMm < heightMm;
}

function sheetPreviewItemStyle(widthMm: number, heightMm: number, rotate90: boolean): React.CSSProperties {
  const horizontalMm = rotate90 ? heightMm : widthMm;
  const verticalMm = rotate90 ? widthMm : heightMm;
  const ratio = verticalMm > 0 ? horizontalMm / verticalMm : 1;
  const basis = Math.min(520, Math.max(240, Math.round(ratio * 260 + 112)));
  return {
    flex: `0 1 ${basis}px`,
    maxWidth: '100%',
    // Reserve the thumbnail's image-area height so that when a preview reloads
    // (its cache key is bumped by a job version change, e.g. on profile/material
    // change) the row does not momentarily collapse and bounce the page scroll.
    minHeight: Math.round(basis / Math.max(ratio, 0.01)),
  };
}

function groupFilmNames(job: CutJobDto, group: CutGroupDto): string[] {
  const names = new Set<string>();
  for (const item of job.items) {
    if (item.cutGroupId !== group.cutGroupId) continue;
    const name = item.detail?.filmName?.trim();
    if (name) names.add(name);
  }
  return [...names];
}

function detailIdsForSheet(sheet: { placements: SheetPlacements }): number[] {
  return sheet.placements.pieces
    .map((piece) => {
      const match = /^det-(\d+)$/.exec(piece.item_id);
      return match ? Number(match[1]) : null;
    })
    .filter((value): value is number => Number.isInteger(value) && value > 0);
}

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
  // Theme-aware bg for the sticky group header (app uses AntD dark/default
  // algorithm, no CSS vars — read the token directly).
  const { token } = theme.useToken();
  // Variant B Task 11: cut.view-gated sheet-type options for the filter Select.
  // Gated on cut.view only — no sheet_materials.view required (worker can use filter).
  const { enabled: sheetFilterEnabled, options: sheetTypeOptions, rawOptions: sheetOptions } = useCutSheetTypeOptions();
  // Open orders inside the app's keep-alive workspace tabs (same as the orders
  // list double-click), not a new browser tab.
  const { show } = useNavigation();
  const [form] = Form.useForm<{ name: string; orderIds?: string; sheetMaterialTypeIds?: number[]; filmIds?: string }>();
  const [job, setJob] = useState<CutJobDto | null>(null);
  // Per-user, per-job sheet preview orientation (portrait by default), persisted
  // in localStorage. Landscape rotates the render server-side (labels stay upright).
  const [sheetPortrait, setSheetPortrait] = useState(true);
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

  // Collapse a single full-size sheet back to its thumbnail: revoke the full
  // image blob and drop it from the map (the thumb stays; clicking reopens).
  const collapseSheet = useCallback((key: string) => {
    setSheetImages((prev) => {
      if (!prev[key]) return prev;
      URL.revokeObjectURL(prev[key]);
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  // Load this user's saved orientation for the opened job (default portrait).
  useEffect(() => {
    if (!job) return;
    const uid = authSession.getUser()?.id ?? 'anon';
    setSheetPortrait(loadSheetOrientationPortrait(uid, job.cutJobId));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [job?.cutJobId]);

  // Toggle + persist orientation; drop cached previews so they re-fetch oriented.
  const toggleSheetPortrait = useCallback(
    (portrait: boolean) => {
      setSheetPortrait(portrait);
      if (job) {
        const uid = authSession.getUser()?.id ?? 'anon';
        saveSheetOrientationPortrait(uid, job.cutJobId, portrait);
      }
      resetSheetViews();
    },
    [job, resetSheetViews],
  );

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

  // ── Manual layout editor state ──────────────────────────────────────────────
  // The group currently open for editing (null = no editor active).
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  // Working sheets for the active editor (seeded from manualLayout or auto sheets).
  const [workingSheets, setWorkingSheets] = useState<{ sheetIndex: number; placements: SheetPlacements }[]>([]);
  // Current geometry violations (empty = all clear, save enabled).
  const [violations, setViolations] = useState<ManualViolation[]>([]);
  // Per-group alternative-view toggle: true = show manual variant, false = show auto.
  // Initialised from group.manualLayout.isActive on job open; only persisted on Save.
  const [showAlternativeByGroup, setShowAlternativeByGroup] = useState<Record<number, boolean>>({});

  // Render presets and cut profiles are config-driven (/configuration "Раскрой").
  // Load active names from the backend, falling back to the built-ins.
  const loadCutConfig = useCallback(async () => {
    try {
      const cfg = await cutConfigApi.get();
      const options = cfg.renderPresets
        .filter((p) => p.isActive)
        .map((p) => ({ value: p.name, label: p.name }));
      if (options.length > 0) setPresetOptions(options);
      setProfiles(cfg.paramProfiles); // FULL list (active + inactive)
      setCutSettings(cfg.settings);
    } catch {
      // keep the current/built-in options on failure
    }
  }, []);

  useEffect(() => {
    void loadCutConfig();
  }, [loadCutConfig]);

  // The /cut tab is kept alive (not remounted) when switching tabs, so profiles
  // created elsewhere (e.g. /configuration "Раскрой") would otherwise stay stale.
  // Refetch the config whenever this tab is re-activated.
  const { isActive } = useKeepAlive();
  const wasActiveRef = useRef(isActive);
  useEffect(() => {
    if (isActive && !wasActiveRef.current) {
      void loadCutConfig();
    }
    wasActiveRef.current = isActive;
  }, [isActive, loadCutConfig]);

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

  const cutTabPath = useTabStore((s) => s.tabs.find((t) => t.key === '/cut')?.path);
  const lastListRefreshPathRef = useRef<string | undefined>(undefined);

  // /cut is kept mounted by the workspace. Jobs may be created from an order
  // while this page is hidden, so refresh the list when the /cut tab is opened
  // or its path changes via useTabSync/deep-link.
  useEffect(() => {
    if (!can('cut.view')) return;
    if (!cutTabPath) return;
    if (cutTabPath === lastListRefreshPathRef.current) return;
    lastListRefreshPathRef.current = cutTabPath;
    void loadJobs();
  }, [cutTabPath, loadJobs]);

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

  const setJobSheetMaterial = useCallback(
    async (sheetMaterialTypeId: number | null) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSheetMaterial(job.cutJobId, sheetMaterialTypeId, job.version);
        setJob(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить лист раскроя');
      } finally {
        setBusy(false);
      }
    },
    [job, handleError, loadJobs],
  );

  const setJobCombineFilms = useCallback(
    async (combineFilms: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setCombineFilms(job.cutJobId, combineFilms, job.version);
        setJob(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить объединение плёнок');
      } finally {
        setBusy(false);
      }
    },
    [job, handleError, loadJobs],
  );

  const setJobSplitByMaterial = useCallback(
    async (splitByMaterial: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSplitByMaterial(job.cutJobId, splitByMaterial, job.version);
        setJob(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить разделение по материалу');
      } finally {
        setBusy(false);
      }
    },
    [job, handleError, loadJobs],
  );

  // Load the existing (non-archived) jobs on mount so an operator can reopen a
  // job created earlier — including jobs staged from the Orders "Добавить в
  // раскрой" action, which previously had no surface to be reopened on.
  useEffect(() => {
    if (can('cut.view')) void loadJobs();
  }, [loadJobs]);

  // Last-write-wins guard for openJob: a stale in-flight cutApi.get (e.g. rapid
  // deep-link /cut?job=45 -> 46, or fast successive row opens) must not overwrite
  // the UI with an older job after a newer open started. Each call captures its
  // sequence; only the latest applies its result/error/busy reset.
  const openSeqRef = useRef(0);
  const openJob = useCallback(
    async (cutJobId: number) => {
      const seq = ++openSeqRef.current;
      setBusy(true);
      try {
        const fresh = await cutApi.get(cutJobId);
        if (openSeqRef.current !== seq) return; // superseded by a newer openJob
        setJob(fresh);
        // Initialise per-group alternative-view toggle from persisted isActive so
        // the checkbox position matches the last saved manual-layout state.
        const initAlt: Record<number, boolean> = {};
        for (const g of fresh.groups) {
          initAlt[g.cutGroupId] = g.manualLayout?.isActive ?? false;
        }
        setShowAlternativeByGroup(initAlt);
        // Reset any open editor (a reopened job starts without an active edit).
        setEditingGroupId(null);
        setWorkingSheets([]);
        setViolations([]);
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
        void loadJobs();
      } catch (error) {
        if (openSeqRef.current !== seq) return; // superseded; swallow the stale error
        handleError(error, 'Не удалось открыть раскрой');
      } finally {
        if (openSeqRef.current === seq) setBusy(false);
      }
    },
    [form, handleError, loadJobs, resetSheetViews],
  );

  // Deep-link: /cut?job=<id> opens that job (e.g. from the order show page
  // «Раскрой» column). The workspace keeps /cut mounted (keyed by pathname), so
  // subscribe to the /cut tab's stored path (updated by useTabSync on every query
  // change) rather than reading window.location once — otherwise a deep-link
  // clicked while /cut is already open would not reopen. Per-job-id one-shot:
  // opens when the parsed id changes to a new value. openJob loads ANY existing
  // job by id (getJob/loadJob do not filter archived) and shows it; a missing/
  // invalid id throws and is caught by openJob's handleError toast. The column
  // only links ready jobs, so the normal flow never deep-links archived — only a
  // stale/hand-edited URL can, and mutate controls are disabled for archived jobs
  // (isArchivedJob guard) so that is truly read-only.
  const storeDeepLinkJobId = parseJobQueryParam(
    cutTabPath && cutTabPath.includes('?') ? cutTabPath.slice(cutTabPath.indexOf('?')) : '',
  );
  // Cross-check against the LIVE url: the tab store rehydrates from sessionStorage
  // and is only rewritten by useTabSync after mount, so on a fresh /cut?job=45
  // load the store may briefly hold a stale persisted /cut path. Acting on it would
  // openJob(staleId) and then race openJob(45). Only honor the deep-link once the
  // store path's id agrees with the live url, so the stale value is skipped until
  // useTabSync catches up. window.location is a plain DOM read, not a router hook.
  const liveDeepLinkJobId = parseJobQueryParam(
    typeof window !== 'undefined' ? window.location.search : '',
  );
  const deepLinkJobId =
    storeDeepLinkJobId !== null && storeDeepLinkJobId === liveDeepLinkJobId ? storeDeepLinkJobId : null;
  const lastDeepLinkRef = useRef<number | null>(null);
  useEffect(() => {
    if (!can('cut.view')) return;
    if (deepLinkJobId === null) return;
    if (lastDeepLinkRef.current === deepLinkJobId) return;
    lastDeepLinkRef.current = deepLinkJobId;
    void openJob(deepLinkJobId);
  }, [deepLinkJobId, openJob]);

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
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      if (!job) return;
      // Cache key includes variant + renderVersion so toggling or re-saving never
      // serves a stale blob (Codex R7 BLOCKER #1, R9 MAJOR #2).
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${renderVersion ?? ''}`;
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(job.cutJobId, group.cutGroupId, sheetIndex, preset, rotate90, variant, renderVersion);
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
    [job, preset, sheetPortrait, handleError],
  );

  // Small layout preview for a ready job's sheet, fetched once with the light
  // 'thumb' preset. Deduped via thumbReqRef so the auto-load effect is idempotent.
  // variant + renderVersion are included in the key so toggling auto↔manual
  // or saving a new manual layout always fetches a fresh thumb (R9 MAJOR #2).
  const loadThumb = useCallback(
    async (cutJobId: number, group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${renderVersion ?? ''}`;
      const reqKey = `${cutJobId}:${key}`;
      if (thumbReqRef.current.has(reqKey)) return;
      thumbReqRef.current.add(reqKey);
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(cutJobId, group.cutGroupId, sheetIndex, 'thumb', rotate90, variant, renderVersion);
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
    [sheetPortrait],
  );

  // Auto-load per-sheet previews when a ready job's layout is present, so an
  // operator sees the cut result inline without clicking each sheet.
  // Passes the current per-group variant so toggling auto↔manual immediately
  // requests the correct thumb (variant changes cause the effect to re-run).
  useEffect(() => {
    if (!job || job.status !== 'ready') return;
    for (const group of job.groups) {
      const showAlt = showAlternativeByGroup[group.cutGroupId] ?? false;
      const groupVariant: 'auto' | 'manual' | 'active' = showAlt ? 'manual' : 'auto';
      const groupRenderVersion = group.renderToken;
      for (const sheet of group.sheets) {
        void loadThumb(job.cutJobId, group, sheet.sheetIndex, groupVariant, groupRenderVersion);
      }
    }
  }, [job, showAlternativeByGroup, loadThumb]);

  const downloadSheetSvg = useCallback(
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      if (!job) return;
      try {
        const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
        const rotate90 = sheet
          ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
          : sheetPortrait;
        const blob = await cutApi.fetchSheetSvg(job.cutJobId, group.cutGroupId, sheetIndex, rotate90, variant, renderVersion);
        triggerBlobDownload(blob, `cut-${job.cutJobId}-g${group.cutGroupId}-s${sheetIndex + 1}.svg`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить SVG');
      }
    },
    [job, sheetPortrait, handleError],
  );

  const downloadGroupPdf = useCallback(
    async (group: CutGroupDto) => {
      if (!job) return;
      setBusy(true);
      try {
        // Pass renderToken so a post-save PDF render-cache is busted (variant=active).
        const result = await pollPdf(() => cutApi.fetchGroupPdf(job.cutJobId, group.cutGroupId, sheetPortrait, group.renderToken));
        triggerBlobDownload(result.blob, result.fileName ?? `cut-group-${group.cutGroupId}.pdf`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить PDF группы');
      } finally {
        setBusy(false);
      }
    },
    [job, sheetPortrait, handleError],
  );

  const downloadJobPdf = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      // Pass renderToken so a post-save PDF render-cache is busted (variant=active).
      const result = await pollPdf(() => cutApi.fetchJobPdf(job.cutJobId, sheetPortrait, job.renderToken));
      triggerBlobDownload(result.blob, result.fileName ?? `cut-job-${job.cutJobId}.pdf`);
    } catch (error) {
      handleError(error, 'Не удалось выгрузить PDF раскроя');
    } finally {
      setBusy(false);
    }
  }, [job, sheetPortrait, handleError]);

  // ── Manual layout editor callbacks ─────────────────────────────────────────

  /**
   * Enter edit mode for a group: seed workingSheets from the non-stale manual
   * layout when one exists (isActive does NOT gate editability — a saved but
   * currently-hidden manual stays editable, Codex R17 BLOCKER #2). Falls back
   * to the auto sheets when manualLayout is absent or stale.
   */
  const enterEditMode = useCallback(
    (group: CutGroupDto) => {
      if (!job) return;
      const seed =
        group.manualLayout && !group.manualLayout.isStale
          ? group.manualLayout.sheets.map((s) => ({ sheetIndex: s.sheetIndex, placements: s.placements }))
          : group.sheets.map((s) => ({ sheetIndex: s.sheetIndex, placements: s.placements }));
      setWorkingSheets(seed);
      setViolations([]);
      setEditingGroupId(group.cutGroupId);
    },
    [job],
  );

  /**
   * Called by SheetEditor on every geometry change. Re-validates all sheets
   * and stores both the new working sheets and the fresh violation list.
   * Trim authority: uses placements.trim_mm (not editorParams), per brief §3.
   */
  const handleEditorChange = useCallback(
    (nextSheets: { sheetIndex: number; placements: SheetPlacements }[]) => {
      setWorkingSheets(nextSheets);
      if (!job?.editorParams) {
        setViolations([]);
        return;
      }
      const gap = { kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm };
      const filmTextureByItemId = buildFilmTextureMap(nextSheets, job.items);
      const newViolations = nextSheets.flatMap((s) =>
        validateSheetPlacements({
          sheetIndex: s.sheetIndex,
          placements: s.placements,
          gap,
          filmTextureByItemId,
        }),
      );
      setViolations(newViolations);
    },
    [job],
  );

  /**
   * Save the manual layout for a group: derives moves from workingSheets,
   * sends PATCH /manual-layout, refetches the job, and clears the editor.
   * resetSheetViews() ensures the next preview fetch is never served a stale
   * blob (Codex R7 / R9 — "manual already active → edit → save again" bust).
   */
  const saveManualLayoutForGroup = useCallback(
    async (group: CutGroupDto) => {
      if (!job || !job.editorParams) return;
      const moves = movesFromSheets(workingSheets);
      setBusy(true);
      try {
        // After a manual edit the saved layout becomes the active one and the
        // alternative (manual) view is shown by default (active: true + toggle on).
        const updated = await cutApi.saveManualLayout(job.cutJobId, group.cutGroupId, {
          jobVersion: job.version,
          active: true,
          placements: moves,
        });
        setJob(updated);
        setShowAlternativeByGroup((prev) => ({ ...prev, [group.cutGroupId]: true }));
        void loadJobs();
        resetSheetViews();
        setEditingGroupId(null);
        setWorkingSheets([]);
        setViolations([]);
      } catch (error) {
        // Surface 422 violations + 409 recalc/stale with the backend message.
        handleError(error, 'Не удалось сохранить ручной раскрой');
      } finally {
        setBusy(false);
      }
    },
    [job, workingSheets, loadJobs, handleError, resetSheetViews],
  );

  const filteredJobs = useMemo(() => filterJobsByStatus(jobs, statusFilter), [jobs, statusFilter]);

  // Memoized film-texture map for the active editor — avoids rebuilding a new Map
  // on every render in edit mode (the SheetEditor prop would otherwise change ref).
  const editorFilmTextureByItemId = useMemo(
    () => buildFilmTextureMap(workingSheets, job?.items ?? []),
    [workingSheets, job?.items],
  );

  // The group currently open in the editor (used to pass material/film target to SheetEditor).
  const editingGroup = useMemo(
    () => job?.groups.find((g) => g.cutGroupId === editingGroupId) ?? null,
    [job, editingGroupId],
  );

  // Per-piece material/film map for the cross-sheet move guard in SheetEditor.
  // Keyed by piece item_id format "det-<orderDetailId>".
  const pieceMetaByItemId = useMemo(() => {
    const m = new Map<string, { materialTypeId: number | null; filmId: number | null }>();
    for (const it of job?.items ?? []) {
      m.set(`det-${it.orderDetailId}`, {
        materialTypeId: it.detail?.sheetMaterialTypeId ?? null,
        filmId: it.detail?.filmId ?? null,
      });
    }
    return m;
  }, [job?.items]);

  // Memoized label-info map for the active editor: keyed by piece.item_id ("det-N"),
  // provides orderName, orderId, detailNumber and qty for the 3-line piece label.
  const editorLabelInfoByItemId = useMemo(() => {
    const map = new Map<string, { orderName: string | null; orderId: number | null; detailNumber: number | null; qty: number | null }>();
    for (const item of job?.items ?? []) {
      const key = `det-${item.orderDetailId}`;
      if (!map.has(key)) {
        map.set(key, {
          orderName: item.orderName ?? null,
          orderId: item.orderId,
          detailNumber: item.detail?.detailNumber ?? null,
          qty: item.qty ?? null,
        });
      }
    }
    return map;
  }, [job?.items]);

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

  // Dirty guard: any group has an active editor session OR its toggle differs
  // from the persisted isActive. While dirty, whole-job PDF is disabled.
  const anyGroupDirty =
    job != null &&
    job.groups.some((g) => {
      if (editingGroupId === g.cutGroupId) return true;
      if (!g.manualLayout) return false;
      return (showAlternativeByGroup[g.cutGroupId] ?? false) !== g.manualLayout.isActive;
    });

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
              .map((p) => ({ value: p.cutParamProfileId, label: (<Tooltip title={describeCutProfile(p.params)}>{resolveProfileLabel(p.cutParamProfileId, profiles, cutSettings)}</Tooltip>) }));
            const chosen = job.paramProfileId;
            const chosenInactive = chosen !== null && !profiles.some((p) => p.cutParamProfileId === chosen && p.isActive);
            const chosenInactiveProfile = chosenInactive ? profiles.find((p) => p.cutParamProfileId === chosen) : undefined;
            const profileOptions = chosenInactive
              ? [...activeOptions, { value: chosen, label: (<Tooltip title={describeCutProfile(chosenInactiveProfile?.params ?? {})}>{resolveProfileLabel(chosen, profiles, cutSettings)}</Tooltip>), disabled: true }]
              : activeOptions;
            return (
              <>
                <Space size="large" style={{ marginBottom: 12 }} wrap>
                  <span>Позиции: <b>{job.totals.positions}</b></span>
                  <span>Деталей: <b>{job.totals.details}</b></span>
                  <span>Материалов: <b>{job.totals.materialsCount}</b></span>
                  <span>Плёнок: <b>{job.totals.filmsCount}</b></span>
                  <span>Площадь, итого: <b>{formatArea(job.totals.area)}</b></span>
                  {job.status === 'ready' && <span>Листов раскроя: <b>{job.totals.sheets}</b></span>}
                </Space>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 12 }}>
                  <div>
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
                      <div style={{ marginTop: 4, color: '#ad8b00', whiteSpace: 'nowrap' }}>
                        изменение профиля применится после команды «Рассчитать»
                      </div>
                    )}
                  </div>
                  {(() => {
                    const jobMt = jobMaterialTypeIds(job.items.map((i) => i.detail?.sheetMaterialTypeId ?? null), sheetOptions);
                    const { preferred, others } = partitionSheetOptions(sheetOptions, jobMt);
                    const grouped = [
                      // Explicit default = clear the override so detail materials are used
                      // (in addition to the field's ✕ clear). Re-enables «Разделять по материалу».
                      { value: null as number | null, label: 'Как у деталей (по умолчанию)' },
                      ...(preferred.length ? [{ label: 'Материал деталей', options: preferred.map((o) => ({ value: o.sheetMaterialTypeId, label: formatSheetOptionLabel(o) })) }] : []),
                      ...(others.length ? [{ label: 'Другие листы', options: others.map((o) => ({ value: o.sheetMaterialTypeId, label: formatSheetOptionLabel(o) })) }] : []),
                    ];
                    const mixed = isMixedMaterialSelection(job.sheetMaterialTypeId, sheetOptions, jobMt);
                    return (
                      <div>
                        <span style={{ marginRight: 8 }}>Лист раскроя:</span>
                        <Select<number | null>
                          value={job.sheetMaterialTypeId}
                          onChange={(v) => void setJobSheetMaterial(v ?? null)}
                          disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                          style={{ minWidth: 280 }}
                          placeholder="Как у деталей"
                          allowClear
                          options={grouped}
                        />
                        {mixed && !job.splitByMaterial && (
                          <Alert
                            type="warning"
                            showIcon
                            style={{ marginTop: 8, maxWidth: 360 }}
                            message="«Разделять по материалу» выключено: все детали разных материалов будут раскроены на одном выбранном листе"
                          />
                        )}
                      </div>
                    );
                  })()}
                </div>
                <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', alignItems: 'center', marginBottom: 12 }}>
                  <div>
                    <Tooltip title="разные материалы кроятся отдельными группами; выключите, чтобы раскроить все детали вместе в одной группе; применится после команды «Рассчитать»">
                      <Checkbox
                        checked={job.splitByMaterial}
                        onChange={(e) => void setJobSplitByMaterial(e.target.checked)}
                        disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob || job.sheetMaterialTypeId != null}
                      >
                        Разделять по материалу
                      </Checkbox>
                    </Tooltip>
                    {job.sheetMaterialTypeId != null && (
                      <div style={{ color: '#fa8c16', fontSize: 12, marginTop: 2, maxWidth: 280 }}>
                        Весь раскрой на выбранном листе.
                      </div>
                    )}
                  </div>
                  <div>
                    <Tooltip title="детали одного материала с разными плёнками кроятся вместе; применится после команды «Рассчитать»">
                      <Checkbox
                        checked={job.combineFilms}
                        onChange={(e) => void setJobCombineFilms(e.target.checked)}
                        disabled={!canManage || busy || job.status === 'calculating' || isArchivedJob}
                      >
                        Объединить разные плёнки
                      </Checkbox>
                    </Tooltip>
                  </div>
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
              <Tooltip
                title={
                  anyGroupDirty
                    ? 'несохранённые изменения'
                    : (job.requiresRecalc ?? false)
                    ? 'требуется пересчёт'
                    : undefined
                }
              >
                <Button
                  onClick={downloadJobPdf}
                  loading={busy}
                  disabled={anyGroupDirty || (job.requiresRecalc ?? false)}
                >
                  Скачать PDF (весь раскрой)
                </Button>
              </Tooltip>
            )}
          </Space>
        </Card>
      )}

      {job && (
        <Collapse size="small" defaultActiveKey={[]}>
          <Panel header={`Детали задания (${job.items.length})`} key="cut-job-details">
            <TableTopScroll>
              <Table<CutJobItemDto>
                size="small"
                rowKey="cutJobItemId"
                columns={jobItemColumns}
                dataSource={job.items}
                pagination={false}
                scroll={{ x: 1900 }}
                locale={{ emptyText: 'В задании пока нет деталей — добавьте их из заказа или через «Загрузить подходящие детали»' }}
              />
            </TableTopScroll>
          </Panel>
        </Collapse>
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

      {job && job.groups.length > 0 && (
        <Checkbox checked={sheetPortrait} onChange={(e) => toggleSheetPortrait(e.target.checked)}>
          Книжная ориентация листа (вертикально) — снимите для альбомной
        </Checkbox>
      )}

      {job?.groups.map((group) => {
        // Readable group title: «Раскрой: <материал> · N листов» (fallback to id).
        const matName = sheetOptions.find((o) => o.sheetMaterialTypeId === group.sheetMaterialTypeId)?.name;
        const filmNames = groupFilmNames(job, group);
        const filmText = filmNames.length > 0 ? filmNames.join(', ') : null;
        const filmLabel = filmNames.length > 1 ? 'Плёнки' : 'Плёнка';
        const title = matName
          ? `Раскрой: ${matName} · ${group.sheets.length} л.`
          : `Группа #${group.cutGroupId}`;

        // ── Per-group manual-layout state ───────────────────────────────────
        // Current toggle value (operator choice, not yet persisted).
        const showAlt = showAlternativeByGroup[group.cutGroupId] ?? false;
        // effectiveManual: which variant the preview/print actually shows.
        // isActive drives PRINT; isStale means the pieces drifted (recalc needed).
        const effectiveManual = !!(group.manualLayout?.isActive && !group.manualLayout?.isStale);
        // Render token for cache-busting (absent on groups without a manual layout).
        const renderVersion = group.renderToken;
        // Stale: the manual layout pieces may not match the current auto set.
        // (Declared before displayVariant below, which reads it.)
        const isStale = group.manualLayout?.isStale ?? false;
        // Variant to pass to PNG/SVG fetch so the preview matches the toggle.
        // Guard: when the manual layout is stale, never pass variant=manual — the backend
        // hard-fails such requests with 409 CUT_MANUAL_LAYOUT_UNAVAILABLE. Fall back to 'auto'.
        const displayVariant: 'auto' | 'manual' | 'active' = showAlt && !isStale ? 'manual' : 'auto';
        // Is this group currently open in the editor?
        const isEditingGroup = editingGroupId === group.cutGroupId;
        // Persisted active flag (what the backend currently has).
        const persistedActive = group.manualLayout?.isActive ?? false;
        // Group is dirty when: in edit mode OR toggle differs from persisted isActive.
        const isDirtyGroup =
          isEditingGroup ||
          (group.manualLayout != null && showAlt !== persistedActive);
        // Edit is blocked when editorParams are absent or a recalc is required.
        const editDisabled = !(job.editorParams) || (job.requiresRecalc ?? false);
        // Preview sheets: honour displayVariant so count/overlays follow the
        // manual layout when the operator has switched to the manual view.
        const previewSheets = selectVariantSheets(group, displayVariant);

        return (
          <Card
            key={group.cutGroupId}
            size="small"
            // Sticky group header: keeps the group name, «устарел» badge,
            // «Редактировать раскрой» and «Скачать PDF» on screen while the
            // operator scrolls through a tall group with many sheets.
            headStyle={{
              position: 'sticky',
              top: 0,
              zIndex: 5,
              background: token.colorBgContainer,
            }}
            title={
              <Space size="small">
                {title}
                {/* «устарел» badge: the auto layout needs a recalc, OR the ACTIVE
                    manual layout has drifted stale. An INACTIVE stale manual (not
                    shown/printed) must NOT flag the group — otherwise «Рассчитать»
                    can never clear the badge while a dangling old manual exists. */}
                {((job.requiresRecalc ?? false) || (isStale && persistedActive)) && (
                  <Tag color="warning">устарел</Tag>
                )}
                {effectiveManual && !isStale && (
                  <Tag color="blue">ручной раскрой активен</Tag>
                )}
              </Space>
            }
            extra={
              <Space>
                {/* «Показать альтернативный раскрой» — only shown when a manual layout exists.
                    Disabled (with tooltip) when the layout is stale: variant=manual would 409. */}
                {group.manualLayout && (
                  <Tooltip title={isStale ? 'Ручной раскрой устарел — пересчитайте' : undefined}>
                    <Checkbox
                      checked={showAlt}
                      onChange={(e) =>
                        setShowAlternativeByGroup((prev) => ({
                          ...prev,
                          [group.cutGroupId]: e.target.checked,
                        }))
                      }
                      disabled={isEditingGroup || isStale}
                      data-testid={`show-alternative-cb-${group.cutGroupId}`}
                    >
                      Показать альтернативный раскрой
                    </Checkbox>
                  </Tooltip>
                )}
                {/* «Редактировать раскрой» — full-scale group view only; disabled on requiresRecalc */}
                {canManage && !isArchivedJob && (
                  <Tooltip
                    title={
                      (job.requiresRecalc ?? false)
                        ? 'Требуется пересчёт'
                        : !(job.editorParams)
                        ? 'Редактор недоступен'
                        : undefined
                    }
                  >
                    <Button
                      className="app-hit-area-sm"
                      size="small"
                      onClick={() => enterEditMode(group)}
                      disabled={editDisabled || busy || isEditingGroup}
                      data-testid={`edit-layout-btn-${group.cutGroupId}`}
                    >
                      Редактировать раскрой
                    </Button>
                  </Tooltip>
                )}
                {/* «Скачать PDF» — disabled while dirty or requiresRecalc */}
                <Tooltip
                  title={
                    isDirtyGroup
                      ? 'несохранённые изменения'
                      : (job.requiresRecalc ?? false)
                      ? 'требуется пересчёт'
                      : undefined
                  }
                >
                  <Button
                    className="app-hit-area-sm"
                    size="small"
                    onClick={() => void downloadGroupPdf(group)}
                    loading={busy}
                    disabled={isDirtyGroup || (job.requiresRecalc ?? false)}
                    data-testid={`download-group-pdf-btn-${group.cutGroupId}`}
                  >
                    Скачать PDF
                  </Button>
                </Tooltip>
              </Space>
            }
          >
            <Text type="secondary">{formatGroupSummary(group.summary)}</Text>
            <div style={{ marginTop: 4, color: '#595959', fontSize: 13 }}>
              Материал раскроя: <b>{matName ?? 'не задан'}</b>
              {filmText && (
                <>
                  {' '}· {filmLabel}: <b>{filmText}</b>
                </>
              )}
            </div>

            {/* ── Editor mode ────────────────────────────────────────────────── */}
            {isEditingGroup && job.editorParams && (
              <div style={{ marginTop: 12 }}>
                <Space style={{ marginBottom: 8 }}>
                  <Tooltip title={violations.length > 0 ? `${violations.length} нарушений геометрии` : undefined}>
                    <Button
                      type="primary"
                      size="small"
                      disabled={violations.length > 0 || (job.requiresRecalc ?? false) || busy}
                      onClick={() => void saveManualLayoutForGroup(group)}
                      loading={busy}
                      data-testid="save-manual-layout-btn"
                    >
                      Сохранить изменения
                    </Button>
                  </Tooltip>
                  <Button
                    size="small"
                    onClick={() => {
                      setEditingGroupId(null);
                      setWorkingSheets([]);
                      setViolations([]);
                    }}
                    disabled={busy}
                    data-testid="cancel-edit-btn"
                  >
                    Отменить редактирование
                  </Button>
                  {violations.length > 0 && (
                    <Text type="danger">{violations.length} нарушений геометрии — исправьте перед сохранением</Text>
                  )}
                </Space>
                <SheetEditor
                  sheets={workingSheets}
                  gap={{ kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm }}
                  filmTextureByItemId={editorFilmTextureByItemId}
                  labelInfoByItemId={editorLabelInfoByItemId}
                  landscape={!sheetPortrait}
                  onChange={handleEditorChange}
                  violations={violations}
                  splitByMaterial={job.splitByMaterial}
                  combineFilms={job.combineFilms}
                  groupMaterialTypeId={editingGroup?.sheetMaterialTypeId ?? null}
                  groupFilmId={editingGroup?.filmId ?? null}
                  pieceMetaByItemId={pieceMetaByItemId}
                />
              </div>
            )}

            {/* ── Normal sheet previews (hidden while in editor mode) ─────────── */}
            {!isEditingGroup && (
              /* Previews flow in wrapping rows (not a single column). */
              <div style={sheetPreviewListStyle}>
                {previewSheets.map((sheet) => {
                  // Cache key includes variant + renderVersion so toggling auto↔manual
                  // or saving a new manual never serves a stale blob (R7/R9 fix).
                  const key = `${group.cutGroupId}:${sheet.sheetIndex}:${displayVariant}:${renderVersion ?? ''}`;
                  // Stable React element identity per (group, sheet) — deliberately NOT
                  // the cache key. A renderVersion bump (e.g. changing profile/material,
                  // which only marks the job stale) then refreshes the image in place
                  // instead of unmounting/remounting the whole preview row, which used to
                  // collapse the list and bounce the page scroll down-then-back.
                  const elemKey = `${group.cutGroupId}:${sheet.sheetIndex}`;
                  const widthMm = sheet.placements.sheet_width_mm;
                  const heightMm = sheet.placements.sheet_height_mm;
                  const rotate90 = sheetPreviewRotate90(widthMm, heightMm, sheetPortrait);
                  const overlays = buildSheetPieceOverlays(sheet.placements, job.items, rotate90);
                  const sheetDetailIds = detailIdsForSheet(sheet);
                  return (
                    <div
                      key={elemKey}
                      style={
                        // Open (enlarged) sheet spans the full previews row so the
                        // image can grow ~2× instead of being capped by the thumbnail
                        // column width.
                        sheetImages[key]
                          ? { flex: '1 1 100%', maxWidth: '100%' }
                          : sheetPreviewItemStyle(widthMm, heightMm, rotate90)
                      }
                    >
                      <div className="cut-sheet-preview-header">
                        <div className="cut-sheet-preview-title app-tabular">
                          <strong>Лист {sheet.sheetIndex + 1}</strong>
                          {' · '}
                          {matName ?? 'материал не задан'}
                          {filmText ? ` · ${filmLabel}: ${filmText}` : ''}
                          {' · '}
                          кол-во деталей - {sheet.placements.pieces.length}
                        </div>
                        <Space className="cut-sheet-preview-actions" size={8}>
                          <Button
                            className="app-hit-area-sm"
                            size="small"
                            onClick={() =>
                              sheetImages[key]
                                ? collapseSheet(key)
                                : loadSheet(group, sheet.sheetIndex, displayVariant, renderVersion)
                            }
                          >
                            {sheetImages[key] ? 'Свернуть' : 'Развернуть'}
                          </Button>
                          <Button
                            className="app-hit-area-sm"
                            size="small"
                            onClick={() => downloadSheetSvg(group, sheet.sheetIndex, displayVariant, renderVersion)}
                          >
                            SVG
                          </Button>
                          <CutSheetLabelGenerateAction
                            detailIds={sheetDetailIds}
                            cutJobId={job.cutJobId}
                            cutGroupId={group.cutGroupId}
                            sheetIndex={sheet.sheetIndex}
                          />
                        </Space>
                      </div>
                      {sheetThumbs[key] && !sheetImages[key] && (
                        <SheetPreview
                          src={sheetThumbs[key]}
                          alt={`Превью листа ${sheet.sheetIndex + 1}`}
                          widthMm={widthMm}
                          heightMm={heightMm}
                          landscape={rotate90}
                          full={false}
                          overlays={overlays}
                          onOpen={() => loadSheet(group, sheet.sheetIndex, displayVariant, renderVersion)}
                        />
                      )}
                      {sheetImages[key] && (
                        <SheetPreview
                          src={sheetImages[key]}
                          alt={`Лист ${sheet.sheetIndex + 1}`}
                          widthMm={widthMm}
                          heightMm={heightMm}
                          landscape={rotate90}
                          full
                          overlays={overlays}
                          onCollapse={() => collapseSheet(key)}
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </Card>
        );
      })}
    </Space>
  );
};
