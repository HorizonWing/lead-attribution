/**
 * 从请求头提取客户端信息（IP/国家），不绑定 Cloudflare 专有部署。
 * 优先级：CF 专有头 → 反向代理注入头 → 标准转发头首段。
 *
 * 请求头与 cookie/请求体一样是客户端可伪造输入：值统一过 optionalString
 * （非空 string 且 ≤ MAX_FIELD_LENGTH）——空串、超长值（如伪造的超大 XFF 段）归 undefined。
 */
import { optionalString } from "./lead-context";

export function pickIpAddress(headers: Headers | null): string | undefined {
  if (!headers) return undefined;
  const forwarded = headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  return (
    optionalString(headers.get("cf-connecting-ip")) ??
    optionalString(headers.get("x-real-ip")) ??
    optionalString(forwarded)
  );
}

/**
 * 国家：Cloudflare 环境直接取 cf-ipcountry；
 * 自托管场景的离线解析方案见 docs/design.md 第 8 节（MaxMind GeoLite2）。
 */
export function pickCountry(headers: Headers | null): string | undefined {
  return optionalString(headers?.get("cf-ipcountry") ?? undefined);
}
