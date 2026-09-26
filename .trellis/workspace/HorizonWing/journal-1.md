# Journal - HorizonWing (Part 1)

> AI development session journal
> Started: 2026-09-20

---

## 2026-09-26 · codegraph 全链路审查 + 缺陷修复（09-26-fix-review-findings）

- codegraph 审查发现 2 个高优先级缺陷：`login_social` 在标准 OAuth 流永不触发
  （`/sign-in/social` 仅发起跳转，会话在 `/callback/:provider` 创建，静态表无法命中）；
  userLead 幂等 check-then-insert 竞态。
- 修复：映射表支持 `*` 结尾前缀规则（`matchEventPath`）；`userId` 声明 `unique: true`
  + 跨库唯一约束冲突按幂等处理（`isUniqueViolationError`）；示例 schema 改唯一索引。
- 信任边界：`normalizeLeadContext` 统一 cookie/请求体可选字段归一化（消灭 track-visit
  私有 optionalString 重复）；埋点 cookie 边界锚定匹配、randomUUID 非安全上下文回退、
  fetch keepalive；trackVisit 落库异常显式 500；示例表 metadata jsonb→text 对齐插件 schema。
- 决策记录：HookContext 类型去重**不做**——共享仅 6 行，extends + 索引类型交叉反而更难读（KISS 优先）。
- 验证：tsc --noEmit ✓；vitest 56/56（新增 12：前缀匹配、伪造 cookie 归一化、竞态兜底、
  埋点桩化测试 vi.stubGlobal，零新依赖）。
- CLI 验证：`@better-auth/cli generate` 经 examples/cli-generate.config.ts
  （drizzleAdapter 包装 + 占位连接串）生成成功，`user_lead.user_id` 生成 `.unique()`，
  F2 幂等约束闭环；CLI 1.4.x 要求根 drizzle-orm 对齐 0.41.0（devDependencies 已固定）。
- 待办：用户未要求提交；任务保持 in_progress，待确认后 commit + archive。

## 2026-09-27 · 第二轮安全/性能审查修复（09-27-fix-vuln-perf-findings）

- 第二轮 codegraph 全模块审查产出 V1-V7（3 中 + 4 低），本轮全部修复：
- V1 限长归一化：导出 `MAX_VISITOR_ID_LENGTH=64` / `MAX_FIELD_LENGTH=2048` 与共享校验器
  `isVisitorId`；visitorId 超长整体拒绝（track-visit 400），可选字段超长丢弃但记录保留。
- V2 幂等键：`ConversionInput`/`ConversionEventRow` 增 `dedupeKey` 透传，宿主按它 upsert
  防 webhook 重试重复计数。
- V3 删除 `LeadAttributionOptions.cookieName`：客户端埋点硬编码 `ba_lead_ctx`，服务端可改名
  必致两端不一致、归因静默失效（功能缺陷，非安全问题）。
- V4 safe-run 包裹：`runLeadAttributionSafely` / `runBehaviorEventSafely` 吞异常并经
  `ctx.context.logger` 记录（无 console），落库失败不再可能阻断注册/登录响应。
- V5 cookie secure：`serializeLeadCookie` 支持 `{ secure }`，埋点按 `location.protocol` 自动开启。
- V6 README 新增「安全与威胁模型」节：自报数据不可用于分成结算、track-visit 宿主配
  rate limit 与 body size 限制。
- V7 回退路径 `body.visitorId` 改用 `isVisitorId`（与 cookie 入口同规则，超长不触发回退查询）。
- 文档同步：design.md §3.2 普通索引改唯一索引（与 F2 修复、examples schema 对齐）。
- 导出面补充：`isVisitorId`、两个限长常量、`SerializeLeadCookieOptions`、
  `ConversionEventRow`、`UserLeadAttribution`。
- 验证：tsc --noEmit ✓；vitest 73/73（新增 17 个用例）。
- 第三轮 codegraph 复审补修 B1-B3：
  - B1 `pickIpAddress`/`pickCountry` 请求头无限长/空串过滤——伪造超长 XFF 首段可直达
    `ip_address` 落库；client-info 统一过 `optionalString`（空头自动回退下一优先级），
    新增 tests/client-info.test.ts（此前零覆盖）。
  - B2 dedupeKey 落库端缺口：schema.pg-drizzle conversionEvent 加 `dedupe_key` + 唯一索引
    （PG 默认 NULLS DISTINCT，旧行为不变），design.md §3.4 同步，examples/auth.ts 传
    `dedupeKey: subscription.id` + `onConflictDoNothing` 幂等写入。
  - B3 `UserLeadAttribution.signupAt` 补契约注释（原始 driver 返回 string 需宿主转 Date）。
  - package.json 复查：src 直发（file: 协议）为开发期有意设计，npm 发布配置属后续工作。
- 最终验证：tsc --noEmit ✓；vitest 80/80（8 个测试文件）。
- 待办：用户未要求提交；任务保持 in_progress。



## Session 1: 二三轮安全审查修复（V1-V7 + B1-B3）
<!-- trellis-session: v=2 fp=16ef45b7fb874f6b -->

**Date**: 2026-09-27
**Task**: 二三轮安全审查修复（V1-V7 + B1-B3）
**Branch**: `main`

### Summary

第二轮审查修复 V1-V7（限长归一化/幂等键/safe-run 旁路防护/cookieName 移除/secure cookie/威胁模型文档），第三轮 codegraph 复审补修 B1-B3（请求头限长与空串过滤、dedupeKey 落库端闭环、signupAt 契约注释）；tsc 通过、vitest 80/80，spec 与 journal 同步更新。

### Git Commits

| Hash | Message |
|------|---------|
| `1657edc` | fix: 插件输入限长、safe-run 旁路防护与 cookieName 移除（V1/V3/V4/V5/V7/B1） |
| `c7133e5` | feat: 转化记录透传 dedupeKey 幂等键（V2/B2/B3） |
| `28bd30c` | docs: 威胁模型、dedupe_key DDL 与插件契约同步（V6） |

### Status

[OK] **Completed**
