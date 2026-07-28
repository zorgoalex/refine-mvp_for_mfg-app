import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const listSource = readFileSync(new URL("./list.tsx", import.meta.url), "utf8");
const listCss = readFileSync(new URL("./list.css", import.meta.url), "utf8");

describe("order snapshot import progress guard", () => {
  it("shows a blocking spinner modal while JSON import is running", () => {
    expect(listSource).toContain("snapshotImportBusy");
    expect(listSource).toContain("<Spin size=\"large\" />");
    expect(listSource).toContain("Импорт выполняется");
    expect(listSource).toContain("maskClosable={false}");
    expect(listSource).toContain("keyboard={false}");
    expect(listCss).toContain(".orders-snapshot-import-progress");
  });
});
