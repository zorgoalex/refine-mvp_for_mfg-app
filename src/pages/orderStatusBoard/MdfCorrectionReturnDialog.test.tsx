import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";

const api = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn() }));
vi.mock("../../api/mdfCorrectionApi", () => ({ mdfCorrectionApi: api }));
vi.mock("antd", () => ({
  Modal: "mock-modal",
  Select: "mock-select",
  Alert: "mock-alert",
  Button: "button",
  Spin: "span",
}));

import {
  MdfCorrectionReturnDialog,
  type MdfCorrectionReturnIntent,
} from "./MdfCorrectionReturnDialog";
import type { MdfReturnSelection } from "./mdfReturnSelection";
import type { MdfCorrectionPreviewResponse } from "../../api/mdfCorrectionApi";

const READY_TOKEN = "a".repeat(64);
const intent: MdfCorrectionReturnIntent = {
  source: { kind: "packet", id: "card-1" },
  targetColumn: "parsed",
  targetTitle: "Файлы на станке",
};

function preview(
  overrides: Partial<MdfCorrectionPreviewResponse> = {}
): MdfCorrectionPreviewResponse {
  return {
    protocol: "mdf-correction-v1",
    status: "ready",
    source: { kind: "packet", id: "card-1", label: "Файл E2E" },
    targetColumn: "parsed",
    targetStage: { id: 1, code: "drawn", name: "Отрисован", rank: 10 },
    stages: [{ id: 1, code: "drawn", name: "Отрисован", rank: 10 }],
    sourceToken: READY_TOKEN,
    headFence: { version: "v1", correctionEpoch: "1" },
    digest: "b".repeat(64),
    affectedOrderIds: [1],
    details: [],
    sourceAfter: { afterColumn: null, afterIssues: [] },
    affectedBaths: [],
    orders: [],
    allocationReleases: [],
    allocationReplacements: [],
    deferredPriorAutomation: [],
    cncFreshnessBaseline: null,
    blockers: [],
    warnings: [],
    ...overrides,
  };
}

describe("MdfCorrectionReturnDialog — new (active engine) selection", () => {
  beforeEach(() => {
    api.preview.mockReset().mockResolvedValue(preview());
    api.confirm.mockReset().mockResolvedValue({});
  });

  const mount = async (selection: MdfReturnSelection = { kind: "new", sourceToken: READY_TOKEN },
    reselect = vi.fn(async (): Promise<MdfReturnSelection> => selection)) => {
    const onCancel = vi.fn();
    const onReturned = vi.fn(async () => undefined);
    const onRefreshBoard = vi.fn();
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <MdfCorrectionReturnDialog
          intent={intent}
          selection={selection as never}
          onCancel={onCancel}
          onReturned={onReturned}
          onRefreshBoard={onRefreshBoard}
          reselect={reselect}
          columnTitle={(key) => key}
        />
      );
    });
    return {
      view: view!,
      onCancel,
      onReturned,
      onRefreshBoard,
      reselect,
      modal: () => view!.root.findByType("mock-modal" as never),
    };
  };

  it("previews with the selection's sourceToken and confirms once per idempotency key", async () => {
    const h = await mount();
    expect(api.preview).toHaveBeenCalledWith(
      intent.source,
      expect.objectContaining({ sourceToken: READY_TOKEN, targetColumn: "parsed" })
    );
    await act(async () => h.modal().props.onOk());
    expect(api.confirm).toHaveBeenCalledTimes(1);
    expect(api.confirm.mock.calls[0][1]).toEqual(
      expect.objectContaining({ sourceToken: READY_TOKEN, expectedDigest: preview().digest })
    );
    expect(h.onReturned).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("same-tick double confirmation sends one request; transport retry reuses the key", async () => {
    api.confirm.mockRejectedValueOnce(new Error("network unavailable"));
    const h = await mount();
    await act(async () => {
      h.modal().props.onOk();
      h.modal().props.onOk();
    });
    expect(api.confirm).toHaveBeenCalledTimes(1);
    await act(async () => h.modal().props.onOk());
    expect(api.confirm).toHaveBeenCalledTimes(2);
    expect(api.confirm.mock.calls[0][1].idempotencyKey).toBe(
      api.confirm.mock.calls[1][1].idempotencyKey
    );
    expect(h.onReturned).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("on MDF_CORRECTION_STALE, re-previews automatically and reuses the same key for the next confirmation", async () => {
    const { ApiError } = await import("../../api/apiError");
    const staleError = new ApiError({
      code: "MDF_CORRECTION_STALE",
      message: "Последствия возврата изменились",
      status: 409,
    });
    api.confirm.mockRejectedValueOnce(staleError);
    const h = await mount();
    await act(async () => h.modal().props.onOk());
    // Auto re-preview happened: preview called again beyond the initial mount call.
    expect(api.preview.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(h.onReturned).not.toHaveBeenCalled();
    const firstKey = api.confirm.mock.calls[0][1].idempotencyKey;
    await act(async () => h.modal().props.onOk());
    expect(api.confirm.mock.calls[1][1].idempotencyKey).toBe(firstKey);
    expect(h.onReturned).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("disables confirmation while the preview is blocked", async () => {
    api.preview.mockResolvedValue(
      preview({ status: "blocked", digest: null, blockers: [{ code: "LAMINATION_PROOF_NOT_FOUND" }] })
    );
    const h = await mount();
    expect(h.modal().props.okButtonProps.disabled).toBe(true);
    h.view.unmount();
  });

  it("never calls preview/confirm for a blocked selection; refresh triggers the board callback", async () => {
    const h = await mount({ kind: "blocked", reason: "MDF_PUBLICATION_PENDING" });
    expect(api.preview).not.toHaveBeenCalled();
    const footer = h.modal().props.footer as React.ReactElement[];
    const refresh = footer.find((b) => b.props.children === "Обновить");
    await act(async () => refresh?.props.onClick());
    expect(h.onRefreshBoard).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("shows read_only with no confirm action and never calls the API", async () => {
    const h = await mount({ kind: "read_only" });
    expect(api.preview).not.toHaveBeenCalled();
    const footer = h.modal().props.footer as React.ReactElement[];
    expect(footer.some((b) => b.props.children === "Обновить")).toBe(false);
    h.view.unmount();
  });

  it("shows unavailable text and never calls the API", async () => {
    const h = await mount({ kind: "unavailable" });
    expect(api.preview).not.toHaveBeenCalled();
    expect(
      h.view.root.findByProps({ message: "Режим учёта недоступен" })
    ).toBeTruthy();
    h.view.unmount();
  });

  it("confirms the default preview on the first attempt: productionStatusId mirrors the preview request exactly", async () => {
    const h = await mount();
    expect("productionStatusId" in api.preview.mock.calls[0][1] && api.preview.mock.calls[0][1].productionStatusId !== undefined)
      .toBe(false);
    await act(async () => h.modal().props.onOk());
    expect(api.confirm.mock.calls[0][1]).not.toHaveProperty("productionStatusId");
    // An explicit stage choice is repeated verbatim.
    await act(async () => h.view.root.findByType("mock-select" as never).props.onChange(1));
    expect(api.preview.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ productionStatusId: 1 }));
    h.view.unmount();
  });

  it("after a stale confirm re-resolves the card and previews/confirms with the FRESH token", async () => {
    const { ApiError } = await import("../../api/apiError");
    api.confirm.mockRejectedValueOnce(new ApiError({ code: "MDF_CORRECTION_STALE", message: "stale", status: 409 }));
    const fresh = "c".repeat(64);
    const reselect = vi.fn(async (): Promise<MdfReturnSelection> => ({ kind: "new", sourceToken: fresh }));
    const h = await mount(undefined, reselect);
    await act(async () => h.modal().props.onOk());
    expect(reselect).toHaveBeenCalledOnce();
    expect(api.preview.mock.calls.at(-1)![1]).toEqual(expect.objectContaining({ sourceToken: fresh }));
    await act(async () => h.modal().props.onOk());
    expect(api.confirm.mock.calls[1][1]).toEqual(expect.objectContaining({ sourceToken: fresh }));
    expect(h.onReturned).toHaveBeenCalledOnce();
    h.view.unmount();
  });

  it("after a stale confirm shows why when the card is no longer ready and keeps confirm disabled", async () => {
    const { ApiError } = await import("../../api/apiError");
    api.confirm.mockRejectedValueOnce(new ApiError({ code: "MDF_CORRECTION_STALE", message: "stale", status: 409 }));
    const reselect = vi.fn(async (): Promise<MdfReturnSelection> => ({ kind: "blocked", reason: "MDF_PUBLICATION_PENDING" }));
    const h = await mount(undefined, reselect);
    const previews = api.preview.mock.calls.length;
    await act(async () => h.modal().props.onOk());
    expect(api.preview.mock.calls.length).toBe(previews);
    expect(h.modal().props.okButtonProps.disabled).toBe(true);
    expect(h.view.root.findAllByType("mock-alert" as never).some(a =>
      String(a.props.message).includes("обрабатывается"))).toBe(true);
    h.view.unmount();
  });

  it("stale recovery: confirm stays disabled while re-resolving; the notice appears only with the fresh preview", async () => {
    const { ApiError } = await import("../../api/apiError");
    api.confirm.mockRejectedValueOnce(new ApiError({ code: "MDF_CORRECTION_STALE", message: "stale", status: 409 }));
    let release!: (s: MdfReturnSelection) => void;
    const reselect = vi.fn(() => new Promise<MdfReturnSelection>(r => { release = r; }));
    const h = await mount(undefined, reselect as never);
    await act(async () => h.modal().props.onOk());
    expect(h.modal().props.okButtonProps.disabled).toBe(true);
    await act(async () => h.modal().props.onOk());
    expect(api.confirm).toHaveBeenCalledTimes(1);
    const notice = () => h.view.root.findAllByType("mock-alert" as never)
      .some(a => String(a.props.message).includes("Предпросмотр обновлён"));
    expect(notice()).toBe(false);
    const fresh = "c".repeat(64);
    await act(async () => release({ kind: "new", sourceToken: fresh }));
    expect(api.preview.mock.calls.at(-1)![1].sourceToken).toBe(fresh);
    expect(notice()).toBe(true);
    expect(h.modal().props.okButtonProps.disabled).toBe(false);
    h.view.unmount();
  });

  it("overlapping manual refreshes: an older answer never overwrites a newer one", async () => {
    api.preview.mockReset().mockRejectedValueOnce(new Error("temporarily unavailable")).mockResolvedValue(preview());
    const releases: Array<(s: MdfReturnSelection) => void> = [];
    const reselect = vi.fn(() => new Promise<MdfReturnSelection>(r => { releases.push(r); }));
    const h = await mount(undefined, reselect as never);
    // Capture the handler once (the button disappears after the first click clears the error) and fire it twice.
    const alert = h.view.root.findAllByType("mock-alert" as never).find(a => a.props.action);
    const onRefresh = (alert!.props.action as React.ReactElement).props.onClick;
    await act(async () => { onRefresh(); onRefresh(); });
    expect(reselect).toHaveBeenCalledTimes(2);
    const older = "e".repeat(64), newer = "d".repeat(64);
    await act(async () => releases[1]({ kind: "new", sourceToken: newer }));
    await act(async () => releases[0]({ kind: "new", sourceToken: older }));
    expect(api.preview.mock.calls.at(-1)![1].sourceToken).toBe(newer);
    expect(api.preview.mock.calls.some(c => c[1].sourceToken === older)).toBe(false);
    h.view.unmount();
  });
});

