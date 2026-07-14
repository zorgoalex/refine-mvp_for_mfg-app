import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  Alert,
  Button,
  Card,
  Checkbox,
  Collapse,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Tooltip,
  Typography,
  message,
  theme,
} from 'antd';
import type { ColumnsType } from 'antd/es/table';
import { MinusOutlined, PlusOutlined, UndoOutlined, UpOutlined } from '@ant-design/icons';
import { useNavigation } from '@refinedev/core';
import { cutApi } from '../../api/cutApi';
import { cutConfigApi } from '../../api/cutConfigApi';
import type { CutParamProfile, CutPdfTemplate, CutSettingRow } from '../../api/cutConfigApi';
import { ApiError } from '../../api/httpClient';
import { resolveProfileLabel, formatArea, describeCutProfile } from './cutProfileHelpers';
import { jobMaterialTypeIds, partitionSheetOptions, isMixedMaterialSelection, formatSheetOptionLabel } from './cutSheetSelectHelpers';
import { buildSheetPieceOverlays, loadSheetOrientationPortrait, saveSheetOrientationPortrait, loadSheetOriginTopLeft, loadSheetAxisOrigin, saveSheetAxisOrigin, selectVariantSheets } from './cutPreviewHelpers';
import { TableTopScroll } from '../../components/TableTopScroll';
import { SheetPreview } from './SheetPreview';
import { SheetEditor } from './SheetEditor';
import { buildPieceMetaByItemId } from './cutPieceMeta';
import { pushHistory } from './editorHistory';
import { CutSheetLabelGenerateAction } from './CutSheetLabelGenerateAction';
import { authSession } from '../../api/authSession';
import type {
  CutGroupDto,
  CutJobDto,
  CutJobItemDto,
  EligibleDetailDto,
  SheetPlacements,
} from '../../api/types/cutApi.types';
import { validateSheetPlacements, validateSheetGroupInvariant, movesFromSheets } from './cutLayoutGeometry';
import type { CutAxisOrigin, ManualViolation } from './cutLayoutGeometry';
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
  pruneEmptySheets,
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

const DEFAULT_PDF_TEMPLATE_OPTIONS = [
  { value: 'standard', label: 'Стандартный' },
  { value: 'bath_profiles', label: 'Профили ванны' },
];

const { Title, Text } = Typography;

type PdfPreviewState = {
  open: boolean;
  group: CutGroupDto | null;
  title: string;
  loading: boolean;
  url: string | null;
  blob: Blob | null;
  fileName: string | null;
};

const EMPTY_PDF_PREVIEW: PdfPreviewState = {
  open: false,
  group: null,
  title: 'Предпросмотр PDF',
  loading: false,
  url: null,
  blob: null,
  fileName: null,
};

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

const CUT_JOBS_TABLE_CONTAINER_HEIGHT = 317;
const MIN_EDITOR_VIEW_ZOOM = 0.25;
const MAX_EDITOR_VIEW_ZOOM = 1.5;
const EDITOR_VIEW_ZOOM_STEP = 0.25;

const sheetPreviewListStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'row',
  flexWrap: 'wrap',
  alignItems: 'flex-start',
  gap: 16,
  marginTop: 8,
};

const cutActionToolbarStyle: React.CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  alignItems: 'center',
  gap: 8,
};

// Fixed «Наверх» button: appears as soon as the page has been scrolled
// vertically and stays visible (view mode and manual editor alike). zIndex
// stays below antd modals (1000).
const backToTopFixedStyle: React.CSSProperties = {
  position: 'fixed',
  bottom: 24,
  right: 24,
  zIndex: 900,
};

const pdfTemplatePickerStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 6,
  flex: '0 0 auto',
  minWidth: 260,
};

const pdfTemplateLabelStyle: React.CSSProperties = {
  whiteSpace: 'nowrap',
};

function sheetPreviewRotate90(widthMm: number, heightMm: number, portrait: boolean): boolean {
  if (widthMm === heightMm) return false;
  return portrait ? widthMm > heightMm : widthMm < heightMm;
}

function SheetOrientationIcon({ portrait }: { portrait: boolean }): React.ReactElement {
  return (
    <span
      className={`cut-sheet-control-icon cut-sheet-control-icon--${portrait ? 'portrait' : 'landscape'}`}
      aria-hidden="true"
    />
  );
}

function SheetOriginIcon({ axisOrigin }: { axisOrigin: CutAxisOrigin }): React.ReactElement {
  return (
    <span className="cut-sheet-origin-icon" aria-hidden="true">
      <span className={`cut-sheet-origin-dot cut-sheet-origin-dot--${axisOrigin}`} />
    </span>
  );
}

function effectiveSheetOrigin(
  placements: SheetPlacements | undefined,
  legacyOriginTopLeft: boolean,
  axisOrigin: CutAxisOrigin,
): boolean {
  if (axisOrigin === 'bottom-left') return false;
  return placements?.coordinate_contract === 'native_portrait_v1' ? false : legacyOriginTopLeft;
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

function editableSheetsForGroup(group: CutGroupDto): { sheetIndex: number; placements: SheetPlacements }[] {
  return group.manualLayout && !group.manualLayout.isStale
    ? group.manualLayout.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }))
    : group.sheets.map((sheet) => ({ sheetIndex: sheet.sheetIndex, placements: sheet.placements }));
}

/** Revoke every blob object URL in a key->url map (leak guard on reset/unmount). */
const revokeObjectUrls = (map: Record<string, string>): void => {
  Object.values(map).forEach((url) => URL.revokeObjectURL(url));
};

function formatJobMaterialNames(materialNames: string[] | undefined): string {
  const names = (materialNames ?? []).map((name) => name.trim()).filter(Boolean);
  return names.length > 0 ? names.join(', ') : '—';
}

/**
 * Backend-owned /cut page (CLAUDE.md principle 2/3): all reads and commands go
 * through cutApi (`/api/v1/cut-jobs`); the read-layer is never written from here.
 * Flow: criteria -> draft job -> eligible details (no_sheet_spec surfaced) ->
 * basket -> calculate -> per-sheet PNG.
 */
interface CutPageProps {
  embeddedOrderId?: number;
}

export const CutPage: React.FC<CutPageProps> = ({ embeddedOrderId }) => {
  const canManage = can('cut.manage');
  const isEmbeddedOrder = Number.isInteger(embeddedOrderId) && (embeddedOrderId ?? 0) > 0;
  // Theme-aware bg for the sticky group header (app uses AntD dark/default
  // algorithm, no CSS vars — read the token directly).
  const { token } = theme.useToken();
  // The sticky group header must sit BELOW the global sticky workspace tab-bar
  // (.workspace-tabs, top:0 z-index:20) — otherwise it pins under the tabs and
  // gets obscured. Measure the tab-bar height at runtime (it has a dynamic
  // 20px gap border) and offset the header by it. Falls back to 0 when the cut
  // page is not rendered inside the workspace tabs.
  const [stickyHeaderTop, setStickyHeaderTop] = useState(0);
  useEffect(() => {
    let ro: ResizeObserver | null = null;
    // Attach a ResizeObserver to the tab-bar once it exists. WorkspaceTabs renders
    // null until the current tab is opened (useTabSync), so on a cold /cut load the
    // bar mounts LATE — a one-shot querySelector would miss it and leave the offset
    // at 0 (overlap bug). Watch the DOM until the bar appears, then measure + observe.
    const attach = (): boolean => {
      const tabs = document.querySelector('.workspace-tabs');
      if (!tabs) return false;
      const measure = () => setStickyHeaderTop(tabs.getBoundingClientRect().height);
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(tabs);
      return true;
    };
    if (attach()) return () => ro?.disconnect();
    const mo = new MutationObserver(() => {
      if (attach()) mo.disconnect();
    });
    mo.observe(document.body, { childList: true, subtree: true });
    return () => {
      mo.disconnect();
      ro?.disconnect();
    };
  }, []);
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
  // Per-user, per-job origin anchor for the rotated (portrait) render: when true
  // (default) the dense cluster sits at the view's top-left (transpose); when
  // false it keeps the legacy 90° CW top-right. Persisted in localStorage.
  const [sheetOriginTopLeft, setSheetOriginTopLeft] = useState(true);
  const [sheetAxisOrigin, setSheetAxisOrigin] = useState<CutAxisOrigin>('bottom-left');
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

  // Load this user's saved orientation + origin for the opened job (default
  // portrait, origin top-left).
  useEffect(() => {
    if (!job) return;
    const uid = authSession.getUser()?.id ?? 'anon';
    setSheetPortrait(loadSheetOrientationPortrait(uid, job.cutJobId));
    setSheetOriginTopLeft(loadSheetOriginTopLeft(uid, job.cutJobId));
    setSheetAxisOrigin(loadSheetAxisOrigin(uid, job.cutJobId));
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

  // Toggle + persist origin anchor; like the orientation toggle, origin is NOT a
  // local blob-cache key dimension, so drop ALL cached previews (revoke blobs +
  // bump epoch + clear thumb dedup) so stale opposite-origin PNGs/thumbs cannot
  // linger on screen and every sheet re-fetches with the new `origin=` URL.
  const changeSheetAxisOrigin = useCallback(
    (axisOrigin: CutAxisOrigin) => {
      setSheetAxisOrigin(axisOrigin);
      if (job) {
        const uid = authSession.getUser()?.id ?? 'anon';
        saveSheetAxisOrigin(uid, job.cutJobId, axisOrigin);
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
  const [pdfTemplateOptions, setPdfTemplateOptions] = useState(DEFAULT_PDF_TEMPLATE_OPTIONS);
  const [pdfTemplateForJob, setPdfTemplateForJob] = useState('standard');
  const [profiles, setProfiles] = useState<CutParamProfile[]>([]);
  const [cutSettings, setCutSettings] = useState<CutSettingRow[]>([]);
  const [jobs, setJobs] = useState<CutJobDto[]>([]);
  const [embeddedJobIds, setEmbeddedJobIds] = useState<Set<number> | null>(null);
  const [jobsLoading, setJobsLoading] = useState(false);
  const [statusFilter, setStatusFilter] = useState<string>(CUT_JOB_STATUS_FILTER_ALL);

  // ── Manual layout editor state ──────────────────────────────────────────────
  // The group currently open for editing (null = no editor active).
  const [editingGroupId, setEditingGroupId] = useState<number | null>(null);
  // Working sheets for the active editor (seeded from manualLayout or auto sheets).
  const [workingSheets, setWorkingSheets] = useState<{ sheetIndex: number; placements: SheetPlacements }[]>([]);
  // Current geometry violations (empty = all clear, save enabled).
  const [violations, setViolations] = useState<ManualViolation[]>([]);
  const [editorViewZoom, setEditorViewZoom] = useState(1);
  // Undo stack of workingSheets snapshots (one per committed drag/rotate),
  // capped at EDITOR_UNDO_LIMIT. Cleared on enter/cancel/save.
  const [editorHistory, setEditorHistory] = useState<{ sheetIndex: number; placements: SheetPlacements }[][]>([]);
  // «Наверх» visibility: shown as soon as the page has vertical scroll offset.
  const [showBackToTop, setShowBackToTop] = useState(false);

  useEffect(() => {
    // User requirement: the button appears as soon as ANY vertical scroll is
    // engaged (not after a threshold), and hides again at the very top.
    const onScroll = () => setShowBackToTop(window.scrollY > 0);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  /**
   * Scroll back to the relevant group header: the group being edited, else the
   * group card the viewport is currently inside (nearest header at/above the
   * top edge), else the page top.
   */
  const scrollBackToGroupTop = useCallback(() => {
    let targetId: number | null = editingGroupId;
    if (targetId == null) {
      // A card whose header is at/above the measured sticky stack is the one
      // the viewport is currently inside; among those take the lowest. Use the
      // dynamic stickyHeaderTop (not a literal) + a small tolerance so the
      // heuristic tracks whatever the workspace chrome actually occupies.
      const viewportTopEdge = stickyHeaderTop + 16;
      let bestTop = Number.NEGATIVE_INFINITY;
      for (const g of job?.groups ?? []) {
        const el = document.getElementById(`cut-group-card-${g.cutGroupId}`);
        if (!el) continue;
        const top = el.getBoundingClientRect().top;
        if (top <= viewportTopEdge && top > bestTop) {
          bestTop = top;
          targetId = g.cutGroupId;
        }
      }
    }
    const el = targetId != null ? document.getElementById(`cut-group-card-${targetId}`) : null;
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } else {
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [editingGroupId, job, stickyHeaderTop]);
  // Per-group alternative-view toggle: true = show manual variant, false = show auto.
  // Initialised from group.manualLayout.isActive on job open; only persisted on Save.
  const [showAlternativeByGroup, setShowAlternativeByGroup] = useState<Record<number, boolean>>({});
  const [pdfTemplateByGroup, setPdfTemplateByGroup] = useState<Record<number, string>>({});
  const [pdfPreview, setPdfPreview] = useState<PdfPreviewState>(EMPTY_PDF_PREVIEW);
  const pdfPreviewUrlRef = useRef<string | null>(null);
  const pdfPreviewRequestSeqRef = useRef(0);

  const revokePdfPreviewUrl = useCallback(() => {
    if (pdfPreviewUrlRef.current) {
      URL.revokeObjectURL(pdfPreviewUrlRef.current);
      pdfPreviewUrlRef.current = null;
    }
  }, []);

  useEffect(() => () => revokePdfPreviewUrl(), [revokePdfPreviewUrl]);

  const applyPdfTemplateState = useCallback((nextJob: CutJobDto) => {
    setPdfTemplateForJob(nextJob.pdfTemplate ?? 'standard');
    setPdfTemplateByGroup(Object.fromEntries(nextJob.groups.map((group) => [group.cutGroupId, group.pdfTemplate ?? 'standard'])));
  }, []);

  // Render presets and cut profiles are config-driven (/configuration "Раскрой").
  // Load active names from the backend, falling back to the built-ins.
  const loadCutConfig = useCallback(async () => {
    try {
      const cfg = await cutConfigApi.get();
      const options = cfg.renderPresets
        .filter((p) => p.isActive)
        .map((p) => ({ value: p.name, label: p.name }));
      if (options.length > 0) setPresetOptions(options);
      const pdfOptions = (cfg.pdfTemplates ?? [])
        .filter((p: CutPdfTemplate) => p.isActive)
        .map((p) => ({ value: p.code, label: p.name }));
      if (pdfOptions.length > 0) setPdfTemplateOptions(pdfOptions);
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
      orderIds: isEmbeddedOrder ? [embeddedOrderId!] : parseIdCsv(values.orderIds ?? ''),
      sheetMaterialTypeIds,
      filmIds: parseIdCsv(values.filmIds ?? ''),
    };
  }, [embeddedOrderId, form, isEmbeddedOrder]);

  const handleError = useCallback((error: unknown, fallback: string) => {
    const text = error instanceof ApiError ? error.message : fallback;
    message.error(text);
  }, []);

  const loadJobs = useCallback(async () => {
    setJobsLoading(true);
    try {
      const [nextJobs, placements] = await Promise.all([
        cutApi.list(),
        isEmbeddedOrder ? cutApi.listPlacements({ orderIds: [embeddedOrderId!] }) : Promise.resolve(null),
      ]);
      setJobs(nextJobs);
      setEmbeddedJobIds(placements ? new Set(placements.jobs.map((ref) => ref.cutJobId)) : null);
    } catch (error) {
      handleError(error, 'Не удалось загрузить список раскроев');
    } finally {
      setJobsLoading(false);
    }
  }, [embeddedOrderId, handleError, isEmbeddedOrder]);

  useEffect(() => {
    if (!isEmbeddedOrder) return;
    form.setFieldsValue({ orderIds: String(embeddedOrderId) });
  }, [embeddedOrderId, form, isEmbeddedOrder]);

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
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить профиль раскроя');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, loadJobs, handleError],
  );

  const setJobSheetMaterial = useCallback(
    async (sheetMaterialTypeId: number | null) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSheetMaterial(job.cutJobId, sheetMaterialTypeId, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить лист раскроя');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobCombineFilms = useCallback(
    async (combineFilms: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setCombineFilms(job.cutJobId, combineFilms, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить объединение плёнок');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobSplitByMaterial = useCallback(
    async (splitByMaterial: boolean) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.setSplitByMaterial(job.cutJobId, splitByMaterial, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось изменить разделение по материалу');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, handleError, loadJobs],
  );

  const setJobPdfTemplate = useCallback(
    async (pdfTemplate: string) => {
      if (!job) return;
      const previous = pdfTemplateForJob;
      setPdfTemplateForJob(pdfTemplate);
      try {
        const updated = await cutApi.setJobPdfTemplate(job.cutJobId, pdfTemplate);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        setPdfTemplateForJob(previous);
        handleError(error, 'Не удалось сохранить шаблон PDF раскроя');
      }
    },
    [applyPdfTemplateState, job, pdfTemplateForJob, handleError, loadJobs],
  );

  const setGroupPdfTemplate = useCallback(
    async (group: CutGroupDto, pdfTemplate: string) => {
      if (!job) return;
      const previous = pdfTemplateByGroup[group.cutGroupId] ?? group.pdfTemplate ?? 'standard';
      setPdfTemplateByGroup((prev) => ({ ...prev, [group.cutGroupId]: pdfTemplate }));
      try {
        const updated = await cutApi.setGroupPdfTemplate(job.cutJobId, group.cutGroupId, pdfTemplate);
        setJob(updated);
        applyPdfTemplateState(updated);
        void loadJobs();
      } catch (error) {
        setPdfTemplateByGroup((prev) => ({ ...prev, [group.cutGroupId]: previous }));
        handleError(error, 'Не удалось сохранить шаблон PDF группы');
      }
    },
    [applyPdfTemplateState, job, pdfTemplateByGroup, handleError, loadJobs],
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
        applyPdfTemplateState(fresh);
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
        setEditorHistory([]);
        // Prefill the eligible-load criteria with the order(s) this job was built
        // from (the reserved items' orders) so "Загрузить подходящие детали" is
        // scoped to those orders instead of scanning everything. Material/film
        // filters are cleared to avoid stale criteria leaking from a prior job.
        const orderIds = isEmbeddedOrder ? [embeddedOrderId!] : distinctOrderIdsFromItems(fresh.items);
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
    [embeddedOrderId, form, handleError, isEmbeddedOrder, loadJobs, resetSheetViews],
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
      applyPdfTemplateState(created);
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
  }, [applyPdfTemplateState, form, criteriaFromForm, loadJobs, handleError, resetSheetViews]);

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
      applyPdfTemplateState(updated);
      message.success('Детали добавлены в раскрой');
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось добавить детали');
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, job, selected, loadJobs, handleError]);

  const removeJobItem = useCallback(
    async (cutJobItemId: number) => {
      if (!job) return;
      setBusy(true);
      try {
        const updated = await cutApi.removeItem(job.cutJobId, cutJobItemId, job.version);
        setJob(updated);
        applyPdfTemplateState(updated);
        message.success('Деталь убрана из раскроя');
        await loadJobs();
      } catch (error) {
        handleError(error, 'Не удалось убрать деталь');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, loadJobs, handleError],
  );

  const calculate = useCallback(async () => {
    if (!job) return;
    setBusy(true);
    try {
      const calculated = await cutApi.calculate(job.cutJobId, job.version);
      setJob(calculated);
      applyPdfTemplateState(calculated);
      resetSheetViews();
      message.success('Раскрой рассчитан');
      await loadJobs();
    } catch (error) {
      handleError(error, 'Не удалось рассчитать раскрой');
      // Reload so the now-failed job shows its persisted reason (Alert) and a
      // fresh version for an immediate retry — the failure bumped the version
      // server-side, so the stale in-memory job would otherwise 409 on retry.
      try {
        const fresh = await cutApi.get(job.cutJobId);
        setJob(fresh);
        applyPdfTemplateState(fresh);
        await loadJobs();
      } catch {
        // best-effort refresh; the toast already explained the failure
      }
    } finally {
      setBusy(false);
    }
  }, [applyPdfTemplateState, job, loadJobs, handleError, resetSheetViews]);

  const loadSheet = useCallback(
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      if (!job) return;
      // Client cache key = group:sheet:variant:orientation:origin. NO renderVersion —
      // a version bump that does not recompute the layout (profile/material change)
      // re-uses the cached blob instead of re-fetching/flickering. Orientation AND
      // origin are in the key because each changes the rendered image and a job
      // switch can rehydrate a different saved orientation/origin (so it must
      // re-fetch, not dedupe to a stale-pref blob — Codex code-review R1
      // [REGRESSION-DEBT] for origin). Layout changes still bust via
      // resetSheetViews() (clears maps + thumbReqRef + epoch); renderVersion stays
      // in the FETCH to bust the SERVER render cache.
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(job.cutJobId, group.cutGroupId, sheetIndex, preset, rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin);
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
    [job, preset, sheetPortrait, sheetOriginTopLeft, sheetAxisOrigin, handleError],
  );

  // Small layout preview for a ready job's sheet, fetched once with the light
  // 'thumb' preset. Deduped via thumbReqRef so the auto-load effect is idempotent.
  // Client cache key = group:sheet:variant:orientation (NO renderVersion). Orientation
  // is in the key so a job-switch that rehydrates a different saved orientation re-fetches
  // instead of deduping to a stale-orientation thumb. resetSheetViews() (calculate / save /
  // orientation toggle / job switch) clears the maps + thumbReqRef + epoch on layout change.
  // renderVersion is still passed to the FETCH (server render-cache bust); out of the client
  // key so a no-recalc version bump (profile/material change) does not re-fetch/flicker.
  const loadThumb = useCallback(
    async (cutJobId: number, group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string) => {
      // origin in the key too (same rehydration reason as orientation — a persisted
      // RAW-origin job opening with the stale default-TL state must re-fetch, not
      // dedupe to a TL thumb; Codex code-review R1 [REGRESSION-DEBT]).
      const key = `${group.cutGroupId}:${sheetIndex}:${variant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
      const reqKey = `${cutJobId}:${key}`;
      if (thumbReqRef.current.has(reqKey)) return;
      thumbReqRef.current.add(reqKey);
      const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
      const rotate90 = sheet
        ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
        : sheetPortrait;
      const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
      const epoch = viewEpochRef.current;
      try {
        const blob = await cutApi.fetchSheetPng(cutJobId, group.cutGroupId, sheetIndex, 'thumb', rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin);
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
    [sheetPortrait, sheetOriginTopLeft, sheetAxisOrigin],
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
    async (group: CutGroupDto, sheetIndex: number, variant: 'auto' | 'manual' | 'active' = 'active', renderVersion?: string, displayNo?: number) => {
      if (!job) return;
      try {
        const sheet = group.sheets.find((candidate) => candidate.sheetIndex === sheetIndex);
        const rotate90 = sheet
          ? sheetPreviewRotate90(sheet.placements.sheet_width_mm, sheet.placements.sheet_height_mm, sheetPortrait)
          : sheetPortrait;
        const originTopLeft = effectiveSheetOrigin(sheet?.placements, sheetOriginTopLeft, sheetAxisOrigin);
        const blob = await cutApi.fetchSheetSvg(job.cutJobId, group.cutGroupId, sheetIndex, rotate90, variant, renderVersion, originTopLeft, sheetAxisOrigin);
        // Filename uses the displayed sheet number (dense 1..N) so it matches the
        // "Лист N" the operator sees, not the possibly-sparse real sheetIndex.
        const fileNo = displayNo ?? sheetIndex + 1;
        triggerBlobDownload(blob, `cut-${job.cutJobId}-g${group.cutGroupId}-s${fileNo}.svg`);
      } catch (error) {
        handleError(error, 'Не удалось выгрузить SVG');
      }
    },
    [job, sheetPortrait, sheetOriginTopLeft, sheetAxisOrigin, handleError],
  );

  const openGroupPdfPreview = useCallback(
    async (group: CutGroupDto) => {
      if (!job) return;
      const requestSeq = pdfPreviewRequestSeqRef.current + 1;
      pdfPreviewRequestSeqRef.current = requestSeq;
      setBusy(true);
      revokePdfPreviewUrl();
      setPdfPreview({ ...EMPTY_PDF_PREVIEW, open: true, group, title: `Предпросмотр PDF · группа #${group.cutGroupId}`, loading: true });
      try {
        // Pass renderToken so a post-save PDF render-cache is busted (variant=active).
        const pdfTemplate = pdfTemplateByGroup[group.cutGroupId] ?? 'standard';
        const result = await pollPdf(() => cutApi.fetchGroupPdf(job.cutJobId, group.cutGroupId, sheetPortrait, group.renderToken, sheetAxisOrigin === 'bottom-left' ? false : sheetOriginTopLeft, pdfTemplate, sheetAxisOrigin));
        if (pdfPreviewRequestSeqRef.current !== requestSeq) return;
        const url = URL.createObjectURL(result.blob);
        pdfPreviewUrlRef.current = url;
        setPdfPreview({
          open: true,
          group,
          title: `Предпросмотр PDF · группа #${group.cutGroupId}`,
          loading: false,
          url,
          blob: result.blob,
          fileName: result.fileName ?? `cut-group-${group.cutGroupId}.pdf`,
        });
      } catch (error) {
        if (pdfPreviewRequestSeqRef.current === requestSeq) {
          setPdfPreview((prev) => ({ ...prev, loading: false }));
        }
        handleError(error, 'Не удалось выгрузить PDF группы');
      } finally {
        setBusy(false);
      }
    },
    [job, sheetPortrait, sheetOriginTopLeft, sheetAxisOrigin, pdfTemplateByGroup, handleError, revokePdfPreviewUrl],
  );

  const closeGroupPdfPreview = useCallback(() => {
    pdfPreviewRequestSeqRef.current += 1;
    revokePdfPreviewUrl();
    setPdfPreview(EMPTY_PDF_PREVIEW);
  }, [revokePdfPreviewUrl]);

  const downloadPreviewPdf = useCallback(() => {
    if (!pdfPreview.blob || !pdfPreview.fileName) return;
    triggerBlobDownload(pdfPreview.blob, pdfPreview.fileName);
  }, [pdfPreview.blob, pdfPreview.fileName]);

  const openJobPdfPreview = useCallback(async () => {
    if (!job) return;
    const requestSeq = pdfPreviewRequestSeqRef.current + 1;
    pdfPreviewRequestSeqRef.current = requestSeq;
    setBusy(true);
    revokePdfPreviewUrl();
    setPdfPreview({
      ...EMPTY_PDF_PREVIEW,
      open: true,
      title: `Предпросмотр PDF · раскрой #${job.cutJobId}`,
      loading: true,
      fileName: `cut-job-${job.cutJobId}.pdf`,
    });
    try {
      // Pass renderToken so a post-save PDF render-cache is busted (variant=active).
      const result = await pollPdf(() => cutApi.fetchJobPdf(job.cutJobId, sheetPortrait, job.renderToken, sheetAxisOrigin === 'bottom-left' ? false : sheetOriginTopLeft, pdfTemplateForJob, sheetAxisOrigin));
      if (pdfPreviewRequestSeqRef.current !== requestSeq) return;
      const url = URL.createObjectURL(result.blob);
      pdfPreviewUrlRef.current = url;
      setPdfPreview({
        open: true,
        group: null,
        title: `Предпросмотр PDF · раскрой #${job.cutJobId}`,
        loading: false,
        url,
        blob: result.blob,
        fileName: result.fileName ?? `cut-job-${job.cutJobId}.pdf`,
      });
    } catch (error) {
      if (pdfPreviewRequestSeqRef.current === requestSeq) {
        setPdfPreview((prev) => ({ ...prev, loading: false }));
      }
      handleError(error, 'Не удалось выгрузить PDF раскроя');
    } finally {
      setBusy(false);
    }
  }, [job, sheetPortrait, sheetOriginTopLeft, sheetAxisOrigin, pdfTemplateForJob, handleError, revokePdfPreviewUrl]);

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
      const seed = editableSheetsForGroup(group);
      if (validateSheetGroupInvariant(seed)) {
        message.error('Повреждённая раскладка: несовместимые листы в группе');
        return;
      }
      setWorkingSheets(seed);
      setViolations([]);
      setEditorHistory([]);
      // Open zoomed out: the operator first orients across the whole group,
      // then zooms into the sheet they are editing.
      setEditorViewZoom(MIN_EDITOR_VIEW_ZOOM);
      setEditingGroupId(group.cutGroupId);
    },
    [job],
  );

  /**
   * Called by SheetEditor on every geometry change. Re-validates all sheets
   * and stores both the new working sheets and the fresh violation list.
   * Trim authority: uses placements.trim_mm (not editorParams), per brief §3.
   */
  const applyEditorSheets = useCallback(
    (effective: { sheetIndex: number; placements: SheetPlacements }[]) => {
      setWorkingSheets(effective);
      if (!job?.editorParams) {
        setViolations([]);
        return;
      }
      const gap = { kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm };
      const filmTextureByItemId = buildFilmTextureMap(effective, job.items);
      const newViolations = effective.flatMap((s) =>
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

  const handleEditorChange = useCallback(
    (nextSheets: { sheetIndex: number; placements: SheetPlacements }[]) => {
      // Drop sheets emptied by a cross-sheet move: empty sheets are not wanted in
      // a group. Real sheet_index is preserved for survivors (no renumber) so the
      // moves still validate against the auto stock on save; the editor just stops
      // rendering the blank sheet immediately. Mirrors reconstructManualSheets.
      const effective = pruneEmptySheets(nextSheets);
      // One undo entry per committed gesture: snapshot the PRE-change sheets.
      setEditorHistory((h) => pushHistory(h, workingSheets));
      applyEditorSheets(effective);
    },
    [applyEditorSheets, workingSheets],
  );

  /** Undo the last committed drag/rotate (up to EDITOR_UNDO_LIMIT steps). */
  const undoEditorStep = useCallback(() => {
    if (editorHistory.length === 0) return;
    const prev = editorHistory[editorHistory.length - 1];
    setEditorHistory(editorHistory.slice(0, -1));
    applyEditorSheets(prev);
  }, [editorHistory, applyEditorSheets]);

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
        applyPdfTemplateState(updated);
        setShowAlternativeByGroup((prev) => ({ ...prev, [group.cutGroupId]: true }));
        void loadJobs();
        resetSheetViews();
        setEditingGroupId(null);
        setWorkingSheets([]);
        setViolations([]);
        setEditorHistory([]);
      } catch (error) {
        // Surface 422 violations + 409 recalc/stale with the backend message.
        handleError(error, 'Не удалось сохранить ручной раскрой');
      } finally {
        setBusy(false);
      }
    },
    [applyPdfTemplateState, job, workingSheets, loadJobs, handleError, resetSheetViews],
  );

  const filteredJobs = useMemo(() => {
    const statusFiltered = filterJobsByStatus(jobs, statusFilter);
    if (!isEmbeddedOrder) return statusFiltered;
    return statusFiltered.filter((candidate) =>
      embeddedJobIds?.has(candidate.cutJobId) ||
      candidate.items?.some((item) => item.orderId === embeddedOrderId),
    );
  }, [embeddedJobIds, embeddedOrderId, isEmbeddedOrder, jobs, statusFilter]);

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
  // Effective material mirrors the backend sheet-override semantics — see
  // buildPieceMetaByItemId (unit-tested against moveAllowed).
  const pieceMetaByItemId = useMemo(
    () => buildPieceMetaByItemId(job?.items ?? [], job?.sheetMaterialTypeId ?? null),
    [job?.items, job?.sheetMaterialTypeId],
  );

  // A vacuum_table profile keeps «Разделять по материалу» editable even with a
  // chosen «Лист раскроя»: operators pre-set the flag before clearing the
  // override, and the frozen checkbox read as a bug. For other profiles the
  // freeze stays — the flag is override-irrelevant at calculate time.
  const isVacuumProfileId = useCallback(
    (profileId: number | null) =>
      profiles.find((p) => p.cutParamProfileId === profileId)?.params?.layout_mode === 'vacuum_table',
    [profiles],
  );

  // Per-piece sheet-material and film NAMES for the editor's per-sheet header.
  // Keyed by item_id "det-<orderDetailId>" (materialName is the sheet material,
  // Variant-B sole order-material ref).
  const pieceSheetInfoByItemId = useMemo(() => {
    const m = new Map<string, { materialName: string | null; filmName: string | null }>();
    for (const it of job?.items ?? []) {
      m.set(`det-${it.orderDetailId}`, {
        materialName: it.detail?.materialName ?? null,
        filmName: it.detail?.filmName ?? null,
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
      {
        title: 'Название',
        dataIndex: 'name',
        key: 'name',
        width: 360,
        className: 'cut-jobs-name-cell',
      },
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
        width: 63,
        render: (_: unknown, row: CutJobDto) => row.totals.positions,
      },
      {
        title: 'Группы',
        key: 'groups',
        width: 56,
        render: (_: unknown, row: CutJobDto) => cutJobCounts(row).groups,
      },
      {
        title: 'Деталей',
        key: 'details',
        width: 63,
        render: (_: unknown, row: CutJobDto) => row.totals.details,
      },
      {
        title: 'Площадь, итого',
        key: 'area',
        width: 84,
        render: (_: unknown, row: CutJobDto) => formatArea(row.totals.area),
      },
      {
        title: 'Кол-во листов раскроя',
        key: 'sheets',
        width: 84,
        render: (_: unknown, row: CutJobDto) => (row.status === 'ready' ? row.totals.sheets : '—'),
      },
      {
        title: 'Профиль',
        key: 'profile',
        width: 180,
        render: (_: unknown, row: CutJobDto) => resolveProfileLabel(row.paramProfileId, profiles, cutSettings),
      },
      {
        title: 'Материал деталей',
        key: 'detailMaterials',
        width: '20ch',
        render: (_: unknown, row: CutJobDto) => {
          const label = formatJobMaterialNames(row.materialNames);
          return label === '—' ? (
            label
          ) : (
            <Tooltip title={label}>
              <Text className="cut-job-materials-cell">{label}</Text>
            </Tooltip>
          );
        },
      },
      {
        title: 'Действия',
        key: 'actions',
        width: 200,
        render: (_: unknown, row: CutJobDto) => (
          <Space className="cut-jobs-actions" size={6}>
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
      {
        title: 'Заказ',
        key: 'order',
        render: (_: unknown, row: EligibleDetailDto) => row.orderName?.trim() || `#${row.orderId}`,
      },
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
        width: 140,
        // Click the order name to open its card as an in-app workspace tab
        // (push = new keep-alive tab, same as the orders list double-click).
        render: (_: unknown, r: CutJobItemDto) => (
          <Button type="link" size="small" style={{ padding: 0 }} onClick={() => show('orders_view', r.orderId, 'push')}>
            {r.orderName?.trim() || `#${r.orderId}`}
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
    <>
      <Space direction="vertical" size="large" style={{ width: '100%' }}>
        {!isEmbeddedOrder && <Title level={3}>Раскрой</Title>}

      <Card title="Критерии выборки" size="small">
        <Form form={form} layout="inline" disabled={busy || !canManage}>
          <Form.Item name="name" rules={[{ required: true, message: 'Укажите название' }]}>
            <Input placeholder="Название раскроя" />
          </Form.Item>
          {isEmbeddedOrder ? (
            <Form.Item name="orderIds" hidden>
              <Input />
            </Form.Item>
          ) : (
            <Form.Item name="orderIds">
              <Input placeholder="Заказы (9,10)" />
            </Form.Item>
          )}
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
        <div className="cut-jobs-table-container" style={{ maxHeight: CUT_JOBS_TABLE_CONTAINER_HEIGHT }}>
          <Table<CutJobDto>
            className="cut-jobs-table"
            size="small"
            rowKey="cutJobId"
            columns={jobColumns}
            dataSource={filteredJobs}
            loading={jobsLoading}
            pagination={false}
            locale={{ emptyText: 'Нет раскроев' }}
            rowClassName={(row) => (row.cutJobId === job?.cutJobId ? 'ant-table-row-selected' : '')}
            onRow={(row) => ({
              onDoubleClick: () => {
                if (!busy) void openJob(row.cutJobId);
              },
            })}
          />
        </div>
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
          {job.autoLayoutValidation?.valid === false && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="Требуется пересчёт раскроя"
              description="Раскрой создан старой версией оптимизатора и содержит некорректные зазоры. Пересчитайте задание перед ручным редактированием."
              data-testid="legacy-auto-layout-warning"
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
                        disabled={
                          !canManage ||
                          busy ||
                          job.status === 'calculating' ||
                          isArchivedJob ||
                          (job.sheetMaterialTypeId != null && !isVacuumProfileId(job.paramProfileId))
                        }
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
          <div style={cutActionToolbarStyle}>
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
              <>
                <div style={pdfTemplatePickerStyle}>
                  <Text type="secondary" style={pdfTemplateLabelStyle}>Шаблон PDF</Text>
                  <Select
                    size="small"
                    value={pdfTemplateForJob}
                    onChange={setJobPdfTemplate}
                    options={pdfTemplateOptions}
                    style={{ width: 180, flex: '0 0 180px' }}
                    disabled={busy}
                    data-testid="pdf-template-select-job"
                  />
                </div>
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
                    onClick={() => void openJobPdfPreview()}
                    loading={busy}
                    disabled={anyGroupDirty || (job.requiresRecalc ?? false)}
                    data-testid="preview-job-pdf-btn"
                  >
                    Предпросмотр PDF (весь раскрой)
                  </Button>
                </Tooltip>
              </>
            )}
          </div>
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
        <Space size={12} wrap className="cut-sheet-view-controls">
          <Radio.Group
            className="cut-sheet-icon-radio"
            value={sheetPortrait}
            onChange={(event) => toggleSheetPortrait(event.target.value as boolean)}
            buttonStyle="solid"
            aria-label="Ориентация листа"
          >
            <Tooltip title="Книжная ориентация">
              <Radio.Button value={true} aria-label="Книжная ориентация">
                <SheetOrientationIcon portrait />
              </Radio.Button>
            </Tooltip>
            <Tooltip title="Альбомная ориентация">
              <Radio.Button value={false} aria-label="Альбомная ориентация">
                <SheetOrientationIcon portrait={false} />
              </Radio.Button>
            </Tooltip>
          </Radio.Group>
          <Radio.Group
            className="cut-sheet-icon-radio"
            value={sheetAxisOrigin}
            onChange={(event) => changeSheetAxisOrigin(event.target.value as CutAxisOrigin)}
            buttonStyle="solid"
            aria-label="Точка отсчёта"
          >
            <Tooltip title="Точка отсчёта слева снизу">
              <Radio.Button value="bottom-left" aria-label="Точка отсчёта слева снизу">
                <SheetOriginIcon axisOrigin="bottom-left" />
              </Radio.Button>
            </Tooltip>
            <Tooltip title="Точка отсчёта слева сверху">
              <Radio.Button value="top-left" aria-label="Точка отсчёта слева сверху">
                <SheetOriginIcon axisOrigin="top-left" />
              </Radio.Button>
            </Tooltip>
          </Radio.Group>
        </Space>
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
        const legacyAutoLayoutInvalid = job.autoLayoutValidation?.valid === false;
        // Preview sheets: honour displayVariant so count/overlays follow the
        // manual layout when the operator has switched to the manual view.
        const previewSheets = selectVariantSheets(group, displayVariant);
        const groupInvariantError = validateSheetGroupInvariant(previewSheets);
        const editableInvariantError = validateSheetGroupInvariant(editableSheetsForGroup(group));
        const editDisabled = !(job.editorParams) || (job.requiresRecalc ?? false) || legacyAutoLayoutInvalid || Boolean(editableInvariantError);

        return (
          <Card
            key={group.cutGroupId}
            id={`cut-group-card-${group.cutGroupId}`}
            size="small"
            // scrollMarginTop keeps the card title visible under the sticky
            // header when the back-to-top button scrolls the card into view.
            style={{ scrollMarginTop: stickyHeaderTop }}
            // Sticky group header: keeps the group name, «устарел» badge,
            // «Редактировать раскрой» and «Скачать PDF» on screen while the
            // operator scrolls through a tall group with many sheets.
            headStyle={{
              position: 'sticky',
              top: stickyHeaderTop,
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
              <div style={cutActionToolbarStyle}>
                {isEditingGroup && (
                  <Space size={4} data-testid="sticky-editor-zoom-controls">
                    <Tooltip
                      title={
                        editorHistory.length > 0
                          ? `Отменить последнее перемещение или поворот детали (доступно шагов: ${editorHistory.length})`
                          : 'Нет шагов для отмены'
                      }
                    >
                      <Button
                        aria-label="Отменить последний шаг редактирования"
                        icon={<UndoOutlined />}
                        style={{ height: 40 }}
                        onClick={undoEditorStep}
                        disabled={busy || editorHistory.length === 0}
                        data-testid="undo-edit-step-btn"
                      >
                        Отменить шаг
                      </Button>
                    </Tooltip>
                    <Tooltip title="Уменьшить масштаб группы раскроя">
                      <Button
                        aria-label="Уменьшить масштаб группы раскроя"
                        icon={<MinusOutlined />}
                        style={{ width: 40, height: 40 }}
                        disabled={editorViewZoom <= MIN_EDITOR_VIEW_ZOOM}
                        onClick={() => setEditorViewZoom((value) => Math.max(MIN_EDITOR_VIEW_ZOOM, value - EDITOR_VIEW_ZOOM_STEP))}
                      />
                    </Tooltip>
                    <span
                      data-testid="sheet-editor-zoom-value"
                      style={{ minWidth: 52, textAlign: 'center', fontVariantNumeric: 'tabular-nums' }}
                    >
                      {Math.round(editorViewZoom * 100)}%
                    </span>
                    <Tooltip title="Увеличить масштаб группы раскроя">
                      <Button
                        aria-label="Увеличить масштаб группы раскроя"
                        icon={<PlusOutlined />}
                        style={{ width: 40, height: 40 }}
                        disabled={editorViewZoom >= MAX_EDITOR_VIEW_ZOOM}
                        onClick={() => setEditorViewZoom((value) => Math.min(MAX_EDITOR_VIEW_ZOOM, value + EDITOR_VIEW_ZOOM_STEP))}
                      />
                    </Tooltip>
                  </Space>
                )}
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
                      legacyAutoLayoutInvalid
                        ? 'Раскрой содержит некорректные зазоры — требуется пересчёт'
                        : (job.requiresRecalc ?? false)
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
                <div style={pdfTemplatePickerStyle}>
                  <Text type="secondary" style={pdfTemplateLabelStyle}>Шаблон PDF</Text>
                  <Select
                    size="small"
                    value={pdfTemplateByGroup[group.cutGroupId] ?? group.pdfTemplate ?? 'standard'}
                    onChange={(value) => setGroupPdfTemplate(group, value)}
                    options={pdfTemplateOptions}
                    style={{ width: 180, flex: '0 0 180px' }}
                    disabled={busy}
                    data-testid={`pdf-template-select-${group.cutGroupId}`}
                  />
                </div>
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
                    onClick={() => void openGroupPdfPreview(group)}
                    loading={busy}
                    disabled={isDirtyGroup || (job.requiresRecalc ?? false)}
                    data-testid={`preview-group-pdf-btn-${group.cutGroupId}`}
                  >
                    Предпросмотр PDF
                  </Button>
                </Tooltip>
              </div>
            }
          >
            <Text type="secondary">{formatGroupSummary(group.summary)}</Text>
            {(groupInvariantError || editableInvariantError) && (
              <Alert type="error" showIcon message="Повреждённая раскладка: несовместимые листы в группе" />
            )}
            <div style={{ marginTop: 4, color: '#595959', fontSize: 13 }}>
              Материал раскроя: <b>{matName ?? 'не задан'}</b>
              {filmText && (
                <>
                  {' '}· {filmLabel}: <b>{filmText}</b>
                </>
              )}
            </div>

            {/* ── Editor mode ────────────────────────────────────────────────── */}
            {isEditingGroup && job.editorParams && !groupInvariantError && (
              <div style={{ marginTop: 12 }}>
                <Space style={{ marginBottom: 8 }}>
                  <Tooltip title={violations.length > 0 ? `${violations.length} нарушений геометрии` : undefined}>
                    <Button
                      type="primary"
                      size="small"
                      disabled={violations.length > 0 || (job.requiresRecalc ?? false) || legacyAutoLayoutInvalid || busy}
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
                      setEditorHistory([]);
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
                  viewZoom={editorViewZoom}
                  gap={{ kerfMm: job.editorParams.kerfMm, spacingMm: job.editorParams.spacingMm }}
                  filmTextureByItemId={editorFilmTextureByItemId}
                  labelInfoByItemId={editorLabelInfoByItemId}
                  // Match the preview orientation EXACTLY: the preview rotates each
                  // sheet via sheetPreviewRotate90(dims, sheetPortrait) (per-sheet,
                  // dimension-aware), but the editor previously got a raw `!sheetPortrait`
                  // that ignored the sheet's actual w/h — so a landscape sheet opened
                  // portrait. All sheets in a group share dimensions, so derive the
                  // rotate flag from the group's representative (first) working sheet.
                  landscape={(() => {
                    const p = workingSheets[0]?.placements;
                    return p
                      ? sheetPreviewRotate90(p.sheet_width_mm, p.sheet_height_mm, sheetPortrait)
                      : !sheetPortrait;
                  })()}
                  originTopLeft={effectiveSheetOrigin(workingSheets[0]?.placements, sheetOriginTopLeft, sheetAxisOrigin)}
                  axisOrigin={sheetAxisOrigin}
                  onChange={handleEditorChange}
                  violations={violations}
                  splitByMaterial={job.splitByMaterial}
                  combineFilms={job.combineFilms}
                  groupMaterialTypeId={editingGroup?.sheetMaterialTypeId ?? null}
                  groupFilmId={editingGroup?.filmId ?? null}
                  pieceMetaByItemId={pieceMetaByItemId}
                  pieceSheetInfoByItemId={pieceSheetInfoByItemId}
                  showFilm={!job.combineFilms}
                />
              </div>
            )}

            {/* ── Normal sheet previews (hidden while in editor mode) ─────────── */}
            {!isEditingGroup && (
              /* Previews flow in wrapping rows (not a single column). */
              <div style={sheetPreviewListStyle}>
                {previewSheets.map((sheet, sheetPos) => {
                  // Display number is the DENSE position (1..N): the manual layout may
                  // omit an emptied sheet, leaving a gap in the real sheet_index. Real
                  // sheet.sheetIndex is still used for cache keys, fetch and labels.
                  const sheetNo = sheetPos + 1;
                  // Client cache key = group:sheet:variant:orientation:origin (NO
                  // renderVersion) — must match loadSheet/loadThumb. resetSheetViews()
                  // busts on layout change; orientation AND origin are in the key (a job
                  // switch may rehydrate a different saved orientation/origin); renderVersion
                  // stays only in the fetch (server bust). Keeps the cached preview stable
                  // across no-recalc version bumps.
                  const key = `${group.cutGroupId}:${sheet.sheetIndex}:${displayVariant}:${sheetPortrait ? 'P' : 'L'}:${sheetOriginTopLeft ? 'tl' : 'raw'}:${sheetAxisOrigin}`;
                  // Stable React element identity per (group, sheet) — deliberately NOT
                  // the cache key. A renderVersion bump (e.g. changing profile/material,
                  // which only marks the job stale) then refreshes the image in place
                  // instead of unmounting/remounting the whole preview row, which used to
                  // collapse the list and bounce the page scroll down-then-back.
                  const elemKey = `${group.cutGroupId}:${sheet.sheetIndex}`;
                  const widthMm = sheet.placements.sheet_width_mm;
                  const heightMm = sheet.placements.sheet_height_mm;
                  const rotate90 = sheetPreviewRotate90(widthMm, heightMm, sheetPortrait);
                  const originTopLeft = effectiveSheetOrigin(sheet.placements, sheetOriginTopLeft, sheetAxisOrigin);
                  const displayWidthMm = rotate90 ? heightMm : widthMm;
                  const displayHeightMm = rotate90 ? widthMm : heightMm;
                  const isPortraitPreview = displayHeightMm > displayWidthMm;
                  const overlays = buildSheetPieceOverlays(sheet.placements, job.items, rotate90, originTopLeft, sheetAxisOrigin);
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
                      <div className={`cut-sheet-preview-header${isPortraitPreview ? ' cut-sheet-preview-header--portrait' : ''}`}>
                        <div className="cut-sheet-preview-title app-tabular">
                          {isPortraitPreview ? (
                            <>
                              <strong>Лист {sheetNo}</strong>
                              <span>{matName ?? 'материал не задан'}</span>
                              {filmText && <span>{filmLabel}: {filmText}</span>}
                              <span>кол-во деталей - {sheet.placements.pieces.length}</span>
                            </>
                          ) : (
                            <>
                              <strong>Лист {sheetNo}</strong>
                              {' · '}
                              {matName ?? 'материал не задан'}
                              {filmText ? ` · ${filmLabel}: ${filmText}` : ''}
                              {' · '}
                              кол-во деталей - {sheet.placements.pieces.length}
                            </>
                          )}
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
                            onClick={() => downloadSheetSvg(group, sheet.sheetIndex, displayVariant, renderVersion, sheetNo)}
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
                          alt={`Превью листа ${sheetNo}`}
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
                          alt={`Лист ${sheetNo}`}
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
      {job && showBackToTop && (
        <div style={backToTopFixedStyle}>
          <Button icon={<UpOutlined />} onClick={scrollBackToGroupTop} data-testid="back-to-top-btn">
            Наверх
          </Button>
        </div>
      )}
      <Modal
        title={pdfPreview.title}
        open={pdfPreview.open}
        onCancel={closeGroupPdfPreview}
        width={1040}
        destroyOnHidden
        footer={[
          <Button key="close" onClick={closeGroupPdfPreview}>
            Закрыть
          </Button>,
          <Button key="download" type="primary" disabled={!pdfPreview.blob || pdfPreview.loading} onClick={downloadPreviewPdf}>
            Скачать
          </Button>,
        ]}
      >
        <div style={{ minHeight: 420 }}>
          {pdfPreview.loading ? (
            <div style={{ height: 420, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
              <Spin tip="Готовим PDF" />
            </div>
          ) : pdfPreview.url ? (
            <iframe
              title="Предпросмотр PDF"
              src={pdfPreview.url}
              style={{
                width: '100%',
                height: 'min(72vh, 760px)',
                minHeight: 420,
                border: '1px solid rgba(0, 0, 0, 0.1)',
                borderRadius: 6,
              }}
            />
          ) : (
            <Alert type="warning" showIcon message="PDF не загружен" />
          )}
        </div>
      </Modal>
    </>
  );
};
