/**
 * leadAttribution 插件（docs/design.md 6.1）
 *
 * 注册/社交回调完成后，将访客来源上下文（UTM、referrer、落地页、IP、国家）
 * 与真实 userId 关联写入 userLead 模型：
 * - 优先读线索 cookie（首次进站时前端埋点写入，不覆盖首次来源）；
 * - cookie 缺失时按请求体 visitorId 回退查询 visitor 表（跨设备/隐私模式场景）；
 * - 同一用户幂等：已存在 userLead 记录时不重复插入；
 *   findOne→create 非原子，并发回调的竞态由 userId 唯一约束兜底。
 *
 * 数据访问全部走 better-auth adapter，插件本体不绑定具体 ORM；
 * visitor 表回退查询通过 options.findVisitorById 注入。
 */
import type { BetterAuthPlugin } from "better-auth";
import { createAuthMiddleware } from "better-auth/api";

import { pickCountry, pickIpAddress } from "../utils/client-info";
import { LEAD_COOKIE, isVisitorId, parseLeadCookieValue } from "../utils/lead-context";

/** visitor 表行中回退查询所需的最小字段（其余字段忽略） */
export interface VisitorRow {
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
  ipAddress?: string | null;
  country?: string | null;
}

export interface LeadAttributionOptions {
  /**
   * cookie 缺失时按 visitorId 回退查询 visitor 表；
   * 不传则跳过回退（纯 cookie 模式）。
   */
  findVisitorById?: (visitorId: string) => Promise<VisitorRow | null>;
}

/**
 * after hook 上下文中本插件用到的最小结构。
 * 定义为结构化类型而非依赖 better-auth 的泛型 EndpointContext，便于单测直接构造。
 */
export interface AttributionHookContext {
  path?: string;
  body?: Record<string, unknown>;
  getCookie(name: string): string | undefined;
  request?: { headers: Headers } | null;
  context: {
    newSession?: { user: { id: string } } | null;
    /** better-auth 运行时自带的日志器；缺省时（单测构造）静默 */
    logger?: { error(message: string, ...args: unknown[]): void };
    adapter: {
      findOne(args: {
        model: string;
        where: Array<{ field: string; value: unknown }>;
      }): Promise<unknown>;
      create(args: { model: string; data: Record<string, unknown> }): Promise<unknown>;
    };
  };
}

export const leadAttribution = (options: LeadAttributionOptions = {}) =>
  ({
    id: "lead-attribution",
    schema: {
      userLead: {
        fields: {
          userId: {
            type: "string",
            required: true,
            unique: true, // findOne→create 的幂等检查非原子，并发竞态靠唯一约束兜底
            references: { model: "user", field: "id" },
          },
          visitorId: { type: "string" },
          utmSource: { type: "string" },
          utmMedium: { type: "string" },
          utmCampaign: { type: "string" },
          referrer: { type: "string" },
          landingPage: { type: "string" },
          ipAddress: { type: "string" },
          country: { type: "string" },
          signupAt: { type: "date", required: true },
        },
      },
    },
    hooks: {
      after: [
        {
          matcher: (ctx) =>
            ctx.path !== undefined &&
            (ctx.path.startsWith("/sign-up") || ctx.path.startsWith("/callback")),
          // 逻辑主体抽出为独立函数（见 tests/），handler 仅做薄委托（含旁路防护）
          handler: createAuthMiddleware(async (ctx) => {
            await runLeadAttributionSafely(ctx as unknown as AttributionHookContext, options);
          }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;

/** 注册/回调完成后写入归因记录的主逻辑（独立导出以便直接单测） */
export async function handleLeadAttribution(
  ctx: AttributionHookContext,
  options: LeadAttributionOptions = {},
): Promise<void> {
  const userId = ctx.context.newSession?.user.id;
  if (!userId) return;

  const fromCookie = parseLeadCookieValue(ctx.getCookie(LEAD_COOKIE));
  if (fromCookie) {
    // cookie 命中：直接使用首次进站采集的来源
    await createUserLead(ctx, userId, fromCookie.visitorId, fromCookie);
    return;
  }

  // cookie 缺失（跨设备注册、隐私模式清了 cookie）：按 body.visitorId 回退查 visitor 表
  // isVisitorId 限长校验：超长/非法值不触发回退查询（与 cookie 入口同一规则）
  const bodyVisitorIdRaw: unknown = ctx.body?.visitorId;
  const bodyVisitorId = isVisitorId(bodyVisitorIdRaw) ? bodyVisitorIdRaw : undefined;
  const visitor =
    bodyVisitorId && options.findVisitorById
      ? await options.findVisitorById(bodyVisitorId)
      : null;
  if (visitor) {
    await createUserLead(ctx, userId, bodyVisitorId, visitor);
  }
  // 两者皆缺：无归因数据可写，静默跳过（归因是旁路逻辑，不能阻断注册）
}

/**
 * 旁路执行：归因落库的任何异常（连接抖动、唯一约束之外的错误等）只经 logger 记录，
 * 不让已成功的注册/回调变成失败响应。handler 委托本函数而非直接调主逻辑。
 */
export async function runLeadAttributionSafely(
  ctx: AttributionHookContext,
  options: LeadAttributionOptions = {},
): Promise<void> {
  try {
    await handleLeadAttribution(ctx, options);
  } catch (error) {
    ctx.context.logger?.error("[lead-attribution] attribution write failed", error);
  }
}

/** cookie 上下文与 visitor 行的并集形态（归因字段值均可空） */
type LeadSource = {
  visitorId?: string;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrer?: string | null;
  landingPage?: string | null;
};

/** 组装并写入 userLead；幂等保护：已存在记录直接跳过（社交登录多次回调） */
async function createUserLead(
  ctx: AttributionHookContext,
  userId: string,
  visitorId: string | undefined,
  source: LeadSource,
): Promise<void> {
  const existing = await ctx.context.adapter.findOne({
    model: "userLead",
    where: [{ field: "userId", value: userId }],
  });
  if (existing) return;

  try {
    await ctx.context.adapter.create({
      model: "userLead",
      data: {
        userId,
        visitorId,
        utmSource: source.utmSource ?? undefined,
        utmMedium: source.utmMedium ?? undefined,
        utmCampaign: source.utmCampaign ?? undefined,
        referrer: source.referrer ?? undefined,
        landingPage: source.landingPage ?? undefined,
        ipAddress: pickIpAddress(ctx.request?.headers ?? null),
        country: pickCountry(ctx.request?.headers ?? null),
        signupAt: new Date(),
      },
    });
  } catch (error) {
    // 并发竞态：另一请求已插入同一 userId 的首触记录，唯一约束冲突按幂等成功处理
    if (!isUniqueViolationError(error)) throw error;
  }
}

/** 跨常见数据库的唯一约束冲突特征（PG 23505 / MySQL ER_DUP_ENTRY / SQLite / Mongo E11000） */
const UNIQUE_VIOLATION_PATTERNS = [
  "23505",
  "ER_DUP_ENTRY",
  "E11000",
  "duplicate key",
  "UNIQUE constraint",
];

function isUniqueViolationError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const code = String((error as { code?: unknown }).code ?? "");
  const message = String((error as { message?: unknown }).message ?? "");
  return UNIQUE_VIOLATION_PATTERNS.some(
    (marker) => code.includes(marker) || message.includes(marker),
  );
}
