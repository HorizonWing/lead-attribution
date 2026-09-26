/**
 * captureVisitorContext 单测：node 环境下用 vi.stubGlobal 桩化浏览器全局对象
 * （document / window / crypto / fetch），不引入 jsdom 等额外依赖。
 */
import { afterEach, describe, expect, it, vi } from "vitest";

import { captureVisitorContext } from "../src/utils/lead-tracker.client";
import { LEAD_COOKIE, parseLeadCookieValue } from "../src/utils/lead-context";

interface BrowserStubOptions {
  cookie?: string;
  search?: string;
  pathname?: string;
  referrer?: string;
  crypto?: unknown;
}

/** 桩化浏览器环境；返回可断言的 document 引用与 fetch mock */
function stubBrowser({
  cookie = "",
  search = "",
  pathname = "/lp",
  referrer = "",
  crypto: cryptoStub = { randomUUID: () => "uuid-stub-0001" },
}: BrowserStubOptions = {}) {
  const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 204 }));
  const documentStub = { cookie, referrer };
  vi.stubGlobal("document", documentStub);
  vi.stubGlobal("window", { location: { search, pathname } });
  vi.stubGlobal("crypto", cryptoStub);
  vi.stubGlobal("fetch", fetchMock);
  return { documentStub, fetchMock };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("captureVisitorContext", () => {
  it("SSR 环境（无 document）：直接跳过，不抛出", () => {
    expect(() => captureVisitorContext()).not.toThrow();
  });

  it("首次访问：写线索 cookie 并异步上报（keepalive，UTM/referrer/落地页齐全）", () => {
    const { documentStub, fetchMock } = stubBrowser({
      search: "?utm_source=nl&utm_medium=email",
      referrer: "https://x.com/page",
    });

    captureVisitorContext();

    expect(documentStub.cookie).toContain(`${LEAD_COOKIE}=`);
    expect(parseLeadCookieValue(documentStub.cookie.split(`${LEAD_COOKIE}=`)[1]?.split(";")[0])).toMatchObject({
      visitorId: "uuid-stub-0001",
      utmSource: "nl",
      utmMedium: "email",
      referrer: "https://x.com/page",
      landingPage: "/lp",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/track/visit");
    expect(init.method).toBe("POST");
    expect((init as RequestInit & { keepalive?: boolean }).keepalive).toBe(true);
    expect(JSON.parse(String(init.body))).toMatchObject({
      visitorId: "uuid-stub-0001",
      utmSource: "nl",
    });
  });

  it("自定义 endpoint 生效", () => {
    const { fetchMock } = stubBrowser();
    captureVisitorContext({ endpoint: "https://collector.example.com/v" });
    expect(fetchMock.mock.calls[0]![0]).toBe("https://collector.example.com/v");
  });

  it("已采集过（存在本 cookie）：跳过，不覆盖首次来源", () => {
    const { documentStub, fetchMock } = stubBrowser({
      cookie: `other=1; ${LEAD_COOKIE}=existing; x=2`,
    });

    captureVisitorContext();

    expect(fetchMock).not.toHaveBeenCalled();
    expect(documentStub.cookie).toContain(`${LEAD_COOKIE}=existing`);
  });

  it("边界匹配：xba_lead_ctx= 之类后缀同名 cookie 不误判为已采集", () => {
    const { fetchMock } = stubBrowser({ cookie: "xba_lead_ctx=1" });
    captureVisitorContext();
    expect(fetchMock).toHaveBeenCalled();
  });

  it("非安全上下文（无 crypto.randomUUID）：回退 getRandomValues 生成 UUID v4 形状", () => {
    const { fetchMock } = stubBrowser({
      crypto: { getRandomValues: (bytes: Uint8Array) => bytes.fill(0xab) },
    });

    captureVisitorContext();

    const body = JSON.parse(String(fetchMock.mock.calls[0]![1].body)) as { visitorId: string };
    expect(body.visitorId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("上报失败静默忽略：fetch reject 不抛出", () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("network down"));
    vi.stubGlobal("document", { cookie: "", referrer: "" });
    vi.stubGlobal("window", { location: { search: "", pathname: "/lp" } });
    vi.stubGlobal("crypto", { randomUUID: () => "uuid-stub-0001" });
    vi.stubGlobal("fetch", fetchMock);

    expect(() => captureVisitorContext()).not.toThrow();
  });
});
