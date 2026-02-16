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

## 风险与回退

- **回退方式**：`git revert -m 1 <merge-commit>` 或 `git reset --hard <pre-merge-sha>`
- **最大风险**：upstream 改了 plugin SDK 接口 → feishu-her/realtime 编译不过 → 需要类型适配
- **中等风险**：upstream 改了 `dist/` 结构 → realtime core-bridge 加载失败 → 更新 import 路径
- **低风险**：格式/lint 规则变化 → `pnpm format` 自动修复
