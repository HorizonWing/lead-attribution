# better-auth-lead-attribution

Better Auth 插件：访客线索归因、行为事件追踪与支付转化记录。

打通「访客进站 → 来源识别 → 注册归因 → 支付转化」全链路。
**数据库无关**：插件数据访问全部走 better-auth 的数据库适配器与注入函数，
PostgreSQL、MySQL、SQLite、MongoDB……用户用什么数据库就使用什么数据库。
完整设计见 `docs/design.md`（该文档以 PostgreSQL 为例，本包实现不绑定任何数据库）。

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
- **visitor / conversion_event 表**：不属于 better-auth 模型，由你在自己的技术栈中建表
  （标准 SQL DDL 见 `docs/design.md` 第 3 节；PostgreSQL + Drizzle 参考实现见
  `examples/schema.pg-drizzle.ts`）。
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

1. **插件模型表**（`user_lead` / `user_event`）：`npx @better-auth/cli generate` +
   `npx @better-auth/cli migrate`（按你 betterAuth 配置的数据库适配器生成）。
2. **visitor / conversion_event 表**：用你的迁移工具按 `docs/design.md` 第 3 节的
   标准 SQL 建表（或直接采用 `examples/schema.pg-drizzle.ts`）。

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
- **`/api/track/visit` 是匿名写端点**：请在宿主框架层配置 rate limit 与请求体大小限制。
  本包已做字段限长（`visitorId` ≤ 64，`utmSource` 等可选字段 ≤ 2048：超长字段丢弃、
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
