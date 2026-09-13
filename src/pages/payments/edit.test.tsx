import React from "react";
import { renderToString } from "react-dom/server";
import dayjs from "dayjs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({ paymentDate: "2026-09-08" as unknown }));

vi.mock("@refinedev/antd", () => ({
  Edit: ({ children }: React.PropsWithChildren) => <>{children}</>,
  useSelect: () => ({ selectProps: { options: [] } }),
}));

vi.mock("../../hooks/useFormWithHighlight", () => ({
  useFormWithHighlight: () => ({
    formProps: { initialValues: { payment_date: fixture.paymentDate } },
    saveButtonProps: {},
    queryResult: { data: { data: { payment_date: fixture.paymentDate } } },
  }),
}));

import { PaymentEdit } from "./edit";

beforeEach(() => vi.stubGlobal("React", React));
afterEach(() => vi.unstubAllGlobals());

describe("payment edit cached date", () => {
  it.each([
    ["API string", "2026-09-08"],
    ["already converted date", dayjs("2026-09-08")],
  ])("renders a %s before effects run", (_, value) => {
    fixture.paymentDate = value;
    expect(renderToString(<PaymentEdit />)).toContain('id="payment_date"');
  });

  it("renders an empty date without selecting today", () => {
    fixture.paymentDate = undefined;
    expect(renderToString(<PaymentEdit />)).toMatch(/placeholder="Выберите дату"[^>]*value=""/);
  });
});
