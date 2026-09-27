import type { MdfEngineModeDto } from "../../api/mdfCorrectionApi";
import type {
  MdfPublishedCard,
  MdfSessionSnapshot,
  MdfSourceKind,
} from "../../api/types/mdfPublishedApi.types";

/** §5.5b: which return dialog the board opens for a backward move on this card.
 * Pure — no network, no authSession coupling. The caller resolves engine mode
 * and (only when active) the published session first, then feeds the result
 * here; IO/error classification stays outside this module. */
export type MdfReturnSelection =
  | { kind: "legacy" }
  | { kind: "new"; sourceToken: string }
  | { kind: "blocked"; reason: string }
  | { kind: "read_only" }
  | { kind: "unavailable" };

export interface MdfReturnSelectionCard {
  kind: MdfSourceKind;
  id: string;
}

export interface MdfReturnSelectionInput {
  /** null when the GET /mdf-engine request itself failed or returned an
   * unrecognized mode; never guess a mode in that case. */
  engineMode: MdfEngineModeDto | null;
  /** Only meaningful (and only fetched by the caller) when engineMode.mode==='active'. */
  publishedSession: MdfSessionSnapshot | null;
  /** True when the published-session fetch itself failed (503 disabled, network,
   * session changed, ...). Distinct from publishedSession===null-because-not-fetched. */
  publishedSessionFailed: boolean;
  /** GET /mdf-engine answered 404: a backend that predates the endpoint (mixed deploy / rollback). The caller then
   * fetches the published session once: an active/read_only snapshot proves a non-legacy engine. */
  engineModeEndpointMissing?: boolean;
  card: MdfReturnSelectionCard;
}

const KNOWN_ENGINE_MODES: readonly MdfEngineModeDto["mode"][] = [
  "legacy",
  "shadow",
  "active",
  "read_only",
];

/** Same readiness contract as prepareMdfPublishedCommand (mdfPublishedCommand.ts),
 * minus the live authSession assertion and the target-column check — this module
 * never executes a command, it only decides which dialog to show. */
function findReadyCard(
  snapshot: MdfSessionSnapshot["snapshot"],
  card: MdfReturnSelectionCard
): { reason: string } | { card: MdfPublishedCard } {
  if (snapshot.mode !== "active") return { reason: "MDF_ENGINE_NOT_ACTIVE" };
  if (snapshot.issues.length) return { reason: snapshot.issues[0] };
  const found = snapshot.cards.find(
    (c) => c.kind === card.kind && c.id === card.id
  );
  if (!found) return { reason: "MDF_SOURCE_NOT_REGISTERED" };
  if (found.issues.length) return { reason: found.issues[0] };
  if (
    snapshot.pendingJobs.some((j) => j.kind === card.kind && j.id === card.id)
  ) {
    return { reason: "MDF_PUBLICATION_PENDING" };
  }
  if (!found.acceptedRevision || found.acceptedRevision !== found.receivedRevision) {
    return { reason: "MDF_PUBLICATION_PENDING" };
  }
  if (!found.commandToken || !/^[a-f0-9]{64}$/.test(found.commandToken)) {
    return { reason: "MDF_COMMAND_TOKEN_MISSING" };
  }
  return { card: found };
}

export function selectMdfReturnDialog(
  input: MdfReturnSelectionInput
): MdfReturnSelection {
  if (input.engineModeEndpointMissing) {
    // Only an affirmative non-legacy signal blocks; without published evidence the old backend can only be legacy
    // (a non-legacy engine requires the backend release that has /mdf-engine — §5.8 activation gate), and the
    // backend boundary still rejects a legacy return in active mode.
    const snapshotMode = input.publishedSession?.snapshot.mode;
    if (snapshotMode === "active" || snapshotMode === "read_only") return { kind: "blocked", reason: "MDF_BACKEND_OUTDATED" };
    return { kind: "legacy" };
  }
  const mode = input.engineMode?.mode;
  if (!input.engineMode || !KNOWN_ENGINE_MODES.includes(mode as never)) {
    return { kind: "unavailable" };
  }
  if (mode === "legacy" || mode === "shadow") return { kind: "legacy" };
  if (mode === "read_only") return { kind: "read_only" };
  // mode === 'active': the legacy dialog must never open here.
  if (input.publishedSessionFailed || !input.publishedSession) {
    return { kind: "blocked", reason: "MDF_PUBLICATION_UNAVAILABLE" };
  }
  const result = findReadyCard(input.publishedSession.snapshot, input.card);
  if ("reason" in result) return { kind: "blocked", reason: result.reason };
  return { kind: "new", sourceToken: result.card.commandToken! };
}

/** Russian explanation for a 'blocked' selection reason, shown in the dialog. */
export function mdfReturnBlockReasonText(reason: string): string {
  switch (reason) {
    case "MDF_SOURCE_NOT_REGISTERED":
      return "Карточка ещё не зарегистрирована в производственном учёте.";
    case "MDF_PUBLICATION_PENDING":
      return "Карточка ещё обрабатывается производственным учётом — обновите доску через минуту.";
    case "MDF_PARTIAL_ACCESS":
      return "В карточке есть детали заказов, к которым у вас нет доступа.";
    case "MDF_COMMAND_TOKEN_MISSING":
      return "Не удалось получить подтверждение карточки — обновите доску.";
    case "MDF_ENGINE_NOT_ACTIVE":
      return "Производственный учёт не активен для согласованного чтения.";
    case "MDF_BACKEND_OUTDATED":
      return "Сервер ещё не обновлён для нового производственного учёта — повторите после обновления.";
    case "MDF_PUBLICATION_UNAVAILABLE":
      return "Согласованное чтение производственных данных временно недоступно.";
    default:
      return `Возврат карточки временно недоступен (код: ${reason}).`;
  }
}

/** True when `GET /orders/status-board/mdf-engine` failed with 404 (backend without the endpoint). Any other failure
 * leaves the mode unknown (return unavailable). */
export function isMdfEngineModeEndpointMissing(error: unknown): boolean {
  const status = error && typeof error === 'object'
    ? (error as { status?: unknown; statusCode?: unknown }).status ?? (error as { statusCode?: unknown }).statusCode
    : undefined;
  return status === 404;
}
