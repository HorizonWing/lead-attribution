import { describe, expect, it, vi } from "vitest";

import {
  behaviorTracker,
  DEFAULT_EVENT_PATHS,
  handleBehaviorEvent,
  matchEventPath,
  type BehaviorHookContext,
} from "../src/plugins/behavior-tracker";

function buildContext(path: string, overrides: Partial<BehaviorHookContext> = {}): BehaviorHookContext {
  return {
    path,
    context: {
      session: { user: { id: "u1" } },
      adapter: { create: vi.fn().mockResolvedValue({}) },
    },
    ...overrides,
  };
}

function createOf(ctx: BehaviorHookContext): ReturnType<typeof vi.fn> {
  return ctx.context.adapter.create as ReturnType<typeof vi.fn>;
}

describe("handleBehaviorEvent", () => {
  it("默认映射：/sign-up/email 记录 signup 事件（优先取 newSession）", async () => {
    const ctx: BehaviorHookContext = {
      path: "/sign-up/email",
      context: {
        newSession: { user: { id: "u-new" } },
        session: { user: { id: "u-old" } },
        adapter: { create: vi.fn().mockResolvedValue({}) },
      },
    };

    await handleBehaviorEvent(ctx);

    expect(ctx.context.adapter.create).toHaveBeenCalledTimes(1);
    const call = createOf(ctx).mock.calls[0]![0];
    expect(call.model).toBe("userEvent");
    expect(call.data).toMatchObject({
      userId: "u-new",
      eventType: "signup",
      metadata: JSON.stringify({ path: "/sign-up/email" }),
    });
    expect(call.data.createdAt).toBeInstanceOf(Date);
  });

  it("默认映射：/sign-in/email 记录 login，/sign-in/social 记录 login_social", async () => {
    for (const [path, eventType] of [
      ["/sign-in/email", "login"],
      ["/sign-in/social", "login_social"],
    ] as const) {
      const ctx = buildContext(path);
      await handleBehaviorEvent(ctx);
      expect(createOf(ctx).mock.calls[0]![0].data.eventType).toBe(eventType);
    }
  });

  it("前缀规则：标准 OAuth 完成端点 /callback/:provider 记录 login_social", async () => {
    for (const path of ["/callback/google", "/callback/github"]) {
      const ctx = buildContext(path);
      await handleBehaviorEvent(ctx);
      expect(createOf(ctx).mock.calls[0]![0].data.eventType).toBe("login_social");
    }
  });

  it("前缀规则不误命中：/callbackish 不属于 /callback/*", async () => {
    const ctx = buildContext("/callbackish");
    await handleBehaviorEvent(ctx);
    expect(createOf(ctx)).not.toHaveBeenCalled();
  });

  it("未命中路径：不记录事件", async () => {
    const ctx = buildContext("/get-session");

    await handleBehaviorEvent(ctx);

    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });

  it("eventPaths 可整体覆盖默认映射", async () => {
    const ctx = buildContext("/magic-link/sign-in");

    await handleBehaviorEvent(ctx, { "/magic-link/sign-in": "login_magic" });

    expect(createOf(ctx).mock.calls[0]![0].data.eventType).toBe("login_magic");
  });

  it("无 userId 可取：跳过记录", async () => {
    const ctx = buildContext("/sign-in/email");
    ctx.context.session = undefined;

    await handleBehaviorEvent(ctx);

    expect(ctx.context.adapter.create).not.toHaveBeenCalled();
  });

  it("插件 matcher 命中规则与 schema 模型符合契约", () => {
    const plugin = behaviorTracker();
    expect(plugin.id).toBe("behavior-tracker");
    const hook = (plugin.hooks as unknown as {
      after: Array<{ matcher: (ctx: { path?: string }) => boolean }>;
    }).after[0]!;
    expect(hook.matcher({ path: "/sign-up/email" })).toBe(true);
    expect(hook.matcher({ path: "/callback/google" })).toBe(true);
    expect(hook.matcher({ path: "/callbackish" })).toBe(false);
    expect(hook.matcher({ path: "/get-session" })).toBe(false);

    const schema = plugin.schema as unknown as Record<
      string,
      { fields: Record<string, unknown> }
    >;
    expect(schema["userEvent"]).toBeDefined();
    expect(schema["userEvent"]?.fields.eventType).toMatchObject({ type: "string", required: true });
    expect(DEFAULT_EVENT_PATHS["/sign-up/email"]).toBe("signup");
  });
});

describe("matchEventPath", () => {
  it("精确命中优先于前缀规则", () => {
    const eventPaths = { "/sign-in/email": "login", "/sign-in/*": "other" };
    expect(matchEventPath("/sign-in/email", eventPaths)).toBe("login");
    expect(matchEventPath("/sign-in/social", eventPaths)).toBe("other");
    expect(matchEventPath("/get-session", eventPaths)).toBeUndefined();
  });
});
