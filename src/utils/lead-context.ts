/**
 * 前后端共享的线索上下文工具：cookie 常量、序列化、解析。
 * 纯函数、无副作用，浏览器与服务端均可安全导入。
 */

/** 线索上下文 cookie 名，前后端唯一真相（不提供改名选项，防两端不一致） */
export const LEAD_COOKIE = "ba_lead_ctx";

/** cookie 有效期：30 天（秒） */
export const LEAD_COOKIE_MAX_AGE = 60 * 60 * 24 * 30;

/** visitorId 上限：UUID v4 为 36 字符，64 留余量；封堵匿名接口灌超长主键 */
export const MAX_VISITOR_ID_LENGTH = 64;

/** 可选归因字段上限：cookie 路径受浏览器 ~4KB 约束，此上限封堵 HTTP 直报的超长载荷 */
export const MAX_FIELD_LENGTH = 2048;

/**
 * /api/track/visit 请求体字节上限（UTF-8）：JSON.parse 前预检。
 * 合法最坏情况 ≈ 12.4KB（visitorId 64 + 六个 2048 字段 + JSON 结构开销），16KB 留余量；
 * Content-Length 头可伪造不可信，必须读入后按实际字节拒绝，封堵解析阶段的内存耗尽。
 */
export const MAX_TRACK_BODY_BYTES = 16 * 1024;

/** 访客首次进站时采集的来源上下文 */
export interface LeadContext {
  visitorId: string;
  utmSource?: string;
  utmMedium?: string;
  utmCampaign?: string;
  referrer?: string;
  landingPage?: string;
}

export interface SerializeLeadCookieOptions {
  /** HTTPS 站点开启，防 cookie 在明文 HTTP 链路被读取/篡改 */
  secure?: boolean;
}

/** 序列化为 document.cookie 可直接写入的字符串（samesite=lax，30 天） */
export function serializeLeadCookie(
  context: LeadContext,
  options: SerializeLeadCookieOptions = {},
): string {
  const value = encodeURIComponent(JSON.stringify(context));
  const secure = options.secure ? "; secure" : "";
  return `${LEAD_COOKIE}=${value}; max-age=${LEAD_COOKIE_MAX_AGE}; path=/; samesite=lax${secure}`;
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

/** visitorId 结构校验：非空 string 且不超长（cookie 与请求体两个入口共用） */
export function isVisitorId(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 0 && value.length <= MAX_VISITOR_ID_LENGTH
  );
}

/** 结构化校验：visitorId 合法即认可（外部输入，永不信任） */
export function isLeadContext(value: unknown): value is LeadContext {
  if (typeof value !== "object" || value === null) return false;
  return isVisitorId((value as Record<string, unknown>)["visitorId"]);
}

/** 外部输入的可选字段归一化：仅保留限长内的非空 string，其余（对象/数字/空串/超长）归为 undefined */
export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_FIELD_LENGTH
    ? value
    : undefined;
}

/**
 * 校验并归一化线索上下文：visitorId 必须为限长内非空 string；utm/referrer 等可选字段
 * 仅保留限长内非空 string。cookie 与请求体均为客户端可伪造输入，落库前必须过此函数。
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
