/**
 * 【可选参考实现】PostgreSQL + Drizzle 的归因数据表（docs/design.md 3.1–3.4）。
 *
 * 本包核心功能数据库无关：插件模型表（user_lead / user_event）由 better-auth 的
 * 数据库适配器管理（`npx @better-auth/cli generate/migrate`，支持 PostgreSQL、
 * MySQL、SQLite、MongoDB 等）；visitor / conversion_event 两张表可用任意技术栈建表。
 *
 * 仅当你选择 PostgreSQL + Drizzle 时，才需要本文件（接入宿主 Drizzle Kit 流程）。
 * 使用前安装：npm i drizzle-orm
 */
import { index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** 3.1 访客临时存储：首次进站 UPSERT，重复访问仅刷新 lastSeenAt */
export const visitor = pgTable(
  "visitor",
  {
    visitorId: text("visitor_id").primaryKey(),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    referrer: text("referrer"),
    landingPage: text("landing_page"),
    ipAddress: text("ip_address"),
    country: text("country"),
    firstSeenAt: timestamp("first_seen_at", { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("idx_visitor_last_seen").on(t.lastSeenAt)],
);

/** 3.2 注册归因表：注册时从 cookie/visitor 关联生成，一个用户一条 */
export const userLead = pgTable(
  "user_lead",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    visitorId: text("visitor_id"),
    utmSource: text("utm_source"),
    utmMedium: text("utm_medium"),
    utmCampaign: text("utm_campaign"),
    referrer: text("referrer"),
    landingPage: text("landing_page"),
    ipAddress: text("ip_address"),
    country: text("country"),
    signupAt: timestamp("signup_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // 唯一索引而非普通索引：同一用户仅一条首触记录，兜底插件端 findOne→create 的并发竞态
    uniqueIndex("uniq_user_lead_user_id").on(t.userId),
    index("idx_user_lead_utm_source").on(t.utmSource),
  ],
);

/** 3.3 行为事件表：signup / login / pricing_view 等时间线 */
export const userEvent = pgTable(
  "user_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id").references(() => authUser.id, { onDelete: "cascade" }),
    eventType: text("event_type").notNull(),
    metadata: text("metadata"), // JSON 字符串，与插件 schema 的 string 类型一致
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_user_event_user_id").on(t.userId),
    index("idx_user_event_type").on(t.eventType),
  ],
);

/** 3.4 转化归因总表：支付完成回调时写入 */
export const conversionEvent = pgTable(
  "conversion_event",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    userId: text("user_id")
      .notNull()
      .references(() => authUser.id, { onDelete: "cascade" }),
    plan: text("plan").notNull(),
    utmSource: text("utm_source"),
    country: text("country"),
    daysToConvert: integer("days_to_convert"),
    // webhook 重试幂等键（订阅/事件 ID）；NULL 行不受唯一约束影响（PG 默认 NULLS DISTINCT）
    dedupeKey: text("dedupe_key"),
    convertedAt: timestamp("converted_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("idx_conversion_utm_source").on(t.utmSource),
    uniqueIndex("uniq_conversion_dedupe_key").on(t.dedupeKey),
  ],
);

/**
 * Better Auth 核心 user 表的占位声明：drizzle 外键需要引用目标表。
 * 宿主项目中应替换为真实生成的 user 表定义（npx @better-auth/cli generate）。
 */
export const authUser = pgTable("user", {
  id: text("id").primaryKey(),
});
