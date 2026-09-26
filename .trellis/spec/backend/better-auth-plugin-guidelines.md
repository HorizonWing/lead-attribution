# Better Auth 插件开发契约

> 来源：lead-attribution 插件实现（2026-09-20，任务 09-20-lead-attribution-plugin）。
> 版本基线：better-auth 1.7.5。

---

## 插件结构（官方模式）

```ts
export const myPlugin = (options: MyPluginOptions = {}) =>
  ({
    id: "my-plugin",                    // 全局唯一；客户端插件 id 必须一致
    schema: { myModel: { fields: { /* ... */ } } },   // 自定义模型表
    hooks: {
      after: [
        {
          matcher: (ctx) => ctx.path !== undefined && ctx.path.startsWith("/sign-up"),
          handler: createAuthMiddleware(async (ctx) => { /* ... */ }),
        },
      ],
    },
  }) satisfies BetterAuthPlugin;
```

- `ctx.path` 类型为 `string | undefined`，matcher 里必须判空。
- 动态路径段（如 `/callback/:provider`）无法静态精确枚举：映射键支持 `*` 结尾的
  前缀规则，精确命中优先于前缀（见 behavior-tracker 的 `matchEventPath`）。
- `ctx.getCookie(name)` 返回**已解析的单个 cookie 值**（不是完整 Cookie 头），
  值是 URL 编码的 JSON 时需 `decodeURIComponent` + `JSON.parse`。
- `ctx.context.newSession` 仅在创建会话的端点（sign-up / callback）之后存在；
  sign-in 场景用 `ctx.context.session`。
- 标准授权码流程中 `/sign-in/social` **仅返回跳转 URL**（此时无 newSession/session），
  会话在 `/callback/:id` 创建；id_token 直发流程（Apple 表单提交等）例外，
  在 `/sign-in/social` 即完成建会话。
- IP 提取优先级：`cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` 首段。

## ⚠️ 关键陷阱：createAuthMiddleware 返回值不可直调

`createAuthMiddleware(fn)` 来自 `@better-auth/core/api`，实现为
`createMiddleware.create({ use: [optionsMiddleware, ...] })` 预构建 endpoint 工厂。
**直接调用 `hook.handler(mockCtx)` 不会执行 fn** —— 不报错、静默返回，
导致 `not.toHaveBeenCalled()` 类断言假通过。

**正确测试策略**：

1. hook 逻辑主体抽成独立导出函数（如 `handleLeadAttribution(ctx, options)`），
   ctx 用最小结构化类型（自定义 interface，不用 better-auth 泛型 EndpointContext）；
   单元测试直接调用该函数 + mock adapter。
2. 另写集成测试兜底：`betterAuth({ database: memoryAdapter({...}) })` +
   `auth.handler(new Request(...))` 走真实注册链路，
   断言 `auth.$context.adapter.findOne({ model, where })` 落库结果。
   memoryAdapter 来自 `better-auth/adapters/memory`（无需外部依赖）。
3. 插件数据访问走 `ctx.context.adapter`（可移植可 mock）；
   非 auth 表（如 visitor）的查询通过插件 options 注入函数（DIP），不在插件内 import ORM。

## Schema 与迁移

- 插件 schema 定义新模型（非 user 扩展）完全合法：`schema: { userLead: { fields: {...} } }`，
  `modelName` 默认取 key。
- 字段类型：`string | number | boolean | date`；引用用
  `references: { model: "user", field: "id" }`。
- 迁移二选一：`npx @better-auth/cli generate/migrate`（插件模型表）或
  全部走 Drizzle Kit（需手写映射 schema）。
- drizzle-orm 版本需匹配 better-auth 的 peerOptional 约束（1.7.x 要求 `^0.45.2`）。
- 用 `@better-auth/cli generate` 验证插件 schema：`database` 必须传
  `drizzleAdapter(db, { provider })` 包装——直接传 drizzle 实例 CLI 不识别，
  报 `dialect.createDriver is not a function`；generate 只读模型定义不连库，
  连接串用占位符即可（见 examples/cli-generate.config.ts）。
- CLI 1.4.x 自嵌 drizzle-orm 0.41，仓库 devDependencies 的 drizzle-orm 须对齐
  0.41.0 才能跑通（跨版本实例 API 不匹配）。仅 CLI 验证路径如此：
  插件运行时不依赖 drizzle，宿主版本按上面 peerOptional 约束自选。

## 幂等写表模式（防并发重复插入）

- `findOne → create` 非原子，并发回调可穿透检查；靠数据库唯一约束兜底：
  - 插件 schema 字段声明 `unique: true`（`DBFieldAttributeConfig` 支持）；
  - 宿主手写 schema 时用**唯一索引**（`uniqueIndex`），不是普通 `index`。
- `create` 捕获唯一约束冲突（PG `23505` / MySQL `ER_DUP_ENTRY` /
  SQLite "UNIQUE constraint" / Mongo `E11000`）按幂等成功处理，
  其余错误照常抛出（见 lead-attribution 的 `isUniqueViolationError`）。
- 外部输入（cookie/请求体）的可选字段落库前必须归一化：
  统一走 `normalizeLeadContext`，且**必须限长**——`visitorId` ≤ 64
  （共享校验器 `isVisitorId`，超长整体拒绝），可选字段 ≤ 2048（超长归
  `undefined`，记录本身保留）。限长封堵匿名上报接口的超长载荷与超长主键查询，
  cookie 与 HTTP 请求体两个入口同一规则。
- IP/国家**请求头**提取（`pickIpAddress`/`pickCountry`）同属可伪造输入，
  同样过 `optionalString` 限长并过滤空串——否则伪造的超长 `x-forwarded-for`
  首段可绕过 body 限长直达落库。
- 支付回调类写入带幂等键：`ConversionInput.dedupeKey`（订阅/webhook 事件 ID）
  透传到 `ConversionEventRow`，宿主 insert 实现按它 upsert 或唯一约束
  （Stripe/Polar webhook 会自动重试，重复触发是常态而非异常）。

## 旁路 hook 安全执行（safe-run 包裹）

归因/埋点 after hook 的落库失败**不得**把已成功的注册/登录变成失败响应：

```ts
export async function runXxxSafely(ctx, options): Promise<void> {
  try {
    await handleXxx(ctx, options);
  } catch (error) {
    ctx.context.logger?.error("[plugin-id] xxx write failed", error);
  }
}
```

- handler 委托 safe-run 包装器，不直接调主逻辑；包装器不导出（内部实现），
  主逻辑仍独立导出供单测。
- 日志走 `ctx.context.logger`（better-auth 运行时注入），**不用 console**——
  库代码不劫持宿主日志配置；logger 缺省时（单测构造）静默。
- 唯一约束冲突在主逻辑内消化（见上节），safe-run 只兜连接抖动等其余异常。

## 客户端插件

```ts
export const myClientPlugin = () => ({
  id: "my-plugin",                                   // 与服务端一致
  $InferServerPlugin: {} as ReturnType<typeof myPlugin>,
}) satisfies BetterAuthClientPlugin;
```
