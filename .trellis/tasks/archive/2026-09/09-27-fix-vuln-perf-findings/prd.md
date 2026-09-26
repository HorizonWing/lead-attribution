# PRD：修复 09-27 安全/性能审查发现（V1-V7）

> 来源：2026-09-27 第二轮全链路审查（codegraph 全模块核对）。
> 关联任务：09-26-fix-review-findings（第一轮 F1-F6，已提交 693012b）。

## 背景

第二轮审查覆盖全部运行时模块（两插件、track-visit 路由、lead-context/client-info/lead-tracker.client、conversion、客户端插件）。无高危漏洞，发现 3 个中等 + 4 个低优先级问题。

## 需求与验收标准

### V1（中）：归一化层字段长度上限

- `normalizeLeadContext` 所在边界统一限长：`visitorId` ≤ 64（`MAX_VISITOR_ID_LENGTH`，UUID v4 为 36），可选字段 ≤ 2048（`MAX_FIELD_LENGTH`）。
- visitorId 超长 → 整体判非法（null → track-visit 返回 400）；可选字段超长 → 归 `undefined`（保留该次访问记录）。
- 对 cookie 与 HTTP 请求体两个入口同时生效。

### V2（中）：转化写入幂等键

- `ConversionInput`/`ConversionEventRow` 增加可选 `dedupeKey`（订阅 ID / webhook 事件 ID），`recordConversion` 透传。
- 注释明确宿主应按 dedupeKey 做 upsert 或唯一约束（Stripe webhook 自动重试会重复触发）。

### V3（中，功能缺陷）：删除 cookieName 选项

- 移除 `LeadAttributionOptions.cookieName`：客户端埋点硬编码 `ba_lead_ctx`，服务端自定义 cookie 名必致两端不一致、归因静默失效。
- `LEAD_COOKIE` 常量为唯一真相（KISS）。

### V4（低）：旁路 hook 防御性包裹

- 归因/行为 hook 落库异常不得把已成功的注册/登录变成失败响应：新增 `runLeadAttributionSafely` / `runBehaviorEventSafely`，catch 后经 `ctx.context.logger?.error` 记录（无 console，吞错不静默）。
- `AttributionHookContext`/`BehaviorHookContext`.context 增加可选 `logger`。

### V5（低）：cookie secure 属性

- `serializeLeadCookie` 支持 `{ secure }` 选项；`captureVisitorContext` 按 `window.location.protocol === "https:"` 自动开启。HTTP 开发环境不受影响。

### V6（低）：README 威胁模型声明

- 声明归因字段为客户端自报数据（cookie/请求体/x-forwarded-for 可伪造），仅可内部分析、不可用于分成结算；track-visit 为匿名端点，宿主应配 rate limit 与 body size 限制。

### V7（低）：回退路径 visitorId 限长早退

- `handleLeadAttribution` 的 `body.visitorId` 改用共享的 `isVisitorId` 校验（V1 顺带收口）。

### 第三轮补充发现（B1-B3，codegraph 复审）

- B1（中）：`pickIpAddress`/`pickCountry` 对请求头值无限长、无空串过滤——伪造的超长
  `x-forwarded-for` 首段可直达 `visitor.ip_address`/`userLead.ipAddress` 落库（V1 只覆盖了
  body 字段）。修复：client-info 统一过 `optionalString`（空串/超长归 undefined），
  track-visit 与 lead-attribution 两个调用方同时受益；新增 tests/client-info.test.ts。
- B2（中）：dedupeKey 落库端缺口——examples/schema.pg-drizzle.ts 的 conversionEvent 与
  design.md §3.4 DDL 均无 dedupe_key 列，examples/auth.ts 也未传 dedupeKey。修复：表加
  `dedupe_key TEXT` + 唯一索引（PG 默认 NULLS DISTINCT，旧行为不变）；示例回调传
  `dedupeKey: subscription.id` 并 `onConflictDoNothing` 幂等写入。
- B3（低）：`UserLeadAttribution.signupAt` 补契约注释：原始 driver（node-pg）返回 string，
  宿主需自行 `new Date(...)`。

### 文档同步

- docs/design.md 3.2 示例 SQL 的普通索引改唯一索引（与 F2 修复、examples/schema.pg-drizzle.ts 对齐）。

## 不做

- visitor 表格式校验（UUID 形状）——限长已抬高滥用成本，格式约束误伤自定义 ID 方案（YAGNI）。
- track-visit 内置 rate limit——属宿主框架层职责，README 声明即可。

## 验收

- tsc --noEmit 通过；vitest 全绿（含新增用例：限长边界、dedupeKey 透传、safe-run 吞错+记日志、secure cookie、超长 body.visitorId 不触发回退）。
- 公共导出面：`isVisitorId`、`MAX_VISITOR_ID_LENGTH`、`MAX_FIELD_LENGTH` 导出供宿主复用；safe-run 包装器不导出（内部实现）。
