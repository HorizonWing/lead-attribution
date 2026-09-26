import { describe, expect, it, vi } from "vitest";

import {
  handleLeadAttribution,
  leadAttribution,
  runLeadAttributionSafely,
  type AttributionHookContext,
} from "../src/plugins/lead-attribution";
import {
  LEAD_COOKIE,
  MAX_VISITOR_ID_LENGTH,
  type LeadContext,
} from "../src/utils/lead-context";

function encodeCookie(context: LeadContext): string {
  return encodeURIComponent(JSON.stringify(context));
}

function buildContext(overrides: Partial<AttributionHookContext> = {}): AttributionHookContext {
  return {
    path: "/sign-up/email",
    getCookie: () => undefined,
    context: {
      newSession: { user: { id: "u1" } },
      adapter: {
        findOne: vi.fn().mockResolvedValue(null),
        create: vi.fn().mockResolvedValue({}),
      },
    },
    ...overrides,
  };
}

describe("leadAttribution matcher", () => {
  const hook = (leadAttribution().hooks as unknown as {
    after: Array<{ matcher: (ctx: AttributionHookContext) => boolean }>;
  }).after[0]!;

  it.each(["/sign-up/email", "/callback/google", "/sign-up/anonymous"])(
    "命中注册/回调路径 %s",
    (path) => {
      expect(hook.matcher(buildContext({ path }))).toBe(true);
    },
  );

  it.each(["/sign-in/email", "/get-session", "/ok"])("忽略非注册路径 %s", (path) => {
    expect(hook.matcher(buildContext({ path }))).toBe(false);
  });
});

describe("handleLeadAttribution", () => {
  it("cookie 命中：将首次来源与 userId 关联写入 userLead", async () => {
    const leadCtx: LeadContext = {
      visitorId: "v-123",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      referrer: "https://google.com",
      landingPage: "/pricing",
    };
    const ctx = buildContext({
      getCookie: (n) => (n === LEAD_COOKIE ? encodeCookie(leadCtx) : undefined),
    });

    await handleLeadAttribution(ctx);

    expect(ctx.context.adapter.findOne).toHaveBeenCalledWith({
      model: "userLead",
      where: [{ field: "userId", value: "u1" }],
    });
    expect(ctx.context.adapter.create).toHaveBeenCalledTimes(1);
    const call = (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.model).toBe("userLead");
    expect(call.data).toMatchObject({
      userId: "u1",
      visitorId: "v-123",
      utmSource: "google",
      utmMedium: "cpc",
      utmCampaign: "spring",
      referrer: "https://google.com",
      landingPage: "/pricing",
    });
    expect(call.data.signupAt).toBeInstanceOf(Date);
  });

  it("幂等保护：已存在 userLead 记录时不重复插入", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123", utmSource: "google" }),
    });
    (ctx.context.adapter.findOne as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: "existing",
    });

    await handleLeadAttribution(ctx);

    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });

  it("伪造 cookie 的非 string 字段归一化后不落库", async () => {
    const ctx = buildContext({
      getCookie: () =>
        encodeURIComponent(JSON.stringify({ visitorId: "v-3", utmSource: { hack: true } })),
    });

    await handleLeadAttribution(ctx);

    const call = (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.data.visitorId).toBe("v-3");
    expect(call.data.utmSource).toBeUndefined();
  });

  it("并发竞态兜底：create 抛唯一约束冲突按幂等成功处理", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
    });
    (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      Object.assign(new Error("duplicate key value violates unique constraint"), { code: "23505" }),
    );

    await expect(handleLeadAttribution(ctx)).resolves.toBeUndefined();
  });

  it("非唯一约束的落库错误照常抛出", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
    });
    (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    );

    await expect(handleLeadAttribution(ctx)).rejects.toThrow("connection refused");
  });

  it("cookie 缺失：按 body.visitorId 回退查 visitor 表写入", async () => {
    const findVisitorById = vi.fn().mockResolvedValue({
      utmSource: "bing",
      utmMedium: "organic",
      country: "CN",
    });
    const ctx = buildContext({ body: { visitorId: "v-9" } });

    await handleLeadAttribution(ctx, { findVisitorById });

    expect(findVisitorById).toHaveBeenCalledWith("v-9");
    expect(ctx.context.adapter.create).toHaveBeenCalledTimes(1);
    const call = (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.data).toMatchObject({
      userId: "u1",
      visitorId: "v-9",
      utmSource: "bing",
      utmMedium: "organic",
    });
  });

  it("cookie 与 visitorId 均缺失：静默跳过，不写入", async () => {
    const ctx = buildContext({});

    await handleLeadAttribution(ctx);

    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });

  it("无新会话（非注册动作）：直接返回", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
    });
    ctx.context.newSession = undefined;

    await handleLeadAttribution(ctx);

    expect(ctx.context.adapter.findOne).not.toHaveBeenCalled();
    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });

  it("从请求头提取 IP 与国家", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
      request: {
        headers: new Headers({
          "cf-connecting-ip": "1.2.3.4",
          "cf-ipcountry": "US",
        }),
      },
    });

    await handleLeadAttribution(ctx);

    const call = (ctx.context.adapter.create as ReturnType<typeof vi.fn>).mock.calls[0]![0];
    expect(call.data).toMatchObject({ ipAddress: "1.2.3.4", country: "US" });
  });

  it("schema 声明 userLead 模型并引用 user 表", () => {
    const plugin = leadAttribution();
    const schema = plugin.schema as unknown as Record<
      string,
      { fields: Record<string, unknown> }
    >;

    expect(schema["userLead"]).toBeDefined();
    expect(schema["userLead"]?.fields.userId).toMatchObject({
      type: "string",
      required: true,
      unique: true,
      references: { model: "user", field: "id" },
    });
    expect(plugin.id).toBe("lead-attribution");
  });
});

describe("runLeadAttributionSafely（V4 旁路防护）", () => {
  it("落库异常被吞掉并经 logger 记录，注册响应不受影响", async () => {
    const logger = { error: vi.fn() };
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
    });
    (ctx.context.adapter.findOne as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("connection refused"),
    );
    ctx.context.logger = logger;

    await expect(runLeadAttributionSafely(ctx)).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "[lead-attribution] attribution write failed",
      expect.any(Error),
    );
  });

  it("宿主未注入 logger：同样吞掉异常，不抛出", async () => {
    const ctx = buildContext({
      getCookie: () => encodeCookie({ visitorId: "v-123" }),
    });
    (ctx.context.adapter.findOne as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error("db down"),
    );

    await expect(runLeadAttributionSafely(ctx)).resolves.toBeUndefined();
  });
});

describe("body.visitorId 限长（V7）", () => {
  it("超长 visitorId 不触发回退查询，也不写入", async () => {
    const findVisitorById = vi.fn();
    const ctx = buildContext({
      body: { visitorId: "v".repeat(MAX_VISITOR_ID_LENGTH + 1) },
    });

    await handleLeadAttribution(ctx, { findVisitorById });

    expect(findVisitorById).not.toHaveBeenCalled();
    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });
});
