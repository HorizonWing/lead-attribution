import { describe, expect, it } from "vitest";

import {
  isLeadContext,
  LEAD_COOKIE,
  LEAD_COOKIE_MAX_AGE,
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
