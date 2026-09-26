/**
 * 支付转化记录（docs/design.md 6.3）
 *
 * 供 Stripe/Polar 等支付插件的 onSubscriptionComplete 回调调用：
 * 查询 userLead 归因记录 → 计算注册到付费的天数 → 组装转化事件行。
 * 数据库无关：所有数据访问通过 ConversionDeps 注入，
 * 用户用什么数据库（PostgreSQL / MySQL / SQLite / MongoDB …）就实现什么版本。
 */

/** 归因记录中转化计算所需字段 */
export interface UserLeadAttribution {
  utmSource: string | null;
  country: string | null;
  /** 注册时间；原始 driver（node-pg 等）返回 string 时宿主需自行 new Date(...) 转换 */
  signupAt: Date;
}

/** 待写入的转化事件行（表结构由用户自行决定，此为推荐最小集） */
export interface ConversionEventRow {
  userId: string;
  plan: string;
  utmSource: string | null;
  country: string | null;
  /** 注册到付费的天数（向下取整）；无归因记录时为 null */
  daysToConvert: number | null;
  /**
   * 幂等键（订阅 ID / webhook 事件 ID 等）：支付 webhook 会自动重试，
   * 宿主的 insertConversionEvent 实现应按它做 upsert 或唯一约束，防转化重复计数。
   */
  dedupeKey?: string;
}

export interface ConversionDeps {
  /** 按 userId 查询注册时归因记录（无则返回 null） */
  findUserLead(userId: string): Promise<UserLeadAttribution | null>;
  /** 持久化转化事件 */
  insertConversionEvent(row: ConversionEventRow): Promise<void>;
  /** 时钟注入（测试用），默认 Date.now */
  now?: () => number;
}

export interface ConversionInput {
  /** 支付订阅的 referenceId（即 userId） */
  userId: string;
  /** 计划名，如 "pro" */
  plan: string;
  /** 幂等键（如 subscription.id），透传到 ConversionEventRow.dedupeKey */
  dedupeKey?: string;
}

export async function recordConversion(
  input: ConversionInput,
  deps: ConversionDeps,
): Promise<void> {
  const lead = await deps.findUserLead(input.userId);

  const nowMs = (deps.now ?? Date.now)();
  const daysToConvert =
    lead !== null ? Math.floor((nowMs - lead.signupAt.getTime()) / 86_400_000) : null;

  await deps.insertConversionEvent({
    userId: input.userId,
    plan: input.plan,
    utmSource: lead?.utmSource ?? null,
    country: lead?.country ?? null,
    daysToConvert,
    dedupeKey: input.dedupeKey,
  });
}
