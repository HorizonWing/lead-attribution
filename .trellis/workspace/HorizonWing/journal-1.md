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

