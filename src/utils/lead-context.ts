/**
 * 前后端共享的线索上下文工具：cookie 常量、序列化、解析。
 * 纯函数、无副作用，浏览器与服务端均可安全导入。
 */

/** 线索上下文 cookie 名，与服务端插件默认值一致 */
export const LEAD_COOKIE = "ba_lead_ctx";

/** cookie 有效期：30 天（秒） */
export const LEAD_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** 访客首次进站时采集的来源上下文 */
export interface LeadContext {
  visitorId: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrer?: string;
  landingPage?: string;
}

/** 序列化为 document.cookie 可直接写入的字符串（samesite=lax，30 天） */
export function serializeLeadCookie(context: LeadContext): string {
  const value = encodeURIComponent(JSON.stringify(context));
  return `${LEAD_COOKIE}=${value}; max-age=${LEAD_COOKIE_MAX_AGE}; path=/; samesite=lax`;
}

/**
 * 解析单个线索 cookie 的值（即 ctx.getCookie(LEAD_COOKIE) 的返回值）；
 * 缺失或格式非法时返回 null（永不抛出），可选字段经 normalizeLeadContext 归一化。
 */
export function parseLeadCookieValue(value: string | null | undefined): LeadContext | null {
  if (!value) return null;

  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(value));
    return normalizeLeadContext(parsed);
  } catch {
    return null;
  }
}

/** 结构化校验：至少要有 string 类型的 visitorId（外部输入，永不信任） */
export function isLeadContext(value: unknown): value is LeadContext {
  if (typeof value !== "object" || value === null) return false;
  const visitorId = (value as Record<string, unknown>)["visitorId"];
  return typeof visitorId === "string" && visitorId.length > 0;
}

/** 外部输入的可选字段归一化：仅保留非空 string，其余类型（对象/数字/空串）归为 undefined */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * 校验并归一化线索上下文：visitorId 必须为非空 string；utm/referrer 等可选字段
 * 仅保留非空 string。cookie 与请求体均为客户端可伪造输入，落库前必须过此函数。
 */
export function normalizeLeadContext(value: unknown): LeadContext | null {
  if (!isLeadContext(value)) return null;
  return {
    visitorId: value.visitorId,
    utmSource: optionalString(value.utmSource),
    utmMedium: optionalString(value.utmMedium),
    utmCampaign: optionalString(value.utmCampaign),
    referrer: optionalString(value.referrer),
    landingPage: optionalString(value.landingPage),
  };
}
