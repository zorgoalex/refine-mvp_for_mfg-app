import { describe, expect, it } from "vitest";
import {
  isMdfEngineModeEndpointMissing,
  mdfReturnBlockReasonText,
  selectMdfReturnDialog,
  type MdfReturnSelectionInput,
} from "./mdfReturnSelection";
import type {
  MdfPublishedCard,
  MdfPublishedSnapshot,
  MdfSessionSnapshot,
} from "../../api/types/mdfPublishedApi.types";

const READY_TOKEN = "a".repeat(64);

function card(overrides: Partial<MdfPublishedCard> = {}): MdfPublishedCard {
  return {
    kind: "packet",
    id: "card-1",
    displayName: "Файл 1",
    column: "completed_laminated",
    sourceCreatedAt: "2026-09-01T00:00:00.000Z",
    acceptedRevision: "rev-1",
    receivedRevision: "rev-1",
    commandToken: READY_TOKEN,
    issues: [],
    ...overrides,
  };
}

function snapshot(overrides: Partial<MdfPublishedSnapshot> = {}): MdfPublishedSnapshot {
  return {
    schemaVersion: 1,
    mode: "active",
    revision: "snap-1",
    generatedAt: "2026-09-27T00:00:00.000Z",
    dateFrom: "2026-09-01",
    dateTo: "2026-09-27",
    cards: [card()],
    members: [],
    positions: [],
    pendingJobs: [],
    trackedJobs: [],
    issues: [],
    ...overrides,
  };
}

function session(overrides: Partial<MdfPublishedSnapshot> = {}): MdfSessionSnapshot {
  return { sessionGeneration: 1, snapshot: snapshot(overrides) };
}

const baseInput = (
  overrides: Partial<MdfReturnSelectionInput> = {}
): MdfReturnSelectionInput => ({
  engineMode: { mode: "active", publishedReads: true },
  publishedSession: session(),
  publishedSessionFailed: false,
  card: { kind: "packet", id: "card-1" },
  ...overrides,
});

describe("selectMdfReturnDialog", () => {
  it("routes legacy engine mode to the legacy dialog", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ engineMode: { mode: "legacy", publishedReads: false } })
      )
    ).toEqual({ kind: "legacy" });
  });

  it("routes shadow engine mode to the legacy dialog", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ engineMode: { mode: "shadow", publishedReads: false } })
      )
    ).toEqual({ kind: "legacy" });
  });

  it("routes read_only engine mode to the read_only explanation, never legacy", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ engineMode: { mode: "read_only", publishedReads: true } })
      )
    ).toEqual({ kind: "read_only" });
  });

  it("treats a failed/unknown engine-mode request as unavailable", () => {
    expect(selectMdfReturnDialog(baseInput({ engineMode: null }))).toEqual({
      kind: "unavailable",
    });
    expect(
      selectMdfReturnDialog(
        baseInput({
          engineMode: { mode: "bogus" as never, publishedReads: false },
        })
      )
    ).toEqual({ kind: "unavailable" });
  });

  it("returns the ready card's command token for an active, ready card", () => {
    expect(selectMdfReturnDialog(baseInput())).toEqual({
      kind: "new",
      sourceToken: READY_TOKEN,
    });
  });

  it("never falls back to legacy when active but the published session failed (503)", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ publishedSession: null, publishedSessionFailed: true })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_PUBLICATION_UNAVAILABLE" });
  });

  it("blocks when the published session snapshot itself is not active", () => {
    expect(
      selectMdfReturnDialog(baseInput({ publishedSession: session({ mode: "shadow" }) }))
    ).toEqual({ kind: "blocked", reason: "MDF_ENGINE_NOT_ACTIVE" });
  });

  it("blocks on a snapshot-level issue", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ publishedSession: session({ issues: ["MDF_SOURCE_ISSUES"] }) })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_SOURCE_ISSUES" });
  });

  it("blocks (never legacy) when the card is absent from the published snapshot", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({ publishedSession: session({ cards: [] }) })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_SOURCE_NOT_REGISTERED" });
  });

  it("blocks with MDF_PARTIAL_ACCESS when the card carries that issue", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({
          publishedSession: session({
            cards: [card({ issues: ["MDF_PARTIAL_ACCESS"] })],
          }),
        })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_PARTIAL_ACCESS" });
  });

  it("blocks on a pending job for the same card", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({
          publishedSession: session({
            pendingJobs: [
              { jobId: "job-1", kind: "packet", id: "card-1", status: "pending", code: null, attempts: 1, orderIds: [] },
            ],
          }),
        })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_PUBLICATION_PENDING" });
  });

  it("blocks when the card's accepted and received revisions diverge", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({
          publishedSession: session({
            cards: [card({ acceptedRevision: "rev-1", receivedRevision: "rev-2" })],
          }),
        })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_PUBLICATION_PENDING" });
  });

  it("blocks when the card has no usable command token", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({
          publishedSession: session({ cards: [card({ commandToken: null })] }),
        })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_COMMAND_TOKEN_MISSING" });
  });

  it("blocks without a network round trip when publishedReads is off", () => {
    expect(
      selectMdfReturnDialog(
        baseInput({
          engineMode: { mode: "active", publishedReads: false },
          publishedSession: null,
          publishedSessionFailed: true,
        })
      )
    ).toEqual({ kind: "blocked", reason: "MDF_PUBLICATION_UNAVAILABLE" });
  });
});

describe("mdfReturnBlockReasonText", () => {
  it("has Russian text for every reason this module produces", () => {
    const reasons = [
      "MDF_SOURCE_NOT_REGISTERED",
      "MDF_PUBLICATION_PENDING",
      "MDF_PARTIAL_ACCESS",
      "MDF_COMMAND_TOKEN_MISSING",
      "MDF_ENGINE_NOT_ACTIVE",
      "MDF_PUBLICATION_UNAVAILABLE",
    ];
    for (const reason of reasons) {
      expect(mdfReturnBlockReasonText(reason)).toMatch(/[а-яё]/i);
    }
  });

  it("falls back to a generic message carrying the unknown code", () => {
    expect(mdfReturnBlockReasonText("SOME_NEW_CODE")).toContain("SOME_NEW_CODE");
  });
});

describe('mixed deploy: GET /mdf-engine answers 404', () => {
  it('detects only 404 as a missing endpoint', () => {
    expect(isMdfEngineModeEndpointMissing({ status: 404 })).toBe(true);
    expect(isMdfEngineModeEndpointMissing({ statusCode: 404 })).toBe(true);
    for (const e of [{ status: 503 }, { status: 403 }, new Error('network'), undefined]) {
      expect(isMdfEngineModeEndpointMissing(e)).toBe(false);
    }
  });
  it('an old backend is legacy unless the published snapshot proves an active/read_only engine', () => {
    const card = { kind: 'packet' as const, id: 'p1' };
    const base = { engineMode: null, engineModeEndpointMissing: true, publishedSessionFailed: true, publishedSession: null, card };
    expect(selectMdfReturnDialog(base)).toEqual({ kind: 'legacy' });
    for (const mode of ['active', 'read_only'] as const) {
      expect(selectMdfReturnDialog({ ...base, publishedSessionFailed: false,
        publishedSession: { snapshot: { mode } } as never })).toEqual({ kind: 'blocked', reason: 'MDF_BACKEND_OUTDATED' });
    }
    expect(selectMdfReturnDialog({ ...base, publishedSessionFailed: false,
      publishedSession: { snapshot: { mode: 'legacy' } } as never })).toEqual({ kind: 'legacy' });
    // Without the 404 marker an unknown mode stays unavailable.
    expect(selectMdfReturnDialog({ ...base, engineModeEndpointMissing: false })).toEqual({ kind: 'unavailable' });
  });
});
