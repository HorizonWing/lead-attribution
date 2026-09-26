/**
 * 访客进站上报接口（docs/design.md 5）
 *
 * 框架无关：接收标准 fetch Request，适配任何 Request/Response 运行时
 * （Nuxt/Nitro、Next Route Handler、Hono 等）。
 * UPSERT 语义由注入的 upsertVisitor 实现：首次插入全量来源，
 * 同一 visitorId 重复上报仅刷新 last_seen_at，首次来源始终保留。
 */
import { pickCountry, pickIpAddress } from "../utils/client-info.js";
import { normalizeLeadContext } from "../utils/lead-context.js";

/** visitor 表 upsert 所需的完整输入 */
export interface UpsertVisitorInput {
  visitorId: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrer?: string;
  landingPage?: string;
  ipAddress?: string;
  country?: string;
}

export interface TrackVisitDeps {
  /**
   * 落库实现：按宿主数据库实现 UPSERT——
   * PostgreSQL/SQLite `ON CONFLICT DO UPDATE`，MySQL `ON DUPLICATE KEY UPDATE`，
   * MongoDB `findOneAndUpdate(upsert: true)`；首次来源不覆盖，仅刷新活跃时间
   */
  upsertVisitor: (input: UpsertVisitorInput) => Promise<void>;
}

/**
 * POST /api/track/visit 处理器。
 * 返回 204（成功）、400（请求体非法）或 500（落库失败）；
 * 归因采集失败不应影响页面，前端已 catch 忽略。
 */
export async function trackVisit(request: Request, deps: TrackVisitDeps): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "invalid JSON body" }, { status: 400 });
  }

  // 输入校验 + 归一化（系统边界，fail-fast）：visitorId 必须为非空 string，
  // 可选字段仅保留非空 string（请求体与 cookie 一样是可伪造的外部输入）
  const lead = normalizeLeadContext(body);
  if (!lead) {
    return Response.json({ error: "visitorId (non-empty string) is required" }, { status: 400 });
  }

  try {
    await deps.upsertVisitor({
      visitorId: lead.visitorId,
      utmSource: lead.utmSource,
      utmMedium: lead.utmMedium,
      utmCampaign: lead.utmCampaign,
      referrer: lead.referrer,
      landingPage: lead.landingPage,
      ipAddress: pickIpAddress(request.headers),
      country: pickCountry(request.headers),
    });
  } catch {
    // 落库失败返回显式 500（不泄漏内部错误详情），宿主无需处理未捕获 rejection
    return Response.json({ error: "failed to record visit" }, { status: 500 });
  }

  return new Response(null, { status: 204 });
}
