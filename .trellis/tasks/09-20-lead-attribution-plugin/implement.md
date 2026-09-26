# 执行计划

## 前置

- [x] 分析 better-auth 官方插件指南（WebFetch）+ context7 确认 hooks/schema/stripe API
- [x] 读取 docs/design.md 全文
- [ ] `npm install`（better-auth / drizzle-orm / drizzle-kit / pg-types 仅类型 / vitest / typescript）

## 步骤（顺序执行，每步可独立验证）

1. **工程脚手架**：package.json、tsconfig.json、vitest.config.ts
2. **共享工具**：`src/utils/lead-context.ts`（cookie 常量 + parse/serialize 纯函数）
3. **drizzle schema**：`src/db/schema.ts`（4 表 + 索引）
4. **leadAttribution 插件**：服务端 + 客户端
5. **behaviorTracker 插件**：服务端 + 客户端
6. **track-visit handler** + **前端埋点** `lead-tracker.client.ts`
7. **recordConversion** + `examples/auth.ts` 集成示例 + `src/index.ts` 出口
8. **测试**：tests/lead-attribution.test.ts、behavior-tracker.test.ts、track-visit.test.ts、conversion.test.ts、lead-context.test.ts
9. **README.md**：安装/注册/迁移/埋点接入说明

## 验证命令

```bash
npx tsc --noEmit        # 类型检查
npx vitest run          # 单测
```

## 审查门

- 步骤 4/5 完成后：对照官方模式检查（satisfies BetterAuthPlugin、id 一致性、$InferServerPlugin）
- 全部完成后：验收标准逐条核对（见 prd.md）

## 回滚点

- 每步均为新增文件；任一步失败可直接删除对应文件重来，无状态残留
