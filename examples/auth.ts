/**
 * 集成示例（docs/design.md 6.3）：betterAuth + Stripe + 本插件组。
 *
 * 本包核心功能数据库无关——所有数据访问都是注入函数，换数据库只改这几处实现。
 * 本示例以 PostgreSQL + Drizzle 演示；MySQL / SQLite / MongoDB 等按同一签名替换即可
 * （如需 drizzle 表参考，见 ./schema.pg-drizzle.ts）。
 *
 * 示例性质，不参与本包类型检查——宿主项目需自行安装：
 *   npm i @better-auth/stripe stripe drizzle-orm
 */
import { betterAuth } from "better-auth";
import { stripe } from "@better-auth/stripe";
import Stripe from "stripe";
import { drizzle } from "drizzle-orm/node-postgres";
import { eq, sql } from "drizzle-orm";

import { behaviorTracker, leadAttribution, recordConversion } from "../src";
// 下方 visitor / userLead / conversionEvent 表定义见 ./schema.pg-drizzle.ts（PG + Drizzle 参考）
import { conversionEvent, userLead, visitor } from "./schema.pg-drizzle";

const db = drizzle(process.env.DATABASE_URL!);
const stripeClient = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2026-06-24.dahlia",
});

export const auth = betterAuth({
  database: db, // better-auth 支持任意数据库适配器；插件模型表随宿主数据库走
  plugins: [
    leadAttribution({
      // cookie 缺失时按 visitorId 回退查 visitor 表。
      // MySQL/SQLite 等换任意驱动实现同一签名即可（UPSERT 语义同理）
      findVisitorById: async (visitorId) => {
        const [row] = await db
          .select()
          .from(visitor)
          .where(eq(visitor.visitorId, visitorId))
          .limit(1);
        return row ?? null;
      },
    }),
    behaviorTracker(),
    stripe({
      stripeClient,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      createCustomerOnSignUp: true,
      subscription: {
        enabled: true,
        plans: [
          { name: "pro", priceId: process.env.STRIPE_PRICE_PRO! },
          { name: "team", priceId: process.env.STRIPE_PRICE_TEAM! },
        ],
      },
      // 务必在 Stripe 后台把 webhook 指向 /api/auth/stripe/webhook，
      // 不要另建 webhook 路由，避免与插件内部处理产生竞态
      onSubscriptionComplete: async ({ subscription, plan }) => {
        await recordConversion(
          { userId: subscription.referenceId, plan: plan.name },
          {
            findUserLead: async (userId) => {
              const [row] = await db
                .select({
                  utmSource: userLead.utmSource,
                  country: userLead.country,
                  signupAt: userLead.signupAt,
                })
                .from(userLead)
                .where(eq(userLead.userId, userId))
                .limit(1);
              return row ?? null;
            },
            insertConversionEvent: async (row) => {
              await db.insert(conversionEvent).values(row);
            },
          },
        );
      },
    }),
  ],
});

/** visitor 表定时清理（30 天未转化），PG 语法；MySQL 用 `NOW() - INTERVAL 30 DAY` */
export const CLEANUP_VISITOR_SQL = sql`
  DELETE FROM visitor
  WHERE last_seen_at < now() - interval '30 days'
    AND visitor_id NOT IN (SELECT visitor_id FROM user_lead WHERE visitor_id IS NOT NULL)
`;
