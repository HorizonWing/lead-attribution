/**
 * 仅供 `npx @better-auth/cli generate` 验证插件 schema 使用
 * （examples 已被 tsconfig 排除，不参与本包类型检查；本文件不是运行时代码）。
 *
 * generate 只读取模型定义、不建立数据库连接，drizzle 用占位连接串即可。
 * 验证目标：userLead.userId 的 unique 约束、userEvent/userLead 全字段能被正确生成。
 */
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { drizzle } from "drizzle-orm/node-postgres";

import { behaviorTracker, leadAttribution } from "../src";

export const auth = betterAuth({
  database: drizzleAdapter(
    drizzle("postgresql://placeholder:placeholder@localhost:5432/placeholder"),
    { provider: "pg" },
  ),
  plugins: [leadAttribution(), behaviorTracker()],
});
