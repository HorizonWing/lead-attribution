# better-auth-lead-attribution

Better Auth 插件：访客线索归因、行为事件追踪与支付转化记录。

打通「访客进站 → 来源识别 → 注册归因 → 支付转化」全链路。
**数据库无关**：插件数据访问全部走 better-auth 的数据库适配器与注入函数，
PostgreSQL、MySQL、SQLite、MongoDB……用户用什么数据库就使用什么数据库。
完整设计见 GitHub 仓库的 `docs/design.md`
（https://github.com/HorizonWing/lead-attribution，以 PostgreSQL 为例，本包实现不绑定任何数据库）。

## 组成

| 模块 | 说明 |
|---|---|
| `leadAttribution()` | 服务端插件：注册/社交回调后将 `ba_lead_ctx` cookie 中的来源（UTM/referrer/落地页/visitorId）与 `userId` 关联写入 `userLead`；cookie 缺失时按 `body.visitorId` 回退查 visitor 表；同一用户幂等 |
| `leadAttributionClient()` | 客户端插件：`$InferServerPlugin` 继承服务端 schema 类型 |
| `behaviorTracker()` | 服务端插件：`/sign-up/email`→`signup`、`/sign-in/email`→`login`、`/sign-in/social`→`login_social` 记入 `userEvent`；`eventPaths` 可覆盖 |
| `behaviorTrackerClient()` | 客户端插件 |
| `captureVisitorContext()` | 前端埋点：首次访问生成 visitorId、解析 UTM、写 cookie、上报 `/api/track/visit` |
| `trackVisit()` | 框架无关的上报 handler（标准 Request/Response），UPSERT 语义由注入的 `upsertVisitor` 实现 |
| `recordConversion()` | 供 Stripe/Polar `onSubscriptionComplete` 回调：查 `userLead`、算 `daysToConvert`、产出转化事件行；读写通过 `findUserLead` / `insertConversionEvent` 注入；`dedupeKey` 幂等键透传（防 webhook 重试重复计数） |

## 数据库无关设计

- **插件模型表**（`userLead` / `userEvent`）：由插件 `schema` 声明、经 better-auth 的
  数据库适配器读写，支持 better-auth 官方适配器覆盖的全部数据库；
  表结构用 `npx @better-auth/cli generate/migrate` 按你的数据库自动生成。
- **visitor / conversion_event 表**：不属于 better-auth 模型，CLI **不会**生成，
  需手动建表——完整 DDL 与手动执行方式见下方「数据库迁移」章节
  （PostgreSQL + Drizzle 参考实现见仓库 `examples/schema.pg-drizzle.ts`）。
- **所有跨表访问都是注入点**：`findVisitorById`（visitor 回退查询）、`upsertVisitor`
  （进站上报）、`findUserLead` / `insertConversionEvent`（转化记录）——本包不含任何
  具体 ORM 依赖。

## 快速开始

```bash
npm i better-auth-lead-attribution
```

### 服务端（auth.ts）

```ts
import { betterAuth } from "better-auth";
import { behaviorTracker, leadAttribution } from "better-auth-lead-attribution";
// 用你自己的数据库/ORM 实现 visitor 查询（示例为伪代码）
import { findVisitorRow } from "./your-db";

export const auth = betterAuth({
  database: yourAdapter, // better-auth 官方适配器：pg / mysql / sqlite / mongodb / kysely …
  plugins: [
    leadAttribution({
      // cookie 缺失时按 visitorId 回退查 visitor 表
      findVisitorById: (visitorId) => findVisitorRow(visitorId),
    }),
    behaviorTracker(),
  ],
});
```

### 客户端（auth-client.ts）

```ts
import { createAuthClient } from "better-auth/client";
import { inferAdditionalFields } from "better-auth/client/plugins";
import {
  behaviorTrackerClient,
  leadAttributionClient,
} from "better-auth-lead-attribution";

export const authClient = createAuthClient({
  plugins: [inferAdditionalFields(), leadAttributionClient(), behaviorTrackerClient()],
});
```

### 前端埋点（应用入口 / 布局组件，仅客户端）

```ts
import { captureVisitorContext } from "better-auth-lead-attribution";

captureVisitorContext(); // 默认上报 /api/track/visit
```

### 上报接口（以 Nuxt/Nitro 为例，UPSERT 由你按数据库实现）

```ts
// server/routes/api/track/visit.post.ts
import { trackVisit } from "better-auth-lead-attribution";
import { upsertVisitorRow } from "./your-db";

export default defineEventHandler((event) =>
  trackVisit(requestFromEvent(event), {
    upsertVisitor: upsertVisitorRow, // 首次来源不覆盖，仅刷新 last_seen_at
  }),
);
```

UPSERT 实现参考（各数据库）：

| 数据库 | 写法 |
|---|---|
| PostgreSQL / SQLite | `INSERT … ON CONFLICT (visitor_id) DO UPDATE SET last_seen_at = now()` |
| MySQL | `INSERT … ON DUPLICATE KEY UPDATE last_seen_at = NOW()` |
| MongoDB | 按 `visitorId` 先查后写，或 `$merge`/`findOneAndUpdate(upsert: true)` |

### 支付转化（Stripe 回调，完整示例见 examples/auth.ts）

```ts
stripe({
  stripeClient,
  createCustomerOnSignUp: true,
  subscription: { enabled: true, plans: [/* ... */] },
  onSubscriptionComplete: async ({ subscription, plan }) => {
    await recordConversion(
      // dedupeKey：Stripe webhook 自动重试时按订阅 ID 去重（insertConversionEvent 实现应按它 upsert/加唯一约束）
      { userId: subscription.referenceId, plan: plan.name, dedupeKey: subscription.id },
      {
        findUserLead: (userId) => /* 你的数据库查询归因记录 */,
        insertConversionEvent: (row) => /* 你的数据库写入转化事件 */,
      },
    );
  },
})
```

Stripe 后台 webhook 指向 `/api/auth/stripe/webhook`，不要另建 webhook 路由。

## 数据库迁移

### 步骤 1：插件模型表（user_lead / user_event）

```bash
npx @better-auth/cli generate
npx @better-auth/cli migrate
```

按你 betterAuth 配置的数据库适配器自动生成。若 CLI 提示
`Your schema is already up to date` / `No migrations needed`，说明这两张表
此前已生成过（插件 schema 未变更时属预期输出），跳到步骤 2 即可。

### 步骤 2：visitor / conversion_event 表（CLI 不会生成，必须手动建）

这两张表通过注入函数（`upsertVisitor` / `insertConversionEvent`）访问，
不在 better-auth 模型体系内，`@better-auth/cli` 永远不会创建它们。
保存以下 DDL 为 `schema-attribution.sql` 并手动执行：

```sql
-- 访客临时存储：首次进站 UPSERT，重复访问仅刷新 last_seen_at
CREATE TABLE visitor (
  visitor_id TEXT PRIMARY KEY,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  landing_page TEXT,
  ip_address TEXT,
  country TEXT,
  first_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_visitor_last_seen ON visitor(last_seen_at);

-- 转化归因总表：dedupe_key 唯一索引防支付 webhook 重试重复计数
-- （PG 唯一索引默认允许多个 NULL，不带 dedupeKey 的历史行不受影响）
CREATE TABLE conversion_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  utm_source TEXT,
  country TEXT,
  days_to_convert INTEGER,
  dedupe_key TEXT,
  converted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversion_utm_source ON conversion_event(utm_source);
CREATE UNIQUE INDEX uniq_conversion_dedupe_key ON conversion_event(dedupe_key);
```

手动执行方式（任选其一）：

- **直连执行**：`psql "$DATABASE_URL" -f schema-attribution.sql`
- **迁移工具**：把 DDL 粘进你的迁移文件（drizzle-kit / prisma migrate / goose / flyway……）
- **Drizzle 用户**：复制仓库 `examples/schema.pg-drizzle.ts` 中 `visitor` / `conversionEvent`
  定义到你的 schema，跑 `drizzle-kit generate && drizzle-kit migrate`
  （仓库地址：https://github.com/HorizonWing/lead-attribution）

注意事项：

- **drizzle schema 表名必须与库一致**：传给 `drizzleAdapter` 的 schema 中，`pgTable`
  第一个参数是 SQL 物理表名，必须与库中实际表名完全一致（本插件为 snake_case：
  `pgTable("user_lead")` / `pgTable("user_event")`）。手写 schema 写成驼峰
  （`pgTable("userEvent")`）会在运行时报 `relation "userEvent" does not exist`
  （PG 42P01）——以 `npx @better-auth/cli generate` 生成的定义为对齐基准。
- **外键顺序**：`conversion_event.user_id` 引用 `"user"(id)`，先确保 better-auth
  核心表 `user` 已存在（首次接入时先跑步骤 1 的 CLI migrate 再执行本 DDL）。
- **非 PostgreSQL 变体**：`TIMESTAMPTZ`→`TIMESTAMP(6)`（MySQL）、`gen_random_uuid()`→
  `UUID()`（MySQL 8）或应用侧生成（SQLite）；其余字段类型各主流库通用。
- **缺失症状**：表不存在时 CLI 不报错，运行时才表现为 `trackVisit` 上报 500
  （visitor 缺失）或 `insertConversionEvent` 抛错（conversion_event 缺失）。

### 参考：user_lead / user_event 完整 DDL（已用步骤 1 生成过则跳过）

若因环境限制无法跑 CLI，这两张表也可手动建（与 CLI 生成功能等价，**同一张表二选一**，
重复执行会因表已存在而失败）：

```sql
CREATE TABLE user_lead (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  visitor_id TEXT,
  utm_source TEXT,
  utm_medium TEXT,
  utm_campaign TEXT,
  referrer TEXT,
  landing_page TEXT,
  ip_address TEXT,
  country TEXT,
  signup_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX uniq_user_lead_user_id ON user_lead(user_id);
CREATE INDEX idx_user_lead_utm_source ON user_lead(utm_source);

CREATE TABLE user_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_event_user_id ON user_event(user_id);
CREATE INDEX idx_user_event_type ON user_event(event_type);
```

### visitor 表清理（替代 KV TTL，30 天未转化）

```sql
DELETE FROM visitor
WHERE last_seen_at < <now减30天>
  AND visitor_id NOT IN (SELECT visitor_id FROM user_lead WHERE visitor_id IS NOT NULL);
```

`<now减30天>` 按数据库替换：PostgreSQL `now() - interval '30 days'`、
MySQL `NOW() - INTERVAL 30 DAY`、SQLite `datetime('now', '-30 days')`。

## 安全与威胁模型

- **归因字段是客户端自报数据**：`ba_lead_ctx` cookie、`/api/track/visit` 请求体、
  `x-forwarded-for` 首段均可被伪造。数据仅用于内部分析（渠道效果、转化周期），
  **不可用于 affiliate 分成、结算等以金钱结算的场景**。
- **`/api/track/visit` 是匿名写端点**：请在宿主框架层配置 rate limit。
  本包已做双重限长：请求体字节上限 16KB（`JSON.parse` 前预检，超限返回 413）与
  字段限长（`visitorId` ≤ 64，`utmSource` 等可选字段 ≤ 2048：超长字段丢弃、
  超长 visitorId 整体拒绝），但频率与总量治理属宿主职责。
- **visitor 表会持续增长**：定期执行上面的「visitor 表清理」SQL。

## 开发

```bash
npm install
npm run typecheck   # tsc --noEmit
npm test            # vitest run（含真实 better-auth 实例的集成测试）
```

## 设计要点

- 插件数据访问走 better-auth adapter（可移植、可 mock），visitor 表回退查询通过
  `findVisitorById` 注入 —— 插件本体不绑定 ORM/数据库；
- 归因/埋点是旁路逻辑：无数据可写时静默跳过，落库异常经 safe-run 包裹记日志后吞掉，
  绝不阻断注册/登录；
- IP 解析优先级 `cf-connecting-ip` → `x-real-ip` → `x-forwarded-for` 首段；
  非 Cloudflare 部署的国家解析方案见 `docs/design.md` 第 8 节（MaxMind GeoLite2）。
