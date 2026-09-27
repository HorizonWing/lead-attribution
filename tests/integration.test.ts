/**
 * 集成测试：启动真实 better-auth 实例（memory adapter），
 * 走完整注册请求链路，验证插件 after hook 真实挂载与落库，
 * 防止单元测试只测薄委托造成的假通过。
 */
import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";

import { behaviorTracker, leadAttribution } from "../src/index";

function buildAuth() {
  return betterAuth({
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
      // memoryAdapter 按 modelName 指定的物理表名建表（与真实数据库一致）
      user_lead: [],
      user_event: [],
    }),
    emailAndPassword: { enabled: true },
    plugins: [leadAttribution(), behaviorTracker()],
  });
}

function signUpRequest(cookie?: string): Request {
  return new Request("http://localhost/api/auth/sign-up/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(cookie ? { cookie } : {}),
    },
    body: JSON.stringify({ email: "u1@test.dev", password: "test123456", name: "U1" }),
  });
}

describe("集成：真实 auth 实例注册链路", () => {
  it("注册触发 leadAttribution（cookie 来源）+ behaviorTracker（signup 事件）落库", async () => {
    const auth = buildAuth();
    const leadCookie = `ba_lead_ctx=${encodeURIComponent(
      JSON.stringify({ visitorId: "v-i1", utmSource: "newsletter", landingPage: "/lp" }),
    )}`;

    const res = await auth.handler(signUpRequest(leadCookie));
    expect(res.status).toBe(200);

    const { user } = (await res.json()) as { user: { id: string } };
    const ctx = await auth.$context;

    const lead = (await ctx.adapter.findOne({
      model: "userLead",
      where: [{ field: "userId", value: user.id }],
    })) as Record<string, unknown> | null;
    expect(lead).toMatchObject({
      userId: user.id,
      visitorId: "v-i1",
      utmSource: "newsletter",
      landingPage: "/lp",
    });

    const event = (await ctx.adapter.findOne({
      model: "userEvent",
      where: [{ field: "userId", value: user.id }],
    })) as Record<string, unknown> | null;
    expect(event).toMatchObject({ userId: user.id, eventType: "signup" });
  });

  it("无线索 cookie 时注册成功且不写 userLead（静默跳过）", async () => {
    const auth = buildAuth();

    const res = await auth.handler(signUpRequest());
    expect(res.status).toBe(200);

    const { user } = (await res.json()) as { user: { id: string } };
    const ctx = await auth.$context;

    const lead = await ctx.adapter.findOne({
      model: "userLead",
      where: [{ field: "userId", value: user.id }],
    });
    expect(lead).toBeNull();

    // 行为事件不依赖 cookie，仍应记录
    const event = (await ctx.adapter.findOne({
      model: "userEvent",
      where: [{ field: "userId", value: user.id }],
    })) as Record<string, unknown> | null;
    expect(event).toMatchObject({ userId: user.id, eventType: "signup" });
  });
});
