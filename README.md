# Witch 搜索修复候选与离线验证

本目录是 `worldhello-bj/witch` 交接包的修复候选，不是完整 Witch 应用，也不是可直接部署的 QQ 程序。原交接文件保留在 `HANDOFF.md`、`review/`、`changes.patch`；首轮结论与兼容说明见 [证据绑定修复评估](review/2026-10-11-search-fix-assessment.md)，当前完整结果见 [格式、正文与超时修复](review/2026-10-11-format-body-timeout-fix.md)。

## 运行

Node.js 24，无需 API key，也不加载 `.env`。

```sh
npm test
npm run check
npm run smoke:glm:isolated
npm run smoke:providers:isolated
```

定向回归使用真实源码快照的转译结果，全部模型/检索输入为本地模拟。GLM smoke 使用明确的 `buildBrainPrompt` 测试替身，因为交接包缺少原人格模块；provider smoke 仅执行原文件的适配器契约部分，省略缺失运行时/预算辅助模块依赖的部分。它们都不是原项目的 `npm run smoke` 全应用通过。

可选严格类型检查（官方 npm 依赖，版本锁定）：

```sh
npm ci --ignore-scripts
npm run typecheck:isolated
```

类型检查覆盖 `glm.ts`、`web-search.ts`、`http-json.ts`、`config.ts`、`types.ts`，对缺失人格/记忆/运行时模块使用明确的只读声明边界。不是完整应用类型检查。

在包含原仓库历史的 checkout 中重跑修复前反例：

```sh
WITCH_BASELINE_REF=da37de9dba2b460000e822a1613465f55671626a npm test
```

Windows PowerShell 可先设置 `$env:WITCH_BASELINE_REF="da37de9dba2b460000e822a1613465f55671626a"`，测试后删除该环境变量。预期基线有失败，因为回归断言针对修复后协议。

## 集成

生产代码映射：
- `current-source/glm.ts` → 原项目 `src/brain/glm.ts`
- `current-source/web-search.ts` → 原项目 `src/brain/web-search.ts`
- `current-source/http-json.ts` → 原项目新增 `src/brain/http-json.ts`
- `current-source/config.ts`、`index.ts`、`types.ts` → 原项目 `src/` 下同名文件
- `current-source/glm-smoke.mjs` → 原项目 `scripts/glm-smoke.mjs`

补丁以本次交接快照为基线，不应直接套到更早的 `33bc2c6`，也不要覆盖原工作树未提交改动。先在完整项目的隔离分支使用 `git apply --check`，人工合并现有改动，再运行完整项目自身的构建、类型检查和 smoke。

本候选通过专用分支与草稿 PR 交付。没有修改正式目录、部署、重启、发送 QQ 或调用真实搜索/GLM。

总研究期限由 `GLM_WEB_SEARCH_TURN_TIMEOUT_MS` 设置（默认180000毫秒，范围10000–600000）；智谱单次搜索使用 `GLM_WEB_SEARCH_TIMEOUT_MS`（默认30000毫秒，范围1000–120000），不再误用模型180秒请求预算。其他搜索后端保留各自单请求配置。
