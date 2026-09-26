# 用户线索归因与支付监控系统 — 技术实现方案（无 Cloudflare 专有产品版）

> 目标：打通「访客进站 → 来源识别 → 注册 → 支付转化」全链路数据，基于 Better Auth 插件机制扩展。
> 本版本仅依赖标准 PostgreSQL 存储，不绑定 Cloudflare KV/D1 等专有产品，方便未来迁移到任意 VPS/云厂商。

## 1. 背景与目标

现有认证系统基于 **Better Auth**，需要在不侵入核心认证逻辑的前提下，新增两类能力：

1. **线索归因**：记录访客从进站起的来源信息（UTM、referrer、落地页、IP、国家），并在用户注册时
   将匿名线索与真实 `userId` 关联。
2. **支付转化追踪**：记录用户从注册到付费的完整时间线，支撑增长分析（转化率、渠道 ROI、转化周期）。

设计原则：

- 不修改 Better Auth 核心表结构（`user`/`session`），新增独立表存储线索数据，通过外键关联。
- 访客阶段（未登录）的数据采集与 Better Auth 完全解耦，避免污染认证逻辑。
- 支付环节复用官方 Stripe/Polar 插件，不重复实现 webhook 签名验证等易错逻辑。
- **全链路只依赖一个标准 PostgreSQL 实例，不绑定任何云厂商专有存储产品**，保证可移植性。

## 2. 整体架构

```
┌─────────────┐    Cookie(ba_lead_ctx)    ┌──────────────────┐
│  访客浏览器   │ ────────────────────────▶ │  API 路由/中间件    │
│ (UTM/Referrer)│                           │  UPSERT 到 PG      │
└─────────────┘                            └──────────────────┘
                                                     │
                                                     ▼ 注册请求
                                          ┌────────────────────────┐
                                          │ Better Auth 核心         │
                                          │  + leadAttribution 插件  │  hooks.after 拦截
                                          │  + behaviorTracker 插件  │  /sign-up, /callback
                                          └────────────────────────┘
                                                     │
                                                     ▼ 写入/关联
                                          ┌────────────────────────┐
                                          │      PostgreSQL          │
                                          │  visitor (访客临时表)    │
                                          │  user_lead (归因表)      │
                                          │  user_event (行为表)     │
                                          └────────────────────────┘
                                                     │
                                                     ▼ 支付完成回调
                                          ┌────────────────────────┐
                                          │ stripe()/polar() 插件    │
                                          │ onSubscriptionComplete  │
                                          └────────────────────────┘
                                                     │
                                                     ▼ 写入
                                          ┌────────────────────────┐
                                          │  conversion_event 表     │
                                          │  （渠道→转化 归因总表）    │
                                          └────────────────────────┘
```

相比依赖 KV 的版本，唯一的结构变化是：访客阶段的临时存储从 KV 换成了 PostgreSQL 的
`visitor` 表，用 `UPSERT`（`INSERT ... ON CONFLICT DO UPDATE`）实现和 KV `put` 等价的写入语义[web:80]，
其余部分（cookie 采集、插件 hooks、支付回调）完全不变。

## 3. 数据层设计

### 3.1 visitor 表（访客临时存储，替代 KV）

```sql
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
```

`last_seen_at` 用于定时清理任务判断访客是否长期未转化。这张表承担了原方案中 KV 的角色，
但多了一个优势：数据永久可查（不受 TTL 自动过期影响），且和其他业务表在同一个数据库里，
join 查询更方便。

### 3.2 user_lead 表（注册时从 visitor/cookie 关联生成）

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
```

### 3.3 user_event 表（行为事件）

```sql
CREATE TABLE user_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT REFERENCES "user"(id) ON DELETE CASCADE,
  event_type TEXT NOT NULL,       -- signup | login | pricing_view | trial_start ...
  metadata JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_user_event_user_id ON user_event(user_id);
CREATE INDEX idx_user_event_type ON user_event(event_type);
```

### 3.4 conversion_event 表（转化归因总表）

```sql
CREATE TABLE conversion_event (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id TEXT NOT NULL REFERENCES "user"(id) ON DELETE CASCADE,
  plan TEXT NOT NULL,
  utm_source TEXT,
  country TEXT,
  days_to_convert INTEGER,
  dedupe_key TEXT,                  -- webhook 重试幂等键（订阅/事件 ID）；PG 唯一索引默认允许多个 NULL
  converted_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_conversion_utm_source ON conversion_event(utm_source);
CREATE UNIQUE INDEX uniq_conversion_dedupe_key ON conversion_event(dedupe_key);
```

## 4. 前端埋点实现

首次访问时生成 `visitorId`、解析 UTM 参数，写入 cookie，并异步上报到后端落库：

```typescript
// app/utils/lead-tracker.client.ts
export function captureVisitorContext() {
  if (document.cookie.includes("ba_lead_ctx=")) return; // 已采集过，不覆盖首次来源

  const params = new URLSearchParams(window.location.search);
  const visitorId = crypto.randomUUID();
  const context = {
    visitorId,
    utmSource: params.get("utm_source") ?? undefined,
    utmMedium: params.get("utm_medium") ?? undefined,
    utmCampaign: params.get("utm_campaign") ?? undefined,
    referrer: document.referrer || undefined,
    landingPage: window.location.pathname,
  };

  document.cookie = `ba_lead_ctx=${encodeURIComponent(
    JSON.stringify(context)
  )}; max-age=2592000; path=/; samesite=lax`;

  fetch("/api/track/visit", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(context),
  }).catch(() => {});
}
```

## 5. 后端上报接口：直接 UPSERT 到 PostgreSQL

```typescript
// server/routes/api/track/visit.ts
import { db } from "../../../db";
import { visitor } from "../../../db/schema";
import { sql } from "drizzle-orm";

export async function POST({ request }: { request: Request }) {
  const body = await request.json();

  // IP/国家解析：若部署在 Cloudflare 后可用其请求头，否则用反向代理注入的头或本地 GeoIP 库
  const ip =
    request.headers.get("cf-connecting-ip") ??
    request.headers.get("x-real-ip") ??
    request.headers.get("x-forwarded-for") ??
    undefined;
  const country = request.headers.get("cf-ipcountry") ?? undefined; // 非 CF 环境见第 8 节

  await db
    .insert(visitor)
    .values({
      visitorId: body.visitorId,
      utmSource: body.utmSource,
      utmMedium: body.utmMedium,
      utmCampaign: body.utmCampaign,
      referrer: body.referrer,
      landingPage: body.landingPage,
      ipAddress: ip,
      country,
    })
    .onConflictDoUpdate({
      target: visitor.visitorId,
      set: { lastSeenAt: sql`now()` }, // 首次来源信息不覆盖，只刷新活跃时间
    });

  return new Response(null, { status: 204 });
}
```

`onConflictDoUpdate` 对应标准 SQL 的 `INSERT ... ON CONFLICT (visitor_id) DO UPDATE`，
是 PostgreSQL 处理 upsert 的推荐写法（9.5+ 内置支持，无需额外扩展）[web:80]。
首次上报插入完整记录，同一访客后续访问只刷新 `last_seen_at`，首次来源信息始终保留，
这一点比 KV 覆盖式写入（`put` 会整体替换旧值）更适合归因场景。

## 6. Better Auth 插件实现

### 6.1 leadAttribution 插件（注册时关联线索）

优先读 cookie；cookie 缺失时（跨设备注册、隐私模式清了 cookie），回退查询 `visitor` 表：

```typescript
// auth/plugins/lead-attribution.ts
import type { BetterAuthPlugin } from "better-auth";
import { db } from "../../db";
import { visitor as visitorTable } from "../../db/schema";
import { eq } from "drizzle-orm";

export const leadAttribution = (): BetterAuthPlugin => ({
  id: "lead-attribution",
  schema: {
    userLead: {
      fields: {
        userId: { type: "string", required: true, references: { model: "user", field: "id" } },
        visitorId: { type: "string" },
        utmSource: { type: "string" },
        utmMedium: { type: "string" },
        utmCampaign: { type: "string" },
        referrer: { type: "string" },
        landingPage: { type: "string" },
        ipAddress: { type: "string" },
        country: { type: "string" },
        signupAt: { type: "date", required: true },
      },
    },
  },
  hooks: {
    after: [
      {
        matcher: (ctx) =>
          ctx.path.startsWith("/sign-up") || ctx.path.startsWith("/callback"),
        handler: async (ctx) => {
          const userId = ctx.context.newSession?.user.id;
          if (!userId) return;

          const rawCookie = ctx.getCookie("ba_lead_ctx");
          let leadCtx: Record<string, string | undefined> = rawCookie
            ? JSON.parse(decodeURIComponent(rawCookie))
            : {};

          // cookie 缺失时回退查 visitor 表（需要前端在请求体里带上 visitorId）
          if (!rawCookie && ctx.body?.visitorId) {
            const [v] = await db
              .select()
              .from(visitorTable)
              .where(eq(visitorTable.visitorId, ctx.body.visitorId))
              .limit(1);
            if (v) leadCtx = v;
          }

          const ip =
            ctx.request?.headers.get("cf-connecting-ip") ??
            ctx.request?.headers.get("x-forwarded-for") ??
            undefined;
          const country = ctx.request?.headers.get("cf-ipcountry") ?? undefined;

          const existing = await ctx.context.adapter.findOne({
            model: "userLead",
            where: [{ field: "userId", value: userId }],
          });
          if (existing) return; // 避免社交登录多次回调重复插入

          await ctx.context.adapter.create({
            model: "userLead",
            data: {
              userId,
              visitorId: leadCtx.visitorId,
              utmSource: leadCtx.utmSource,
              utmMedium: leadCtx.utmMedium,
              utmCampaign: leadCtx.utmCampaign,
              referrer: leadCtx.referrer,
              landingPage: leadCtx.landingPage,
              ipAddress: ip,
              country,
              signupAt: new Date(),
            },
          });
        },
      },
    ],
  },
});
```

### 6.2 behaviorTracker 插件（登录/注册等行为事件）

```typescript
// auth/plugins/behavior-tracker.ts
import type { BetterAuthPlugin } from "better-auth";

const TRACKED_PATHS: Record<string, string> = {
  "/sign-up/email": "signup",
  "/sign-in/email": "login",
  "/sign-in/social": "login_social",
};

export const behaviorTracker = (): BetterAuthPlugin => ({
  id: "behavior-tracker",
  schema: {
    userEvent: {
      fields: {
        userId: { type: "string", references: { model: "user", field: "id" } },
        eventType: { type: "string", required: true },
        metadata: { type: "string" },
        createdAt: { type: "date", required: true },
      },
    },
  },
  hooks: {
    after: [
      {
        matcher: (ctx) => ctx.path in TRACKED_PATHS,
        handler: async (ctx) => {
          const userId = ctx.context.newSession?.user.id ?? ctx.context.session?.user.id;
          if (!userId) return;

          await ctx.context.adapter.create({
            model: "userEvent",
            data: {
              userId,
              eventType: TRACKED_PATHS[ctx.path],
              metadata: JSON.stringify({ path: ctx.path }),
              createdAt: new Date(),
            },
          });
        },
      },
    ],
  },
});
```

### 6.3 支付插件配置（复用官方 Stripe 插件）

```typescript
// auth/index.ts
import { betterAuth } from "better-auth";
import { stripe } from "@better-auth/stripe";
import { leadAttribution } from "./plugins/lead-attribution";
import { behaviorTracker } from "./plugins/behavior-tracker";
import { db } from "../db";
import { conversionEvent, userLead } from "../db/schema";
import { eq } from "drizzle-orm";

export const auth = betterAuth({
  database: /* 标准 PostgreSQL 连接（pg/postgres.js + drizzle 适配器） */,
  plugins: [
    leadAttribution(),
    behaviorTracker(),
    stripe({
      stripeClient,
      createCustomerOnSignUp: true,
      subscription: { enabled: true, plans: [/* ... */] },
      onSubscriptionComplete: async ({ subscription, plan }) => {
        const userId = subscription.referenceId;

        const [lead] = await db
          .select()
          .from(userLead)
          .where(eq(userLead.userId, userId))
          .limit(1);

        const daysToConvert = lead
          ? Math.floor((Date.now() - new Date(lead.signupAt).getTime()) / 86_400_000)
          : null;

        await db.insert(conversionEvent).values({
          userId,
          plan: plan.name,
          utmSource: lead?.utmSource,
          country: lead?.country,
          daysToConvert,
        });
      },
    }),
  ],
});
```

务必在 Stripe 后台配置 webhook 指向 `/api/auth/stripe/webhook`，不要另建 webhook 路由，
避免与插件内部处理产生竞态[web:31][web:36]。

## 7. 数据库迁移

```bash
npx @better-auth/cli generate
npx @better-auth/cli migrate
```

`visitor` 表不属于 Better Auth 插件 schema（不需要关联 user 表），单独手写迁移或放进你现有的
迁移工具（Drizzle Kit / Prisma Migrate）流程即可。

## 8. IP/国家解析：不依赖 Cloudflare 专有能力

如果最终不打算绑定 Cloudflare Workers 部署，`cf-connecting-ip`/`cf-ipcountry` 这两个头也需要替换：

- **IP 地址**：反向代理（Nginx/Caddy）注入 `X-Real-IP` 或标准的 `X-Forwarded-For`，应用层直接读取。
- **国家解析**：本地部署 MaxMind GeoLite2 免费库（`.mmdb` 文件），用 `maxmind` 或 `geoip-lite` 这类
  Node.js 库离线查询，不需要调用任何第三方 API，也没有请求次数限制，适合自托管 VPS 场景。

```typescript
import { Reader } from "@maxmind/geoip2-node";

const reader = await Reader.open("./GeoLite2-Country.mmdb");
const country = reader.country(ip).country?.isoCode;
```

## 9. 定时清理任务（替代 KV 的 TTL 自动过期）

```sql
-- 清理 30 天未转化、也无后续活跃的访客记录
DELETE FROM visitor
WHERE last_seen_at < now() - interval '30 days'
  AND visitor_id NOT IN (SELECT visitor_id FROM user_lead WHERE visitor_id IS NOT NULL);
```

可用 `pg_cron`（若数据库支持该扩展）或应用层定时任务（cron job / Cloudflare Workers Cron Triggers
如果部署环境允许）定期执行，避免 `visitor` 表无限增长。

## 10. 分析查询示例

```sql
-- 各渠道注册数 vs 付费转化数
SELECT
  ul.utm_source,
  COUNT(DISTINCT ul.user_id) AS signups,
  COUNT(DISTINCT ce.user_id) AS conversions,
  ROUND(COUNT(DISTINCT ce.user_id)::numeric / COUNT(DISTINCT ul.user_id) * 100, 2) AS conversion_rate
FROM user_lead ul
LEFT JOIN conversion_event ce ON ce.user_id = ul.user_id
GROUP BY ul.utm_source
ORDER BY conversions DESC;

-- 平均转化周期（按国家）
SELECT country, AVG(days_to_convert) AS avg_days
FROM conversion_event
GROUP BY country;
```

## 11. 架构对比：调整前后

| 组件 | 依赖 Cloudflare KV 的方案 | 本方案（仅 PostgreSQL） |
|---|---|---|
| 访客临时存储 | Cloudflare KV | PostgreSQL `visitor` 表 |
| 写入方式 | `kv.put()` | `INSERT ... ON CONFLICT DO UPDATE` |
| 自动过期 | TTL 自动清理 | 定时任务 `DELETE ... WHERE last_seen_at < ...` |
| IP/国家来源 | `cf-connecting-ip`/`cf-ipcountry` 请求头 | 反向代理头 + 本地 MaxMind GeoLite2 库 |
| 部署耦合度 | 绑定 Cloudflare Workers + KV | 仅依赖标准 PostgreSQL，可迁移到任意 VPS/云厂商 |
| 首次来源保留 | 依赖手动实现（TTL 覆盖写入需额外判断） | `ON CONFLICT DO UPDATE` 天然只更新指定字段，首次来源自动保留 |

## 12. 后续可选扩展

- **匿名用户先行方案**：启用 Better Auth 的 Anonymous 插件，让访客首次有意义交互时即创建匿名
  `user` 记录，注册时走 account linking 转正，行为数据从第一天起绑定真实 `userId`。
- **可视化后台**：如需现成归因/会话管理面板，可评估 Better Auth Studio 或 Better Auth Console
  这类第三方管理界面。
- **高并发场景优化**：若访客上报量很大，`visitor` 表写入可以考虑批量合并（应用层攒批后定时批量
  upsert），减少数据库连接压力，避免每次访问都触发一次单独事务。

## 13. 开发排期建议

| 阶段 | 内容 | 预估工作量 |
|---|---|---|
| 1 | 前端埋点 + visitor 表上报接口 | 0.5 天 |
| 2 | leadAttribution 插件 + 迁移 | 0.5 天 |
| 3 | behaviorTracker 插件 | 0.5 天 |
| 4 | Stripe 插件接入 + onSubscriptionComplete 回调 | 1 天 |
| 5 | GeoIP 本地库集成（若非 Cloudflare 部署） | 0.5 天 |
| 6 | 归因查询/看板验证 + 定时清理任务 | 0.5 天 |

总计约 3.5 个工作日可跑通最小闭环，全程只依赖一个 PostgreSQL 实例，架构可移植性更强。

