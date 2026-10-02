import { describe, expect, it, vi } from "vitest";
import { ApiError } from "../../common/errors/api-error";
import { WahaClient } from "./waha.client";
import type { WhatsAppRuntimeConfigService } from "./whatsapp-runtime-config.service";
import { normalizeWahaGroups, parseGroupsRefresh, WHATSAPP_GROUPS_MAX } from "./whatsapp-groups";
import { WhatsAppService } from "./whatsapp.service";

// Field set captured from production WAHA GOWS 2026.8.2 (`GET /api/{session}/groups?exclude=participants`,
// shape only); every value here is invented.
function gowsGroup(overrides: Record<string, unknown> = {}) {
  return {
    JID: "120363000000000001@g.us", OwnerJID: "77010000001@s.whatsapp.net", OwnerPN: "77010000001@s.whatsapp.net",
    Name: "ЧПУ", NameSetAt: "2025-01-01T00:00:00Z", NameSetBy: "77010000001@s.whatsapp.net", NameSetByPN: "77010000001@s.whatsapp.net",
    Topic: "Секретное описание", TopicID: "t1", TopicSetAt: "2025-01-01T00:00:00Z", TopicSetBy: "77010000002@s.whatsapp.net",
    TopicSetByPN: "77010000002@s.whatsapp.net", TopicDeleted: false, IsLocked: false, IsAnnounce: false,
    AnnounceVersionID: "a1", IsEphemeral: false, DisappearingTimer: 0, IsIncognito: false, IsParent: false,
    DefaultMembershipApprovalMode: "", LinkedParentJID: "", IsDefaultSubGroup: false, IsJoinApprovalRequired: false,
    AddressingMode: "lid", GroupCreated: "2025-01-01T00:00:00Z", CreatorCountryCode: "KZ", ParticipantVersionID: "p1",
    ParticipantCount: 12, MemberAddMode: "admin_add", Suspended: false,
    ...overrides,
  };
}

describe("normalizeWahaGroups", () => {
  it("returns only allowlisted fields of the production GOWS shape", () => {
    const result = normalizeWahaGroups([gowsGroup()]);
    expect(result).toEqual({
      groups: [{ id: "120363000000000001@g.us", name: "ЧПУ", participantCount: 12, announceOnly: false, communityParent: false, suspended: false }],
      truncated: false,
    });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain("77010000001");
    expect(serialized).not.toContain("77010000002");
    expect(serialized).not.toContain("Секретное описание");
  });

  it("maps admin-only, community and suspended flags and sorts by Russian name", () => {
    const { groups } = normalizeWahaGroups([
      gowsGroup({ JID: "120363000000000003@g.us", Name: "Склад", Suspended: true }),
      gowsGroup({ JID: "120363000000000002@g.us", Name: "бухгалтерия", IsAnnounce: true, IsParent: true }),
    ]);
    expect(groups.map((group) => group.name)).toEqual(["бухгалтерия", "Склад"]);
    expect(groups[0]).toMatchObject({ announceOnly: true, communityParent: true, suspended: false });
    expect(groups[1]).toMatchObject({ announceOnly: false, suspended: true });
  });

  it("accepts WEBJS and NOWEB shapes and legacy hyphenated IDs", () => {
    expect(normalizeWahaGroups([{ id: { _serialized: "77010000001-1600000000@g.us" }, name: "Старая" }]).groups[0])
      .toMatchObject({ id: "77010000001-1600000000@g.us", name: "Старая", participantCount: null });
    expect(normalizeWahaGroups({ "120363000000000004@g.us": { subject: "Офис", announce: true, size: 3 } }).groups[0])
      .toMatchObject({ id: "120363000000000004@g.us", name: "Офис", announceOnly: true, participantCount: 3 });
  });

  it("drops invalid, non-group and duplicate entries and cleans names", () => {
    const { groups } = normalizeWahaGroups([
      gowsGroup({ Name: "  Цех\n\u0007 1  " }),
      gowsGroup({ Name: "Дубль" }),
      gowsGroup({ JID: "77010000001@s.whatsapp.net" }),
      gowsGroup({ JID: "../../etc@g.us" }),
      gowsGroup({ JID: "120363000000000005@g.us", Name: "x".repeat(300), ParticipantCount: -1 }),
      null, "text", 42,
    ]);
    // Russian collation puts Cyrillic names before Latin ones.
    expect(groups.map((group) => group.id)).toEqual(["120363000000000001@g.us", "120363000000000005@g.us"]);
    expect(groups[0].name).toBe("Цех 1");
    expect(groups[1].name).toHaveLength(200);
    expect(groups[1].participantCount).toBeNull();
  });

  it("treats an empty list as no groups but rejects broken or unsupported answers", () => {
    expect(normalizeWahaGroups([])).toEqual({ groups: [], truncated: false });
    for (const broken of [undefined, null, {}, { status: "error" }, "[]", [null, "text", { JID: "77010000001@s.whatsapp.net" }]]) {
      expect(() => normalizeWahaGroups(broken), JSON.stringify(broken)).toThrow(
        expect.objectContaining({ statusCode: 502, code: "WAHA_GROUPS_RESPONSE_INVALID" }),
      );
    }
  });

  it("caps the list and reports truncation", () => {
    const many = Array.from({ length: WHATSAPP_GROUPS_MAX + 1 }, (_, index) =>
      gowsGroup({ JID: `1203630000${String(index).padStart(8, "0")}@g.us`, Name: `Группа ${index}` }));
    const result = normalizeWahaGroups(many);
    expect(result.groups).toHaveLength(WHATSAPP_GROUPS_MAX);
    expect(result.truncated).toBe(true);
  });
});

describe("parseGroupsRefresh", () => {
  it("accepts only boolean-like values", () => {
    expect(parseGroupsRefresh(undefined)).toBe(false);
    expect(parseGroupsRefresh("false")).toBe(false);
    expect(parseGroupsRefresh("1")).toBe(true);
    expect(parseGroupsRefresh("true")).toBe(true);
    expect(() => parseGroupsRefresh("yes")).toThrow(ApiError);
    expect(() => parseGroupsRefresh(["true"])).toThrow(ApiError);
  });
});

function groupsService(options: { enabled?: boolean; session?: string } = {}) {
  const client = {
    session: vi.fn().mockResolvedValue({ status: options.session ?? "WORKING" }),
    groups: vi.fn().mockResolvedValue([gowsGroup()]),
  };
  const record = vi.fn().mockResolvedValue(undefined);
  const service = new WhatsAppService(
    { getConfig: () => ({ enabled: options.enabled ?? true }) } as never,
    {} as never,
    client as never,
    {} as never,
    { record } as never,
  );
  return { service, client, record };
}

describe("WhatsAppService.listGroups", () => {
  it("requires a WORKING session and never calls the groups API otherwise", async () => {
    const { service, client } = groupsService({ session: "SCAN_QR_CODE" });
    await expect(service.listGroups()).rejects.toMatchObject({ statusCode: 409, code: "WHATSAPP_SESSION_NOT_READY" });
    expect(client.groups).not.toHaveBeenCalled();
  });

  it("fails closed when WhatsApp is disabled", async () => {
    const { service, client } = groupsService({ enabled: false });
    await expect(service.listGroups()).rejects.toMatchObject({ code: "WHATSAPP_NOT_CONFIGURED" });
    expect(client.session).not.toHaveBeenCalled();
  });

  it("asks WAHA for one item over the cap and serves the cache for 60 seconds", async () => {
    const { service, client } = groupsService();
    const now = Date.now();
    const first = await service.listGroups(false, now);
    expect(first).toMatchObject({ cached: false, truncated: false, groups: [{ name: "ЧПУ" }] });
    expect(client.groups).toHaveBeenCalledWith(WHATSAPP_GROUPS_MAX + 1);
    await expect(service.listGroups(false, now + 59_000)).resolves.toMatchObject({ cached: true, fetchedAt: first.fetchedAt });
    expect(client.groups).toHaveBeenCalledTimes(1);
    await expect(service.listGroups(false, now + 61_000)).resolves.toMatchObject({ cached: false });
    expect(client.groups).toHaveBeenCalledTimes(2);
  });

  it("lets refresh bypass the cache at most once per 10 seconds", async () => {
    const { service, client } = groupsService();
    const now = Date.now();
    await service.listGroups(false, now);
    await expect(service.listGroups(true, now + 5_000)).resolves.toMatchObject({ cached: true });
    await expect(service.listGroups(true, now + 11_000)).resolves.toMatchObject({ cached: false });
    expect(client.groups).toHaveBeenCalledTimes(2);
  });

  it("shares one in-flight WAHA request between concurrent callers", async () => {
    const { service, client } = groupsService();
    let release!: (value: unknown) => void;
    client.groups.mockReturnValueOnce(new Promise((resolve) => { release = resolve; }));
    const pending = Promise.all([service.listGroups(), service.listGroups(true)]);
    await vi.waitFor(() => expect(client.groups).toHaveBeenCalledTimes(1));
    release([gowsGroup()]);
    const [a, b] = await pending;
    expect(a.fetchedAt).toBe(b.fetchedAt);
    expect(client.groups).toHaveBeenCalledTimes(1);
  });

  it("keeps the 10-second cooldown after failures and retries afterwards", async () => {
    const { service, client } = groupsService();
    const now = Date.now();
    client.groups.mockRejectedValueOnce(new ApiError(503, "WAHA_UNAVAILABLE", "WAHA is unavailable"));
    await expect(service.listGroups(false, now)).rejects.toMatchObject({ code: "WAHA_UNAVAILABLE" });
    await expect(service.listGroups(true, now + 1_000)).rejects.toMatchObject({ code: "WAHA_UNAVAILABLE" });
    await expect(service.listGroups(false, now + 9_000)).rejects.toMatchObject({ code: "WAHA_UNAVAILABLE" });
    expect(client.session).toHaveBeenCalledTimes(1);
    expect(client.groups).toHaveBeenCalledTimes(1);
    await expect(service.listGroups(false, now + 10_000)).resolves.toMatchObject({ cached: false });
    expect(client.groups).toHaveBeenCalledTimes(2);
  });

  it("serves the last good list during the cooldown after a failed refresh", async () => {
    const { service, client } = groupsService();
    const now = Date.now();
    const first = await service.listGroups(false, now);
    client.groups.mockRejectedValueOnce(new ApiError(502, "WAHA_PROVIDER_ERROR", "WAHA request failed (500)"));
    await expect(service.listGroups(true, now + 20_000)).rejects.toMatchObject({ code: "WAHA_PROVIDER_ERROR" });
    await expect(service.listGroups(true, now + 21_000)).resolves.toMatchObject({ cached: true, fetchedAt: first.fetchedAt });
    expect(client.groups).toHaveBeenCalledTimes(2);
  });

  it("does not cache an invalid WAHA answer and records a redacted technical event", async () => {
    const { service, client, record } = groupsService();
    const now = Date.now();
    client.groups.mockResolvedValueOnce({});
    await expect(service.listGroups(false, now)).rejects.toMatchObject({ code: "WAHA_GROUPS_RESPONSE_INVALID" });
    expect(record).toHaveBeenCalledWith(expect.objectContaining({
      eventCode: "waha.groups.response", errorCode: "WAHA_GROUPS_RESPONSE_INVALID", details: { container: "object" },
    }));
    await expect(service.listGroups(false, now + 10_000)).resolves.toMatchObject({ cached: false, groups: [{ name: "ЧПУ" }] });
  });
});

describe("WahaClient.groups", () => {
  it("requests groups without participants and logs the path without the session name", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response("[]", { status: 200, headers: { "content-type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const record = vi.fn();
    try {
      const client = new WahaClient(
        { getConfig: () => ({ enabled: true, baseUrl: "http://waha:3000", apiKey: "a".repeat(32), sessionName: "erp", requestTimeoutMs: 1000 }) } as unknown as WhatsAppRuntimeConfigService,
        { record } as never,
      );
      await expect(client.groups(1001)).resolves.toEqual([]);
      expect(fetchMock).toHaveBeenCalledWith(
        "http://waha:3000/api/erp/groups?exclude=participants&limit=1001",
        expect.objectContaining({ headers: expect.objectContaining({ "X-Api-Key": "a".repeat(32) }) }),
      );
      expect(record).toHaveBeenCalledWith(expect.objectContaining({ operation: "GET /api/{session}/groups" }));
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
