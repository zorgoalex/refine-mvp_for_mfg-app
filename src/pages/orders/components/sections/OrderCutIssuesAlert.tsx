import { Alert } from "antd";
import { Link } from "react-router-dom";
import type { CutOrderIssue, CutOrderIssueKind, CutOrderJobIssues } from "../../../../api/types/cutApi.types";
import { cutJobDeepLink } from "../../cutColumnHelpers";

const ISSUE_TITLES: Record<CutOrderIssueKind, string> = {
  deleted: "удалены из заказа",
  size_changed: "изменён размер",
  quantity_changed: "изменено количество",
  material_changed: "изменён материал листа",
};

const ISSUE_ORDER: CutOrderIssueKind[] = ["deleted", "size_changed", "quantity_changed", "material_changed"];

function detailLabel(issue: CutOrderIssue): string {
  const number = issue.detailNumber === null ? `id ${issue.orderDetailId}` : `№${issue.detailNumber}`;
  if (issue.calculated !== null && issue.current !== null) {
    return `${number} (было ${issue.calculated}, стало ${issue.current})`;
  }
  return number;
}

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

export function orderCutIssueLines(job: CutOrderJobIssues): string[] {
  return ISSUE_ORDER.flatMap((kind) => {
    const issues = job.issues.filter((issue) => issue.kind === kind);
    if (issues.length === 0) return [];
    return [`${ISSUE_TITLES[kind]}: ${issues.map(detailLabel).join(", ")}`];
  });
}

/**
 * «Раскрой не актуален»: ready cut jobs of this order whose current result was calculated from details that were
 * deleted or changed since. Labels from such a sheet skip deleted details; the cut should be recalculated.
 */
export function OrderCutIssuesAlert({ jobs }: { jobs: readonly CutOrderJobIssues[] }) {
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
            <div key={job.cutJobId}>
              <Link to={cutJobDeepLink(job.cutJobId)} title={job.name}>Раскрой {job.cutNumber}</Link>
              {" — после расчёта детали заказа изменились, пересчитайте раскрой:"}
              <ul style={{ margin: "2px 0 0", paddingInlineStart: 18 }}>
                {orderCutIssueLines(job).map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          ))}
        </div>
      )}
    />
  );
}
