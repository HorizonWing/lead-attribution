import { describe, expect, it } from "vitest";

import {
  isLeadContext,
  isVisitorId,
  LEAD_COOKIE,
  LEAD_COOKIE_MAX_AGE,
  MAX_FIELD_LENGTH,
  MAX_VISITOR_ID_LENGTH,
  normalizeLeadContext,
  optionalString,
  parseLeadCookieValue,
  serializeLeadCookie,
  type LeadContext,
} from "../src/utils/lead-context";

const SAMPLE: LeadContext = { visitorId: "v-1", utmSource: "google", landingPage: "/pricing" };

describe("parseLeadCookieValue", () => {
  it("解析编码后的 cookie 值（ctx.getCookie 的返回值）", () => {
    expect(parseLeadCookieValue(encodeURIComponent(JSON.stringify(SAMPLE)))).toEqual(SAMPLE);
  });

  it("未编码的 JSON 值同样可解析", () => {
    expect(parseLeadCookieValue(JSON.stringify(SAMPLE))).toEqual(SAMPLE);
  });

  it("空/缺失值返回 null", () => {
    expect(parseLeadCookieValue(null)).toBeNull();
    expect(parseLeadCookieValue(undefined)).toBeNull();
    expect(parseLeadCookieValue("")).toBeNull();
  });

  it("非法 JSON 返回 null（永不抛出）", () => {
    expect(parseLeadCookieValue("%7Bnot-json")).toBeNull();
  });

  it("缺失 visitorId 的载荷返回 null", () => {
    expect(parseLeadCookieValue(encodeURIComponent('{"utmSource":"x"}'))).toBeNull();
  });

  it("伪造 cookie 的非 string 可选字段被归一化，不进入落库链路", () => {
    const forged = encodeURIComponent(
      JSON.stringify({ visitorId: "v-9", utmSource: { hack: true }, utmMedium: 123 }),
    );
    expect(parseLeadCookieValue(forged)).toEqual({
      visitorId: "v-9",
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      referrer: undefined,
      landingPage: undefined,
    });
  });
});

describe("serializeLeadCookie", () => {
  it("生成含安全属性的 cookie 字符串", () => {
    const cookie = serializeLeadCookie(SAMPLE);
    expect(cookie).toContain(`${LEAD_COOKIE}=${encodeURIComponent(JSON.stringify(SAMPLE))}`);
    expect(cookie).toContain(`max-age=${LEAD_COOKIE_MAX_AGE}`);
    expect(cookie).toContain("path=/");
    expect(cookie).toContain("samesite=lax");
  });

  it("serialize → parse 往返一致", () => {
    const cookie = serializeLeadCookie(SAMPLE);
    const [pair] = cookie.split(";");
    const separator = pair!.indexOf("=");
    const value = pair!.slice(separator + 1);
    expect(pair!.slice(0, separator)).toBe(LEAD_COOKIE);
    expect(parseLeadCookieValue(value)).toEqual(SAMPLE);
  });
});

describe("isLeadContext", () => {
  it("仅当 visitorId 为非空字符串时通过", () => {
    expect(isLeadContext({ visitorId: "v-1" })).toBe(true);
    expect(isLeadContext({ visitorId: "" })).toBe(false);
    expect(isLeadContext({})).toBe(false);
    expect(isLeadContext(null)).toBe(false);
    expect(isLeadContext("v-1")).toBe(false);
  });
});

describe("normalizeLeadContext", () => {
  it("可选字段仅保留非空 string（对象/数字/空串归为 undefined）", () => {
    expect(
      normalizeLeadContext({
        visitorId: "v-1",
        utmSource: { evil: true },
        utmMedium: 123,
        utmCampaign: "",
        referrer: "https://google.com",
        landingPage: null,
      }),
    ).toEqual({
      visitorId: "v-1",
      utmSource: undefined,
      utmMedium: undefined,
      utmCampaign: undefined,
      referrer: "https://google.com",
      landingPage: undefined,
    });
  });

  it("缺失 visitorId 返回 null", () => {
    expect(normalizeLeadContext({ utmSource: "x" })).toBeNull();
    expect(normalizeLeadContext(null)).toBeNull();
  });
});

describe("optionalString", () => {
  it("仅非空 string 通过，其余归为 undefined", () => {
    expect(optionalString("x")).toBe("x");
    expect(optionalString("")).toBeUndefined();
    expect(optionalString(123)).toBeUndefined();
    expect(optionalString({})).toBeUndefined();
    expect(optionalString(undefined)).toBeUndefined();
  });
});

describe("isVisitorId", () => {
  it("限长边界：64 字符通过，65 字符拒绝", () => {
    expect(isVisitorId("v".repeat(MAX_VISITOR_ID_LENGTH))).toBe(true);
    expect(isVisitorId("v".repeat(MAX_VISITOR_ID_LENGTH + 1))).toBe(false);
  });

  it("空串与非 string 拒绝", () => {
    expect(isVisitorId("")).toBe(false);
    expect(isVisitorId(123)).toBe(false);
    expect(isVisitorId(undefined)).toBe(false);
    expect(isVisitorId(null)).toBe(false);
  });
});

describe("字段限长（V1：cookie 与请求体两个入口同一规则）", () => {
  it("optionalString：2048 字符保留，2049 字符归为 undefined", () => {
    expect(optionalString("x".repeat(MAX_FIELD_LENGTH))).toBe("x".repeat(MAX_FIELD_LENGTH));
    expect(optionalString("x".repeat(MAX_FIELD_LENGTH + 1))).toBeUndefined();
  });

  it("normalizeLeadContext：visitorId 超长整体判非法（null）", () => {
    expect(normalizeLeadContext({ visitorId: "v".repeat(MAX_VISITOR_ID_LENGTH + 1) })).toBeNull();
  });

  it("normalizeLeadContext：可选字段超长归 undefined，记录本身保留", () => {
    expect(
      normalizeLeadContext({
        visitorId: "v-1",
        utmSource: "x".repeat(MAX_FIELD_LENGTH + 1),
        utmMedium: "ok",
      }),
    ).toEqual({
      visitorId: "v-1",
      utmSource: undefined,
      utmMedium: "ok",
      utmCampaign: undefined,
      referrer: undefined,
      landingPage: undefined,
    });
  });

  it("parseLeadCookieValue 对超长 visitorId 的 cookie 同样返回 null", () => {
    const forged = encodeURIComponent(
      JSON.stringify({ visitorId: "v".repeat(MAX_VISITOR_ID_LENGTH + 1) }),
    );
    expect(parseLeadCookieValue(forged)).toBeNull();
  });
});

describe("serializeLeadCookie secure（V5）", () => {
  it("secure: true 追加 ; secure", () => {
    expect(serializeLeadCookie(SAMPLE, { secure: true })).toContain("; secure");
  });

  it("默认（HTTP 本地开发）不含 secure", () => {
    expect(serializeLeadCookie(SAMPLE)).not.toContain("secure");
  });
});
