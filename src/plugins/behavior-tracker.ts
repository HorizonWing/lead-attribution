/**
 * behaviorTracker 插件（docs/design.md 6.2）
 *
 * 在认证动作完成后记录行为事件（signup / login / login_social 等）到 userEvent 模型，
 * 支撑「注册 → 付费」转化时间线分析。路径 → 事件映射可配置覆盖。
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

/** 默认追踪的认证路径 → 事件类型映射；"*" 结尾的键按前缀匹配（见 matchEventPath） */
export const DEFAULT_EVENT_PATHS: Record<string, string> = {
  "/sign-up/email": "signup",
  "/sign-in/email": "login",
  // id_token 直发流程（Apple 表单提交等）在 /sign-in/social 即完成建会话
  "/sign-in/social": "login_social",
  // 标准授权码流程：/sign-in/social 仅返回跳转 URL，会话在 /callback/:provider 创建
  "/callback/*": "login_social",
};

export interface BehaviorTrackerOptions {
  /** 路径 → 事件类型映射；提供时整体覆盖默认映射 */
  eventPaths?: Record<string, string>;
}

/** after hook 上下文中本插件用到的最小结构（结构化类型，便于单测直接构造） */
export interface BehaviorHookContext {
  path?: string;
  context: {
    newSession?: { user: { id: string } } | null;
    session?: { user: { id: string } } | null;
    /** better-auth 运行时自带的日志器；缺省时（单测构造）静默 */
    logger?: { error(message: string, ...args: unknown[]): void };
    adapter: {
      create(args: { model: string; data: Record<string, unknown> }): Promise<unknown>;
    };
  };
}

export const behaviorTracker = (options: BehaviorTrackerOptions = {}) => {
  const eventPaths = options.eventPaths ?? DEFAULT_EVENT_PATHS;

  return {
    id: "behavior-tracker",
    schema: {
      userEvent: {
        fields: {
          userId: {
            type: "string",
            references: { model: "user", field: "id" },
          },
          eventType: { type: "string", required: true },
          metadata: { type: "string" },
          createdAt: { type: "date", required: true },
        },
      },
    },
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            ctx.path !== undefined && matchEventPath(ctx.path, eventPaths) !== undefined,
          // 逻辑主体抽出为独立函数（见 tests/），handler 仅做薄委托（含旁路防护）
          handler: createAuthMiddleware(async (ctx) => {
            await runBehaviorEventSafely(ctx as unknown as BehaviorHookContext, eventPaths);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
};

/**
 * 路径 → 事件类型匹配：精确命中优先；"*" 结尾的键按去掉 "*" 后的前缀匹配
 * （/callback/:provider 的 provider 段是动态的，静态表无法精确枚举）。
 */
export function matchEventPath(
  path: string,
  eventPaths: Record<string, string> = DEFAULT_EVENT_PATHS,
): string | undefined {
  const exact = eventPaths[path];
  if (exact !== undefined) return exact;

  for (const [pattern, eventType] of Object.entries(eventPaths)) {
    if (pattern.endsWith("*") && path.startsWith(pattern.slice(0, -1))) return eventType;
  }
  return undefined;
}

/** 记录行为事件的主逻辑（独立导出以便直接单测） */
export async function handleBehaviorEvent(
  ctx: BehaviorHookContext,
  eventPaths: Record<string, string> = DEFAULT_EVENT_PATHS,
): Promise<void> {
  const eventType = ctx.path !== undefined ? matchEventPath(ctx.path, eventPaths) : undefined;
  if (eventType === undefined) return;

  const userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id;
  if (!userId) return;

  await ctx.context.adapter.create({
    model: "userEvent",
    data: {
      userId,
      eventType,
      metadata: JSON.stringify({ path: ctx.path }),
      createdAt: new Date(),
    },
  });
}

/**
 * 旁路执行：行为事件落库异常只经 logger 记录，
 * 不让已成功的登录/注册变成失败响应。handler 委托本函数而非直接调主逻辑。
 */
export async function runBehaviorEventSafely(
  ctx: BehaviorHookContext,
  eventPaths: Record<string, string> = DEFAULT_EVENT_PATHS,
): Promise<void> {
  try {
    await handleBehaviorEvent(ctx, eventPaths);
  } catch (error) {
    ctx.context.logger?.error("[behavior-tracker] event write failed", error);
  }
}
