import React from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { beforeEach, describe, expect, it, vi } from "vitest";
const api = vi.hoisted(() => ({ preview: vi.fn(), confirm: vi.fn() }));
vi.mock("../../api/mdfProductionReturnApi", () => ({
  mdfProductionReturnApi: api,
}));
vi.mock("antd", () => ({
  Modal: "mock-modal",
  Select: "mock-select",
  Alert: "mock-alert",
  Button: "button",
  Spin: "span",
}));
import {
  MdfProductionReturnDialog,
  isMdfBackwardMove,
} from "./MdfProductionReturnDialog";
import type { MdfReturnPreview } from "../../api/mdfProductionReturnApi";
const preview: MdfReturnPreview = {
  source: { kind: "packet", id: "packet", label: "Файл E2E" },
  targetColumn: "parsed",
  targetStage: { id: 1, name: "Отрисован", code: "drawn", rank: 10 },
  stages: [{ id: 1, name: "Отрисован", code: "drawn", rank: 10 }],
  digest: "a".repeat(64),
  details: [
    {
      detailId: 11,
      orderId: 1,
      orderName: "E2E",
      detailNumber: 1,
      quantity: 10,
      cardQuantity: 5,
      before: "Упакован",
      after: "Отрисован",
    },
  ],
  orders: [
    { orderId: 1, orderName: "E2E", before: "Выдан", after: "В производстве" },
  ],
  cards: [
    {
      kind: "packet",
      id: "packet",
      label: "Файл E2E",
      before: "completed_laminated",
      after: "parsed",
    },
  ],
  resetsCompletion: true,
  warnings: [],
};
describe("MDF return confirmation interaction", () => {
  beforeEach(() => {
    api.preview.mockReset().mockResolvedValue(preview);
    api.confirm.mockReset().mockResolvedValue({});
  });
  const mount = async () => {
    const onCancel = vi.fn(),
      onReturned = vi.fn(async () => undefined);
    let view: ReactTestRenderer;
    await act(async () => {
      view = create(
        <MdfProductionReturnDialog
          intent={{
            source: preview.source,
            targetColumn: "parsed",
            targetTitle: "Файлы на станке",
          }}
          onCancel={onCancel}
          onReturned={onReturned}
          columnTitle={(key) => key}
        />
      );
    });
    return {
      view: view!,
      onCancel,
      onReturned,
      modal: () => view!.root.findByType("mock-modal" as never),
    };
  };
  it("shows consequences without a reason field; cancellation sends no mutation", async () => {
    const h = await mount();
    expect(
      h.view.root.findByProps({ message: "Статус заказа тоже изменится" })
    ).toBeTruthy();
    expect(h.view.root.findAllByType("textarea")).toHaveLength(0);
    await act(async () => h.modal().props.onCancel());
    expect(h.onCancel).toHaveBeenCalledOnce();
    expect(api.confirm).not.toHaveBeenCalled();
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
    expect(api.confirm.mock.calls[0][1]).not.toHaveProperty("reason");
    expect(h.onReturned).toHaveBeenCalledOnce();
    h.view.unmount();
  });
  it("stale preview disables confirmation until refreshed", async () => {
    api.confirm.mockRejectedValueOnce(
      Object.assign(new Error("stale"), { status: 409 })
    );
    const h = await mount();
    await act(async () => h.modal().props.onOk());
    expect(h.modal().props.okButtonProps.disabled).toBe(true);
    expect(h.onReturned).not.toHaveBeenCalled();
    h.view.unmount();
  });
  it("intercepts backwards production moves only", () => {
    expect(isMdfBackwardMove("packet", "completed_laminated", "parsed")).toBe(
      true
    );
    expect(isMdfBackwardMove("bath", "baths_laminated", "baths_ready")).toBe(
      true
    );
    expect(isMdfBackwardMove("bazisCutSet", "completed", "parsed")).toBe(true);
    expect(isMdfBackwardMove("packet", "parsed", "completed")).toBe(false);
    expect(isMdfBackwardMove("order", "orders_issued", "orders_ready")).toBe(
      false
    );
  });
});
