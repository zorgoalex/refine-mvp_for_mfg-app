import { Alert } from "antd";
import { Link } from "react-router-dom";
import type { CutOrderIssue, CutOrderIssueKind, CutOrderJobIssues } from "../../../../api/types/cutApi.types";
import { cutJobDeepLink } from "../../cutColumnHelpers";

const ISSUE_TITLES: Record<CutOrderIssueKind, string> = {
  deleted: "удалены из заказа",
  moved: "перенесены в другой заказ",
  size_changed: "изменён размер",
  quantity_changed: "изменено количество",
  material_changed: "изменён материал листа",
};

const ISSUE_ORDER: CutOrderIssueKind[] = ["deleted", "moved", "size_changed", "quantity_changed", "material_changed"];

type OrderCutIssuesDetail = {
  detail_id?: unknown;
  height?: unknown;
  width?: unknown;
  quantity?: unknown;
  sheet_material_type_id?: unknown;
};

/**
 * Fingerprint of the order details the cut issues depend on; the card re-reads the issues when it changes
 * (a detail deleted, resized, re-quantified or moved to another sheet material while the card stays open).
 */
export function orderCutIssuesDetailsKey(details: readonly OrderCutIssuesDetail[]): string {
  return details
    .map((detail) => [detail.detail_id, detail.height, detail.width, detail.quantity, detail.sheet_material_type_id]
      .map((value) => (value === null || value === undefined ? "" : String(value)))
      .join(":"))
    .sort()
    .join("|");
}

function detailLabel(issue: CutOrderIssue): string {
  const number = issue.detailNumber === null ? `id ${issue.orderDetailId}` : `№${issue.detailNumber}`;
  if (issue.kind === "moved") return issue.current ? `${number} → заказ ${issue.current}` : number;
  if (issue.calculated !== null && issue.current !== null) {
    return `${number} (было ${issue.calculated}, стало ${issue.current})`;
  }
  return number;
}

type ColumnCutRef = { cutJobId: number; resultNo?: number | null };

/**
 * Fingerprint of what the details' «Раскрой»/«Ванна» columns point at (job and result per detail). The card re-reads
 * the issues when it changes: a cut recalculated, or dropped from the columns because a detail transfer in ANOTHER
 * order cleared its calculation basis while this order's details stayed the same.
 */
export function orderCutColumnRefsKey(
  cutByDetailId: ReadonlyMap<number, ColumnCutRef>,
  bathByDetailId: ReadonlyMap<number, ColumnCutRef>,
): string {
  const part = (prefix: string, refs: ReadonlyMap<number, ColumnCutRef>) =>
    [...refs.entries()].map(([detailId, ref]) => `${prefix}${detailId}:${ref.cutJobId}:${ref.resultNo ?? ""}`);
  return [...part("c", cutByDetailId), ...part("b", bathByDetailId)].sort().join("|");
}

/**
 * Keeps the order card's cut issues fresh for changes the card cannot see in its own details or columns: a cut
 * recalculated in any tab/window (cut-ready subscription) or an older shared cut invalidated by a detail transfer in
 * another order (bounded poll). Returns the cleanup.
 */
export function startOrderCutIssuesRefresh(input: {
  refresh: () => void;
  subscribe: (listener: () => void) => () => void;
  intervalMs: number;
  timers?: { setInterval: (fn: () => void, ms: number) => unknown; clearInterval: (id: unknown) => void };
}): () => void {
  const timers = input.timers ?? {
    setInterval: (fn: () => void, ms: number) => window.setInterval(fn, ms),
    clearInterval: (id: unknown) => window.clearInterval(id as number),
  };
  const unsubscribe = input.subscribe(input.refresh);
  const intervalId = timers.setInterval(input.refresh, input.intervalMs);
  return () => {
    unsubscribe();
    timers.clearInterval(intervalId);
  };
}

export function orderCutIssueLines(job: CutOrderJobIssues): string[] {
  return ISSUE_ORDER.flatMap((kind) => {
    const issues = job.issues.filter((issue) => issue.kind === kind);
    if (issues.length === 0) return [];
    return [`${ISSUE_TITLES[kind]}: ${issues.map(detailLabel).join(", ")}`];
  });
}

export function orderCutJobTitle(job: CutOrderJobIssues): string {
  return `${job.isVacuum ? "Ванна" : "Раскрой"} ${job.cutNumber}`;
}

/** Why a job is listed; `inColumn` — a detail's «Раскрой»/«Ванна» column points at this job right now. */
export function orderCutJobStatus(job: CutOrderJobIssues, inColumn: boolean): string {
  if (inColumn) return "указан в колонке деталей, но после расчёта детали заказа изменились — пересчитайте";
  if (job.requiresRecalc && job.issues.length === 0) {
    return "ждёт пересчёта (детали переносились между заказами), поэтому в колонке деталей не показывается";
  }
  if (job.requiresRecalc) return "ждёт пересчёта, поэтому в колонке деталей не показывается";
  return "не указан в колонках текущих деталей заказа";
}

/**
 * Column cuts/baths (what a detail's «Раскрой»/«Ванна» column points at right now) holding details of this order
 * that were deleted, moved or changed after the calculation.
 */
export function columnCutIssueJobs(
  jobs: readonly CutOrderJobIssues[],
  columnCutJobIds: ReadonlySet<number>,
): CutOrderJobIssues[] {
  return jobs.filter((job) => columnCutJobIds.has(job.cutJobId) && job.issues.length > 0);
}

export function columnCutIssuesTitle(jobs: readonly CutOrderJobIssues[]): string {
  const hasCut = jobs.some((job) => !job.isVacuum);
  const hasBath = jobs.some((job) => job.isVacuum);
  const subject = hasCut && hasBath
    ? "Раскрои и ванны из колонок «Раскрой» / «Ванна»"
    : hasBath
      ? `${jobs.length === 1 ? "Ванна" : "Ванны"} из колонки «Ванна»`
      : `${jobs.length === 1 ? "Раскрой" : "Раскрои"} из колонки «Раскрой»`;
  const verb = jobs.length === 1 ? "не актуален" : "не актуальны";
  const fixedVerb = jobs.length === 1 && hasBath && !hasCut ? "не актуальна" : verb;
  return `${subject} ${fixedVerb}: после расчёта детали заказа удалили или изменили`;
}

function JobLines({ job, status }: { job: CutOrderJobIssues; status: string }) {
  const lines = orderCutIssueLines(job);
  return (
    <div>
      <Link to={cutJobDeepLink(job.cutJobId)} title={job.name}>{orderCutJobTitle(job)}</Link>
      {` — ${status}${lines.length > 0 ? ":" : ""}`}
      {lines.length > 0 && (
        <ul style={{ margin: "2px 0 0", paddingInlineStart: 18 }}>
          {lines.map((line) => <li key={line}>{line}</li>)}
        </ul>
      )}
    </div>
  );
}

type AlertProps = { jobs: readonly CutOrderJobIssues[]; columnCutJobIds: ReadonlySet<number> };

/**
 * «Дополнительная информация» → «Раскрой»: every ready cut/bath of this order calculated from details deleted, moved
 * or changed since, or awaiting recalculation. Labels from such a sheet skip deleted details.
 */
export function OrderCutIssuesAlert({ jobs, columnCutJobIds }: AlertProps) {
  if (jobs.length === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 6, fontSize: 12, padding: "4px 8px" }}
      message={jobs.length === 1 ? "Раскрой не актуален" : "Раскрои не актуальны"}
      description={(
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          {jobs.map((job) => (
            <JobLines key={job.cutJobId} job={job} status={orderCutJobStatus(job, columnCutJobIds.has(job.cutJobId))} />
          ))}
        </div>
      )}
    />
  );
}

/** Above the details list: the column cuts/baths that are not current any more. */
export function OrderColumnCutIssuesAlert({ jobs, columnCutJobIds }: AlertProps) {
  const columnJobs = columnCutIssueJobs(jobs, columnCutJobIds);
  if (columnJobs.length === 0) return null;
  return (
    <Alert
      type="warning"
      showIcon
      style={{ marginBottom: 8, fontSize: 12 }}
      message={columnCutIssuesTitle(columnJobs)}
      description={(
        <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12 }}>
          {columnJobs.map((job) => <JobLines key={job.cutJobId} job={job} status="пересчитайте" />)}
        </div>
      )}
    />
  );
}
