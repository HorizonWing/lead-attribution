# 技术设计：lead-attribution 插件包

> 上游设计：`docs/design.md`（整体架构/SQL/时序以它为准，本文只定义插件包内的边界与契约）

## 包结构

```
├── package.json / tsconfig.json / vitest.config.ts
├── src/
│   ├── index.ts                        # 出口：两个服务端插件 + 两个客户端插件 + 工具
│   ├── plugins/
│   │   ├── lead-attribution.ts         # R1 服务端插件
│   │   ├── lead-attribution-client.ts  # R1 客户端插件
│   │   ├── behavior-tracker.ts         # R2 服务端插件
│   │   └── behavior-tracker-client.ts  # R2 客户端插件
│   ├── conversion.ts                   # R4 recordConversion（注入 db + 表）
│   ├── routes/
│   │   └── track-visit.ts              # R3 上报 handler（fetch 标准 Request/Response）
│   ├── utils/
│   │   ├── lead-context.ts             # LEAD_COOKIE 常量 + 解析/序列化（前后端共享，纯函数）
│   │   └── lead-tracker.client.ts      # R3 captureVisitorContext（浏览器端）
│   └── db/
│       └── schema.ts                   # R5 drizzle-pg 表定义（集成参考实现）
├── examples/
│   └── auth.ts                         # betterAuth + stripe 集成示例
└── tests/                              # vitest 单测（mock adapter / mock db）
```

## 关键契约

### 1. leadAttribution options（依赖注入，DIP）

```ts
type FindVisitor = (visitorId: string) => Promise<VisitorRow | null>;
type LeadAttributionOptions = {
  /** cookie 缺失时按 visitorId 回退查 visitor 表；不传则跳过回退 */
  findVisitorById?: FindVisitor;
  /** 自定义 cookie 名，默认 LEAD_COOKIE 常量 "ba_lead_ctx" */
  cookieName?: string;
};
```

- `userLead`/`userEvent` 模型读写全部走 `ctx.context.adapter`（better-auth 抽象层，
  兼容 pg/k2/drizzle 等任意 adapter），插件本体不 import drizzle —— 可移植、可 mock。
- visitor 表回退查询通过 `findVisitorById` 注入（设计文档中 visitor 表不属于插件 schema，
  各项目表结构一致，注入函数即可解耦 ORM 细节）。

### 2. hooks 结构（已对照 better-auth 官方指南与源码文档确认）

```ts
hooks: {
  after: [
    {
      matcher: (ctx) => ctx.path.startsWith("/sign-up") || ctx.path.startsWith("/callback"),
      handler: createAuthMiddleware(async (ctx) => { /* ... */ }),
    },
  ],
}
```

- `ctx.getCookie(name)` 读 cookie；`ctx.context.newSession?.user.id` 取注册用户；
  `ctx.request?.headers` 提取 IP/国家；幂等保护用 adapter.findOne。
- behaviorTracker 的路径映射 `/sign-up/email→signup`、`/sign-in/email→login`、
  `/sign-in/social→login_social` 作为默认值，options 可覆盖。

### 3. 客户端插件

`id` 与服务端一致 + `$InferServerPlugin: {} as ReturnType<typeof serverPlugin>`，
使 `inferAdditionalFields` 等机制能继承服务端类型。

### 4. track-visit handler（框架无关）

`trackVisit(request, deps)` 接收标准 `Request`，内部用注入的 `upsertVisitor(row)` 落库；
返回 `Response(null, { status: 204 })`。IP/国家按 design.md 第 8 节读取请求头，
不绑定 Cloudflare（缺少则 undefined）。校验 `visitorId` 必填（输入校验边界，fail-fast 400）。

### 5. recordConversion（可复用、可测试）

```ts
type ConversionDeps = {
  db: DrizzleDb;                      // 最小结构类型：query/select/insert 能力
  userLeadTable; conversionEventTable;
  now?: () => number;                 // 便于测试注入时钟
};
recordConversion({ userId, plan }, deps): Promise<void>
```
- 查 userLead → daysToConvert = floor((now - signupAt)/86400000)（无 lead 则 null）→ insert conversionEvent。

### 6. drizzle schema（design.md 3.1–3.4 的 1:1 映射）

- `visitor`（visitor_id PK）、`user_lead`（FK user.id CASCADE + 索引 utm_source）、
  `user_event`（FK 可空 user.id + 索引 event_type）、`conversion_event`（FK + 索引 utm_source）。
- 插件声明的 better-auth schema（userLead/userEvent 模型）与上述表语义一致；
  表的物理创建二选一：`@better-auth/cli migrate`（插件模型表）+ Drizzle Kit（visitor 表），
  或直接全部用 Drizzle Kit（drizzle schema 已给出）。

## 权衡记录

- **adapter vs 直连 db**：插件走 adapter 换取可移植/可测试；代价是失去 drizzle 的
  ON CONFLICT 能力——但插件写 userLead 是一次性 insert（幂等由 findOne 保证），无此需求。
- **cookie 直读而非签名 cookie**：归因数据非敏感且允许伪造（只影响分析口径），
  KISS 优先；后续可换 `getSignedCookie` 不破坏结构。
- ** visitor 表不进插件 schema**：与 design.md 第 7 节一致，避免 CLI 迁移生成无主键关联的孤儿模型。

## 回滚

纯新增代码，未触碰任何现有文件；回滚 = 删除新增目录。
