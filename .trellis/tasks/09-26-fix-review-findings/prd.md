# PRD：修复 codegraph 审查发现的归因链路缺陷

> 来源：2026-09-26 全链路 codegraph 审查（会话 968fbbd3）。
> 范围：src/、examples/、tests/。不改对外 API 的兼容签名，仅加法与行为修正。

## 背景

审查确认整体架构（DI、框架无关、薄 handler + 可导出逻辑函数）无需调整，
但存在 2 个高优先级逻辑缺陷与若干信任边界/健壮性问题。

## 需求与验收标准

### F1 社交登录行为事件丢失（高）

标准授权码流程中 `/sign-in/social` 仅发起跳转（无 newSession/session），
会话在 `/callback/:provider` 创建；现有精确匹配 + 静态映射表导致 `login_social` 永不触发。

- 行为追踪映射支持前缀规则（键以 `*` 结尾按前缀匹配），默认表新增 `/callback/*` → `login_social`；
- 保留 `/sign-in/social`（id_token 直发流程在该端点即完成）；
- 单测覆盖 `/callback/google` 命中、`/callbackish` 类前缀误命中不发生。

### F2 userLead 幂等竞态（高）

findOne → create 非原子，并发回调可插入重复首触记录。

- 插件 schema `userLead.userId` 声明 `unique: true`；
- `create` 捕获跨库唯一约束冲突（PG 23505 / MySQL ER_DUP_ENTRY / SQLite / Mongo E11000），按幂等成功处理，其余错误照常抛出；
- 示例 schema `idx_user_lead_user_id` 改为唯一索引。

### F3 cookie 可选字段未校验（中）

`isLeadContext` 只校验 visitorId；伪造 cookie 的对象/数字字段会原样落库。

- `lead-context.ts` 新增 `normalizeLeadContext`（校验 + 可选字段归一化为非空 string）；
- `parseLeadCookieValue` 与 `trackVisit` 共用之（DRY：删除 track-visit 私有 `optionalString` 重复实现）。

### F4 埋点健壮性（中）

- cookie 存在性判断改为边界锚定匹配（`xba_lead_ctx=` 不再误判为已采集）；
- `crypto.randomUUID` 不可用时回退 `getRandomValues`（非安全上下文 HTTP）；
- 上报 fetch 增加 `keepalive: true`（落地页秒跳转不丢首次来源）；
- 补齐 `captureVisitorContext` 单测（node 环境用 `vi.stubGlobal` 桩化浏览器全局对象，不引新依赖）。

### F5 trackVisit 落库异常兜底（低）

`upsertVisitor` 抛错时返回显式 500（不泄漏内部错误信息），不再让宿主拿到未处理 rejection。

### F6 metadata 类型一致性（低）

示例 drizzle 表 `metadata` 由 `jsonb` 改为 `text`，与插件 schema（string + JSON.stringify）对齐。

### 不做（审查项 9：HookContext 类型去重）

两个 HookContext 接口的公共部分仅 6 行；提取共享基座需引入
`extends` + 索引类型交叉，可读性反而下降。KISS 优先，维持现状。

## 验证命令

```bash
npm run typecheck
npm test
```
