import { describe, expect, it, vi } from "vitest";

import { trackVisit, type UpsertVisitorInput } from "../src/routes/track-visit";
import {
  MAX_FIELD_LENGTH,
  MAX_TRACK_BODY_BYTES,
  MAX_VISITOR_ID_LENGTH,
} from "../src/utils/lead-context";

function postRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("https://example.com/api/track/visit", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
}

describe("trackVisit", () => {
  it("合法请求：规范化输入并 UPSERT，返回 204", async () => {
    const upsertVisitor = vi.fn().mockResolvedValue(undefined);
    const response = await trackVisit(
      postRequest(
        {
          visitorId: "v-1",
          utmSource: "google",
          utmMedium: "cpc",
          utmCampaign: "spring",
          referrer: "https://google.com",
          landingPage: "/pricing",
          spam: "ignored",
        },
        {
          "x-forwarded-for": "10.0.0.1, 10.0.0.2",
          "cf-ipcountry": "US",
        },
      ),
      { upsertVisitor },
    );

    expect(response.status).toBe(204);
    expect(upsertVisitor).toHaveBeenCalledTimes(1);
    const input = upsertVisitor.mock.calls[0]![0] as UpsertVisitorInput;
    expect(input).toEqual({
      visitorId: "v-1",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      referrer: "https://google.com",
      landingPage: "/pricing",
      ipAddress: "10.0.0.1", // XFF 列表仅取首段
      country: "US",
    });
  });

  it("非法 JSON 请求体：返回 400", async () => {
    const upsertVisitor = vi.fn();
    const response = await trackVisit(postRequest("not-json"), { upsertVisitor });

    expect(response.status).toBe(400);
    expect(upsertVisitor).not.toHaveBeenCalled();
  });

  it("缺失 visitorId：返回 400（fail-fast）", async () => {
    const upsertVisitor = vi.fn();
    const response = await trackVisit(postRequest({ utmSource: "google" }), { upsertVisitor });

    expect(response.status).toBe(400);
    expect(upsertVisitor).not.toHaveBeenCalled();
  });

  it("空字符串 visitorId：返回 400", async () => {
    const upsertVisitor = vi.fn();
    const response = await trackVisit(postRequest({ visitorId: "" }), { upsertVisitor });

    expect(response.status).toBe(400);
    expect(upsertVisitor).not.toHaveBeenCalled();
  });

  it("可选字段缺省与 IP 头缺失：字段为 undefined，仍返回 204", async () => {
    const upsertVisitor = vi.fn().mockResolvedValue(undefined);
    const response = await trackVisit(postRequest({ visitorId: "v-2", utmMedium: 123 }), {
      upsertVisitor,
    });

    expect(response.status).toBe(204);
    expect(upsertVisitor.mock.calls[0]![0]).toEqual({
      visitorId: "v-2",
      utmSource: undefined,
      utmMedium: undefined, // 非 string 输入被过滤
      utmCampaign: undefined,
      referrer: undefined,
      landingPage: undefined,
      ipAddress: undefined,
      country: undefined,
    });
  });

  it("落库失败：返回显式 500，不向宿主抛出未处理 rejection", async () => {
    const upsertVisitor = vi.fn().mockRejectedValue(new Error("db down"));
    const response = await trackVisit(postRequest({ visitorId: "v-5" }), { upsertVisitor });

    expect(response.status).toBe(500);
  });

  it("优先级：cf-connecting-ip > x-real-ip > x-forwarded-for", async () => {
    const upsertVisitor = vi.fn().mockResolvedValue(undefined);
    await trackVisit(
      postRequest({ visitorId: "v-3" }, {
        "cf-connecting-ip": "1.1.1.1",
        "x-real-ip": "2.2.2.2",
        "x-forwarded-for": "3.3.3.3",
      }),
      { upsertVisitor },
    );
    await trackVisit(
      postRequest({ visitorId: "v-4" }, { "x-real-ip": "2.2.2.2" }),
      { upsertVisitor },
    );

    expect(upsertVisitor.mock.calls[0]![0].ipAddress).toBe("1.1.1.1");
    expect(upsertVisitor.mock.calls[1]![0].ipAddress).toBe("2.2.2.2");
  });

  it("超长 visitorId（>64）：返回 400，不落库（V1）", async () => {
    const upsertVisitor = vi.fn();
    const response = await trackVisit(
      postRequest({ visitorId: "v".repeat(MAX_VISITOR_ID_LENGTH + 1) }),
      { upsertVisitor },
    );

    expect(response.status).toBe(400);
    expect(upsertVisitor).not.toHaveBeenCalled();
  });

  it("超长 utmSource（>2048）：字段丢弃但访问记录保留（V1）", async () => {
    const upsertVisitor = vi.fn().mockResolvedValue(undefined);
    const response = await trackVisit(
      postRequest({
        visitorId: "v-6",
        utmSource: "x".repeat(MAX_FIELD_LENGTH + 1),
      }),
      { upsertVisitor },
    );

    expect(response.status).toBe(204);
    expect(upsertVisitor).toHaveBeenCalledTimes(1);
    expect(upsertVisitor.mock.calls[0]![0].utmSource).toBeUndefined();
  });

  it("请求体超 16KB 字节上限：返回 413，不做 JSON.parse 也不落库", async () => {
    const upsertVisitor = vi.fn();
    // 伪 content-length 头声明合法大小，验证按实际读入字节拒绝（头不可信）
    const oversize = `{"visitorId":"v","pad":"${"x".repeat(MAX_TRACK_BODY_BYTES)}"}`;
    const request = postRequest(oversize, { "content-length": "20" });
    const response = await trackVisit(request, { upsertVisitor });

    expect(response.status).toBe(413);
    expect(upsertVisitor).not.toHaveBeenCalled();
  });

  it("请求体恰好在上限内：正常处理返回 204（边界）", async () => {
    const upsertVisitor = vi.fn().mockResolvedValue(undefined);
    // visitorId 64 + 六个 2048 字段的合法最坏情况 ≈ 12.4KB < 16KB
    const response = await trackVisit(
      postRequest({
        visitorId: "v".repeat(MAX_VISITOR_ID_LENGTH),
        utmSource: "s".repeat(MAX_FIELD_LENGTH),
        utmMedium: "m".repeat(MAX_FIELD_LENGTH),
        utmCampaign: "c".repeat(MAX_FIELD_LENGTH),
        referrer: "r".repeat(MAX_FIELD_LENGTH),
        landingPage: "/".repeat(MAX_FIELD_LENGTH),
      }),
      { upsertVisitor },
    );

    expect(response.status).toBe(204);
    expect(upsertVisitor).toHaveBeenCalledTimes(1);
  });
});
