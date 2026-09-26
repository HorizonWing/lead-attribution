/**
 * behaviorTracker 客户端插件：id 与服务端一致，
 * 通过 $InferServerPlugin 继承服务端 schema 类型。
 */
import type { BetterAuthClientPlugin } from "better-auth/client";

import type { behaviorTracker } from "./behavior-tracker.js";

export const behaviorTrackerClient = () => {
  return {
    id: "behavior-tracker",
    $InferServerPlugin: {} as ReturnType<typeof behaviorTracker>,
  } satisfies BetterAuthClientPlugin;
};
