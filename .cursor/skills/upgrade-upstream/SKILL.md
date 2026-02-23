---
name: upgrade-upstream
description: Upgrade OpenClaw to a newer upstream version (merge upstream tags/commits). Use when the user asks to upgrade, sync, merge upstream, pull latest openclaw version, or mentions upstream alignment.
---

# Upgrade OpenClaw to Upstream

## Core Principle: 只改适配层，不改核心

本地仓库是 upstream openclaw 的 fork，包含本地定制（feishu-her 插件、realtime 插件、Docker 部署脚本等）。升级时的原则：

1. **绝对不能动的**：`extensions/feishu-her/`、`extensions/realtime/`、`docker/`、`start-user.sh`、`start.sh`、`start-tunnel.sh` 的业务逻辑
2. **可以动的**：这些文件的**类型适配**（upstream 改了接口签名，本地插件需要跟着改类型声明）
3. **唯一信源**：`docker/carher-config.json` 是所有环境（本地 Her + Docker 容器）的基础配置，通过 `$include` 机制继承

## 升级前评估

### Step 1: 确定目标版本

```bash
git fetch origin
git tag --sort=-creatordate | head -10
```

选择最新的稳定 tag（格式 `vYYYY.M.D`），避免 `-beta` 或 `-rc` 版本。

### Step 2: 评估差异范围

```bash
git log --oneline HEAD..v2026.X.Y | wc -l
git diff --stat HEAD..v2026.X.Y
```

重点关注：

- `src/` 核心代码变化量
- `extensions/feishu/` 上游飞书插件变化（可能与 `feishu-her` 冲突）
- `package.json` 依赖变化
- 构建系统变化（`tsdown.config.ts`、`dist/` 输出结构）

### Step 3: 搜索 GitHub issues/changelog

检查目标版本的已知问题，确认稳定性。

## 升级执行

### Step 1: 合并

```bash
git merge v2026.X.Y --no-edit
```

### Step 2: 解决冲突

冲突优先级：

1. `pnpm-lock.yaml` → 取 upstream 版本，后面 `pnpm install` 会重新生成
2. `.gitignore` → 手动合并，保留两边条目，去重
3. `extensions/feishu/` → 取 upstream（我们用 `feishu-her`，上游 feishu 通过 `plugins.deny` 禁用）
4. 本地定制文件 → 保留本地版本

### Step 3: 安装依赖

```bash
pnpm install --no-frozen-lockfile
```

### Step 3.5: 验证 pnpm patch 自动应用

`pnpm install` 后必须验证 `pnpm.patchedDependencies` 中的所有 patch 已生效：

```bash
# Patch 4: compaction keptMessages 修复
grep -c 'prevKeptMessages' node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js
# 期望输出: 3。如果输出 0，说明 pnpm patch 未生效，立即排查。
```

如果 npm 包版本号变了（不再是 `0.54.0`），patch 会失效。此时需要检查新版本是否已内置修复，若未内置则重新生成 patch（见 Patch 4 说明）。

### Step 4: 全量检查

```bash
pnpm build && pnpm check && pnpm test
```

常见问题及修复：

- **格式问题**：`pnpm format` 自动修复（upstream 可能升级了 oxfmt）
- **类型错误**：upstream 收紧了类型，需要在 `feishu-her` 和 `realtime` 中做类型适配
- **lint 错误**：删除未使用的变量/函数
- **构建产物路径变化**：检查 `realtime/src/core-bridge.ts` 是否需要更新 import 路径

### Step 5: 修复 realtime 插件的 core-bridge

upstream 可能改变 `dist/` 输出结构。`realtime` 插件通过 `dist/extensionAPI.js` 导入核心函数。如果缺少导出：

1. 检查 `src/extensionAPI.ts` 是否导出了 `realtime` 需要的所有函数
2. 如有缺失，添加导出并重新 build

## 升级后配置检查

### 唯一信源：`docker/carher-config.json`

```
~/.openclaw/openclaw.json          ← $include → docker/carher-config.json
/tmp/carher-config-N.json (Docker) ← $include → /app/docker/carher-config.json (镜像内)
```

**警告**：gateway 进程会把 `$include` 展开并写回磁盘（`~/.openclaw/openclaw.json`）。如果发现本地 config 的 `$include` 消失、文件膨胀，说明被展开了。此时直接修改 base config 不会生效，需要直接改 `~/.openclaw/openclaw.json`。

### 关键配置项

| 配置                                       | 用途                                         | 注意                                  |
| ------------------------------------------ | -------------------------------------------- | ------------------------------------- |
| `plugins.deny: ["feishu"]`                 | 禁用上游 feishu 插件，避免与 feishu-her 冲突 | 新版本可能有 plugin-auto-enable 功能  |
| `gateway.controlUi.allowInsecureAuth`      | Docker Web UI 需要，本地 localhost 不需要    | 不要用 `dangerouslyDisableDeviceAuth` |
| `gateway.auth.mode` / `gateway.auth.token` | 各环境认证                                   | Docker 用固定 token，本地用本地 token |

## 升级后验证

### 本地 Her

1. 重启 `./start.sh`
2. 飞书发消息 → 确认收发正常
3. `/voice` → 确认语音链路
4. `localhost:18789` → 确认 Web UI（设备配对自动完成）

### Docker 容器

1. `./start-user.sh --id=N`（会自动检测镜像变化并重建）
2. 飞书发消息 → 确认收发
3. `/voice` → 确认语音
4. `localhost:290X1` → 确认 Web UI

### 检查清单

```
- [ ] pnpm patch 生效（grep prevKeptMessages 返回 3）
- [ ] pnpm build 通过
- [ ] pnpm check 通过
- [ ] pnpm test 通过
- [ ] 本地 Her 飞书消息收发
- [ ] 本地 Her 语音链路
- [ ] 本地 Her Web UI
- [ ] Docker 1 飞书消息收发
- [ ] Docker 1 语音链路
- [ ] Docker 3（董事长）飞书 + 语音
- [ ] Docker 4 Web UI
- [ ] 零 missing scope 错误
- [ ] 零 error/fatal/crash
```

## 本地对 upstream 的 patch 清单

升级前必须检查以下本地 patch 是否仍然需要。如果 upstream 已合并等效修复，则在 merge 时取 upstream 版本即可；如果 upstream 未修复，则 merge 后需要保留或重新应用这些改动。

### Patch 1: `src/memory/mmr.ts` — CJK 中文分词支持

- **Commit**: `95d45f2e7` (2026-02-19)
- **问题**: `tokenize()` 只处理 ASCII（`/[a-z0-9_]+/g`），导致 MMR 去重对中文内容完全失效
- **修改**: 增加 CJK 字符提取（U+4E00-9FFF, U+3400-4DBF）+ bigram 分词
- **升级时检查**: `git diff v2026.X.Y -- src/memory/mmr.ts`，看 upstream 是否改了 `tokenize()` 函数
- **如果 upstream 未修**: merge 后手动 cherry-pick 或重新应用以下 diff：

```diff
 export function tokenize(text: string): Set<string> {
-  const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
-  return new Set(tokens);
+  const lower = text.toLowerCase();
+  const ascii = lower.match(/[a-z0-9_]+/g) ?? [];
+  const cjkChars = Array.from(lower).filter((c) => /[\u4e00-\u9fff\u3400-\u4dbf]/.test(c));
+  const bigrams: string[] = [];
+  for (let i = 0; i < cjkChars.length - 1; i++) {
+    bigrams.push(cjkChars[i] + cjkChars[i + 1]);
+  }
+  return new Set([...ascii, ...bigrams, ...cjkChars]);
 }
```

### Patch 2: `src/memory/hybrid.test.ts` — BM25 rank-to-score 测试修正

- **Commit**: `95d45f2e7` (2026-02-19)
- **问题**: 测试用例假设 FTS5 rank 是正数，但 SQLite FTS5 的 `rank` 列返回负数（越负 = 越相关），导致 `bm25RankToScore` 测试错误
- **修改**: 测试用例改为使用负数 rank 值，与 `5fbbc7215` 中 `bm25RankToScore` 的修复一致
- **升级时检查**: `git diff v2026.X.Y -- src/memory/hybrid.test.ts`

### Patch 3: `src/memory/session-files.ts` — .reset 文件纳入索引（待实施）

- **状态**: 计划中，尚未实施
- **问题**: `listSessionFilesForAgent` 用 `.endsWith(".jsonl")` 排除了 `.reset` 归档文件，导致 `/new` 后旧 session 从搜索索引消失
- **影响**: 92 个 `.reset` 文件（37.9MB）未被索引，占总对话内容的 68%+
- **修改计划**: 放宽过滤条件，让 `.jsonl.reset.*` 也被列入
- **升级时**: 如果 upstream 修复了此问题则直接用 upstream 版本；否则需要在 merge 后应用本地 patch

### Patch 4: `@mariozechner/pi-coding-agent` compaction.js — keptMessages dead zone 修复（pnpm patch 管理）

- **来源**: 用户的 upstream PR [#1585](https://github.com/badlogic/pi-mono/pull/1585)
- **问题**: `prepareCompaction()` 中 `boundaryStart = prevCompactionIndex + 1` 跳过了上一轮 keptMessages，导致它们永远不会被 summarize，信息永久丢失（"dead zone" bug）
- **修改**: 新增 Phase 1 收集 `prevKeptMessages`（从 `firstKeptEntryId` 到 `prevCompactionIndex`），合并到 `messagesToSummarize`
- **管理方式**: `pnpm patch`，patch 文件在 `patches/@mariozechner__pi-coding-agent@0.54.0.patch`，`package.json` 的 `pnpm.patchedDependencies` 已注册
- **自动应用**: 每次 `pnpm install` 自动应用，无需手动操作
- **验证命令**: `grep -c 'prevKeptMessages' node_modules/@mariozechner/pi-coding-agent/dist/core/compaction/compaction.js` 应返回 `3`
- **MD5**: `64f05e55fe7370f22051f18e6c72df49`
- **升级时检查**: 如果 upstream npm 包版本升级（不再是 `0.54.0`），需要：
  1. 检查新版本是否已包含此修复（grep prevKeptMessages）
  2. 如已包含 → 删除 `patches/` 文件和 `pnpm.patchedDependencies` 条目
  3. 如未包含 → 重新生成 patch：`pnpm patch @mariozechner/pi-coding-agent@<新版本>`，拷入修复，`pnpm patch-commit`
- **历史教训**: 2026-02-22 升级时因 `pnpm install` 覆盖 node_modules 导致此 patch 丢失，当时只能从 Docker 4 容器拷回。现已通过 pnpm patch 彻底解决。

## 风险与回退

- **回退方式**：`git revert -m 1 <merge-commit>` 或 `git reset --hard <pre-merge-sha>`
- **最大风险**：upstream 改了 plugin SDK 接口 → feishu-her/realtime 编译不过 → 需要类型适配
- **中等风险**：upstream 改了 `dist/` 结构 → realtime core-bridge 加载失败 → 更新 import 路径
- **低风险**：格式/lint 规则变化 → `pnpm format` 自动修复
