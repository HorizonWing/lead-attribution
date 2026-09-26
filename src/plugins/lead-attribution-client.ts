/**
 * leadAttribution 客户端插件：id 与服务端一致，
 * 通过 $InferServerPlugin 继承服务端 schema 类型（inferAdditionalFields 等机制依赖它）。
 */
import type { BetterAuthClientPlugin } from "better-auth/client";

import type { leadAttribution } from "./lead-attribution.js";

export const leadAttributionClient = () => {
  return {
    id: "lead-attribution",
    $InferServerPlugin: {} as ReturnType<typeof leadAttribution>,
  } satisfies BetterAuthClientPlugin;
};
