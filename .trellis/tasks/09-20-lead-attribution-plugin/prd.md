# 实现线索归因与支付转化追踪 Better Auth 插件

## Goal

按 `docs/design.md` 的技术方案，从零搭建一个可独立安装、可测试的 Better Auth 插件包，
打通「访客进站 → 来源识别 → 注册归因 → 支付转化」全链路，仅依赖标准 PostgreSQL。

## Requirements

### R1 leadAttribution 插件（核心）
- 插件 id `lead-attribution`，声明 `userLead` 模型 schema（字段与 design.md 3.2 一致）。
- 在 `/sign-up`、`/callback` 路径的 after hook 中，将 `ba_lead_ctx` cookie 中的来源信息
  （UTM/referrer/落地页/visitorId）与注册用户 `userId` 关联写入 `userLead`。
- cookie 缺失时支持按 `body.visitorId` 回退查询 visitor 表（依赖通过 options 注入，不硬编码 drizzle）。
- 同一用户幂等：已存在 `userLead` 记录时不重复插入（社交登录多次回调场景）。
- IP/国家从请求头（`cf-connecting-ip` / `x-forwarded-for` / `cf-ipcountry`）提取。

### R2 behaviorTracker 插件（核心）
- 插件 id `behavior-tracker`，声明 `userEvent` 模型 schema（signup/login/login_social 等事件）。
- 在可配置的路径→事件映射命中的 after hook 中记录 `userEvent`。

### R3 访客上下文采集（配套）
- 前端埋点工具 `captureVisitorContext()`：生成 visitorId、解析 UTM、写 `ba_lead_ctx` cookie、
  异步 POST 上报（首次来源不覆盖，已采集则跳过）。
- visit 上报 handler：标准 fetch Request/Response 签名，对 visitor 表执行 UPSERT
  （首次写全量，重复访问仅刷新 last_seen_at）。

### R4 支付转化记录（配套）
- 可复用函数 `recordConversion`：根据 userId 查 userLead，计算 daysToConvert，
  写入 conversionEvent（供 Stripe 插件 `onSubscriptionComplete` 回调调用）。
- 提供集成示例 `examples/auth.ts`（betterAuth + @better-auth/stripe + 本插件组）。

### R5 数据层与工程化
- drizzle-pg schema：visitor / user_lead / user_event / conversion_event（对应 design.md 3.1–3.4）。
- package.json / tsconfig / vitest，插件本体零外部 DB 依赖（peerDeps: better-auth）。

## Constraints

- 不修改 Better Auth 核心表（user/session），仅通过外键关联。
- 本仓库为空仓库：无现有应用代码，插件包自洽，集成代码以示例形式提供。
- 遵循 better-auth 官方插件创建模式（`satisfies BetterAuthPlugin`、schema、hooks matcher/handler）。
- 不执行 git commit（用户未要求）。

## Acceptance Criteria

- [x] `npx tsc --noEmit` 类型检查通过
- [x] `npx vitest run` 全部测试通过（插件 hooks、埋点工具、上报 handler、recordConversion）
- [x] leadAttribution：cookie 命中 / cookie 缺失回退 visitorId / 重复回调幂等 三个场景有测试
- [x] behaviorTracker：命中路径记录事件、未命中路径不记录 有测试
- [x] visit handler：首次插入全量、重复仅刷新 last_seen_at 有测试（mock db 验证 UPSERT 语义）
- [x] 提供客户端插件（`$InferServerPlugin`，id 与服务端一致）与 README 使用说明
