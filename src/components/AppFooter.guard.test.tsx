import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./AppFooter.tsx", import.meta.url), "utf8");

describe("AppFooter release notes tooltip", () => {
  it("anchors the tooltip to the right edge so it cannot widen the viewport", () => {
    expect(source).toContain(
      '<Tooltip title="Журнал изменений" placement="topRight">',
    );
  });
});
