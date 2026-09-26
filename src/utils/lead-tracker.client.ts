/**
 * 前端埋点（docs/design.md 4）
 *
 * 首次访问时生成 visitorId、解析 UTM 参数、写入线索 cookie 并异步上报后端落库。
 * 已采集过则跳过——保证「首次来源」不被后续渠道覆盖。
 * 浏览器专用模块：仅在客户端环境（import 到 .client 侧或 <script>）调用。
 */
import { LEAD_COOKIE, serializeLeadCookie, type LeadContext } from "./lead-context";

export interface CaptureVisitorContextOptions {
  /** 上报接口地址，默认 "/api/track/visit" */
  endpoint?: string;
}

export function captureVisitorContext(options: CaptureVisitorContextOptions = {}): void {
  if (typeof document === "undefined") return; // SSR 环境跳过
  // 锚定 cookie 名边界（行首或 "; " 后紧跟目标名），避免 xba_lead_ctx= 之类后缀同名 cookie 误判为已采集
  if (new RegExp(`(?:^|;\\s*)${LEAD_COOKIE}=`).test(document.cookie)) return;

  const params = new URLSearchParams(window.location.search);
  const context: LeadContext = {
    visitorId: generateVisitorId(),
    utmSource: params.get("utm_source") ?? undefined,
    utmMedium: params.get("utm_medium") ?? undefined,
    utmCampaign: params.get("utm_campaign") ?? undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname,
  };

  document.cookie = serializeLeadCookie(context);

  // 上报失败静默忽略：埋点是旁路逻辑，不能影响页面加载；
  // keepalive：落地页立即跳转（广告点击 → LP → 产品页）时上报不被浏览器取消
  fetch(options.endpoint ?? "/api/track/visit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(context),
    keepalive: true,
  }).catch(() => {});
}

/** crypto.randomUUID 仅安全上下文（HTTPS/localhost）可用；HTTP 下回退 getRandomValues 拼 UUID v4 */
function generateVisitorId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40; // 版本位固定为 4
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80; // RFC 4122 变体位
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
