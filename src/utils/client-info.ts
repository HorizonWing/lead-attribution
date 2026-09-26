/**
 * 从请求头提取客户端信息（IP/国家），不绑定 Cloudflare 专有部署。
 * 优先级：CF 专有头 → 反向代理注入头 → 标准转发头首段。
 */

export function pickIpAddress(headers: Headers | null): string | undefined {
  if (!headers) return undefined;
  return (
    headers.get("cf-connecting-ip") ??
    headers.get("x-real-ip") ??
    headers.get("x-forwarded-for")?.split(",")[0]?.trim() ??
    undefined
  );
}

/**
 * 国家：Cloudflare 环境直接取 cf-ipcountry；
 * 自托管场景的离线解析方案见 docs/design.md 第 8 节（MaxMind GeoLite2）。
 */
export function pickCountry(headers: Headers | null): string | undefined {
  return headers?.get("cf-ipcountry") ?? undefined;
}
