import { describe, expect, it, vi } from "vitest";

import {
  recordConversion,
  type ConversionDeps,
  type UserLeadAttribution,
} from "../src/conversion";

const DAY_MS = 86_400_000;

function buildDeps(lead: UserLeadAttribution | null = null) {
  return {
    findUserLead: vi.fn().mockResolvedValue(lead),
    insertConversionEvent: vi.fn().mockResolvedValue(undefined),
  } satisfies ConversionDeps;
}

describe("recordConversion（数据库无关：纯注入实现）", () => {
  it("有归因记录：查询、计算转化天数并写入完整转化事件", async () => {
    const now = new Date("2026-09-20T12:00:00Z").getTime();
    const deps = buildDeps({
      utmSource: "google",
      country: "US",
      signupAt: new Date(now - 5 * DAY_MS),
    });

    await recordConversion({ userId: "u1", plan: "pro" }, { ...deps, now: () => now });

    expect(deps.findUserLead).toHaveBeenCalledWith("u1");
    expect(deps.insertConversionEvent).toHaveBeenCalledWith({
      userId: "u1",
      plan: "pro",
      utmSource: "google",
      country: "US",
      daysToConvert: 5,
    });
  });

  it("转化天数向下取整（5.5 天 → 5）", async () => {
    const now = new Date("2026-09-20T12:00:00Z").getTime();
    const deps = buildDeps({
      utmSource: null,
      country: null,
      signupAt: new Date(now - 5.5 * DAY_MS),
    });

    await recordConversion({ userId: "u1", plan: "pro" }, { ...deps, now: () => now });

    expect(deps.insertConversionEvent.mock.calls[0]![0].daysToConvert).toBe(5);
  });

  it("无归因记录：utmSource/country/daysToConvert 均为 null", async () => {
    const deps = buildDeps(null);

    await recordConversion({ userId: "u-none", plan: "team" }, { ...deps, now: Date.now });

    expect(deps.insertConversionEvent).toHaveBeenCalledWith({
      userId: "u-none",
      plan: "team",
      utmSource: null,
      country: null,
      daysToConvert: null,
    });
  });

  it("dedupeKey 透传到转化事件行（支付 webhook 重试幂等，V2）", async () => {
    const deps = buildDeps(null);

    await recordConversion(
      { userId: "u1", plan: "pro", dedupeKey: "sub_123" },
      { ...deps, now: Date.now },
    );

    expect(deps.insertConversionEvent.mock.calls[0]![0].dedupeKey).toBe("sub_123");
  });
});
