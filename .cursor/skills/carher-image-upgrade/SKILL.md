---
name: carher-image-upgrade
description: CarHer A+B 架构下升级 OpenClaw 到新版本（只改 base image tag，不合 git、不编译）。Use when the user asks to upgrade carher, 升级 openclaw, 升级到 xxxx.x.xx 版本, 跟官方发版, 换 base, 换 FROM tag, 回滚 carher-core, 换镜像 tag. 不要和 `upgrade-upstream` 混淆——那是旧的 git merge upstream 流程，已被本流程取代。
---

# CarHer A+B 架构升级流程（权威版）

> **原则一句话**：升级 = 改 `Dockerfile.carher.v2` 里 1 个字符串 + `docker build` + 换 image tag。**不 git pull、不 pnpm install、不编译**。

## 架构前置（必读一遍就会）

CarHer 运行镜像 = **官方 OpenClaw base 镜像** + **自家 CarHer 插件层**，两者独立：

```
carher-core:<TAG>-ab-v2
└── FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG}   ← 轴 1，官方每周发版
    + docker/plugins/feishu-her/                      ← 轴 2，自家 fork
    + docker/plugins/a2a-gateway/                     ← 轴 3，自家插件
```

完整架构见 [`docs/her/her-image-architecture.md`](../../docs/her/her-image-architecture.md)。

## 升级前 — 检查清单

### 1. 查官方发了哪些新 tag

```bash
# 方法 A: GitHub Packages 页面（浏览器）
open https://github.com/openclaw/openclaw/pkgs/container/openclaw/versions

# 方法 B: GitHub Releases
gh release list --repo openclaw/openclaw --limit 10

# 方法 C: ghcr.io API (要 token，通常 A/B 就够)
```

### 2. 读 Release Notes，看有没有 breaking change

重点看：

- **Plugin SDK 变动**（`openclaw.plugin.json` manifest schema / `src/plugin-sdk/*` 接口）
- **Channel contract 变动**（我们的 `feishu-her` 是 channel 插件）
- **Bundled plugin 列表变动**（特别是 `feishu` 这个——我们有同名冲突，Dockerfile 手动清掉了 3 处残留）

```bash
gh release view v2026.X.Y --repo openclaw/openclaw
```

出现下面这些关键词就要**特别小心**：

- `BREAKING`, `plugin schema`, `manifest validation`, `channel contract`, `feishu`, `provider SDK`

### 3. 把新 base image 拉到本地（预热）

```bash
docker pull ghcr.io/openclaw/openclaw:2026.X.Y
```

拉不到（manifest unknown）= 官方还没发 / 你打错 tag。**不要自己编**。

### 4. 确认当前在正确的 worktree

```bash
pwd   # 应是 .claude/worktrees/carher-ab-decouple 或主仓
git branch --show-current
```

架构文件只在 `feat/carher-a-b-decouple` 分支（已 push 到 `carher` remote）。

## 升级执行 — 4 条命令

```bash
# 1. 改 Dockerfile.carher.v2 第 9 行
#    ARG OPENCLAW_TAG=2026.X.OLD  →  ARG OPENCLAW_TAG=2026.X.NEW

# 2. 构建新镜像（起独立 tag，永远不覆盖旧的）
docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<MMDD>-ab-v2 .

# 3. 停旧容器 + 用新 tag 起（canary 先切 102）
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./start-user.sh --id=102 --image=carher-core:<MMDD>-ab-v2

# 4. 等 gateway ready（~25-30s）再验证
docker logs carher-102 2>&1 | grep -E "gateway\] ready|WSClient connected|acpx runtime backend ready|refreshRegistryPeers found"
```

### 预期时间成本

| 步骤                     | 冷（首次官方 tag）               | 热（镜像已在本地） |
| ------------------------ | -------------------------------- | ------------------ |
| `docker pull`            | 30s - 5min                       | 0s                 |
| `docker build`           | 10-14 min（base 变，缓存全失效） | < 10s              |
| `docker rm + start-user` | 40-90s                           | 40-90s             |
| Gateway ready            | ~25-30s                          | ~25-30s            |
| **总停机**               | ~1-2 min                         | ~1-2 min           |

注：Dockerfile 当前**没加** `--mount=type=cache,target=/root/.npm`，加上之后 build 耗时可降到 3-5 min。属下一轮优化。

## 升级后 — 必须全过的 5 个验证点

```bash
docker logs carher-102 2>&1 | tail -100
```

### 日志层（看 docker logs）

```
✅ [gateway] ready (7 plugins: a2a-gateway, acpx, device-pair,
                    feishu-her, memory-wiki, phone-control, talk-voice; ~25s)
✅ [feishu] [default] Feishu WSClient connected
✅ [plugins] a2a-gateway: refreshRegistryPeers found 3 peers
✅ [plugins] embedded acpx runtime backend ready
```

任一缺失或变成 `error/failed/exception` 都是**回滚信号**。特别警惕：

- `plugin validation failed` / `schema mismatch` — Plugin SDK 漂移
- `channel config rejected` — Channel contract 变了
- bundled feishu 冒出来 — 官方挪了目录，得更新 `rm -rf` 清理位置

### 用户层（真人验收）

挂 monitor 盯 `deliver:` 事件后，请真人（102 是 tester2）在飞书私聊发一句：

```
你好。检查下 A2A 和 ACP 状态？
```

期望：

- 飞书看到回复
- 日志出现 `deliver: kind=final hasText=true`
- bot 回复里应包含 `A2A ✅` 和 `ACP` 两个关键词（bot 自检）

### Monitor 模板（Claude 的 Monitor 工具）

```bash
docker logs -f --since=1s carher-102 2>&1 | grep --line-buffered -E \
  "(deliver:|gateway\] ready|WSClient connected|acpx runtime backend ready|refreshRegistryPeers found|Error|FAILED|exception|plugin (validation|schema))"
```

## 回滚 — 只换 tag，不 checkout

```bash
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./start-user.sh --id=102 --image=carher-core:<旧日期>-ab-v2
```

**旧 image 要保留**。每次升级产出的 tag 至少保留 30 天，不要 `docker rmi` 清。

**回滚比升级快** — 镜像已在本地，省掉 build 和 pull，~60-70s 搞定。

## 全量推广（canary 102 → 全 200 用户）

**必须做完上面 5 个验证**，至少让 102 稳定跑 **24 小时**再推广。

```bash
# 滚动升级，每个用户停机 ~60s
for i in $(seq 1 200); do
  docker rm -f carher-$i
  CARHER_ACP_ENABLED=1 ./start-user.sh --id=$i --image=carher-core:<MMDD>-ab-v2
  sleep 10
  # 健康检查：等 gateway ready 再进下一个
  until docker logs carher-$i 2>&1 | grep -q "gateway] ready"; do sleep 3; done
done
```

**铁律**：重建任何容器前，先看最近 15 分钟有没有消息交互：

```bash
docker logs carher-N --since=15m 2>&1 | grep -c "deliver:"
# > 0 就等用户静默再重建
```

## 常见踩坑

### 踩坑 1：build 成功但容器启动后 feishu 插件没起来

检查官方镜像里 bundled feishu 残留是否全清：

```bash
docker run --rm carher-core:<tag> ls /app/extensions/ /app/dist/extensions/ /app/dist-runtime/extensions/ | grep feishu
```

应**无输出**。有输出说明官方挪了路径，得更新 Dockerfile.carher.v2 第 40 行的 `rm -rf` 列表。

### 踩坑 2：`gateway ready` 后 A2A peers=0

a2a-gateway 的 `ioredis` 依赖不在 `package.json`，或 npm install 失败被忽略。检查：

```bash
docker run --rm carher-core:<tag> ls /app/docker/plugins/a2a-gateway/node_modules/ioredis/
# 应有 built/package.json 等
```

### 踩坑 3：ACP 首次回复要 2-3 分钟（看起来像卡死）

ACP 首次冷启动要 `npx -y @agentclientprotocol/claude-agent-acp` 下载包。**不是卡死**，耐心等。
确认方法：

```bash
docker exec carher-102 ps auxf | grep claude-agent-acp
```

看到进程 = 正在启动；没看到 = 真有问题。

### 踩坑 4：plugin 契约变了，feishu-her 运行时炸

**当前防御**：只有运行时 smoke（canary 真人消息）。**没有编译期/启动期的契约检查**。

出现下面 stack trace 立刻回滚：

- `TypeError: xxx.yyy is not a function` 来自 `@openclaw/` 任何包
- `manifest validation failed`
- `schema: additionalProperties not allowed`

同时开 issue 跟踪：是我们 fork 的插件要适配，还是官方 regression。

### 踩坑 5：本地 worktree push 被 pre-push hook 挡住

hook 要跑 build + test，worktree 没 node_modules。解决：

```bash
pnpm install   # 一次性，后续 push 都通
```

或（用户授权时）`git push --no-verify`。

## Worktree + Branch 注意

- 这套架构文件活在 **`feat/carher-a-b-decouple` 分支**（worktree `.claude/worktrees/carher-ab-decouple/`）
- 未合入 `main`/`dev`。合入前升级操作都要在 worktree 里做
- 远程推到 `carher/feat/carher-a-b-decouple`（不是 `origin`，因为个人账号没有 openclaw push 权）

## 与旧 skill 的关系

- **旧 skill `upgrade-upstream`**：`git merge v2026.X.Y --no-edit` 把 upstream 代码合进来 → 全量重编译。**已弃用**。
- **本 skill `carher-image-upgrade`**：只改 Dockerfile ARG，用官方编好的镜像。**当前推荐**。

如果用户问"如何升级 OpenClaw"，默认走本 skill。只有在 **真的需要改 OpenClaw core 代码**（我们给 upstream 提 PR 前的本地验证）时才回退到 `upgrade-upstream`。

## 历史演练记录

- **2026-04-20**：0414 → 0415 → 回滚 0414 全链路实测通过（102 canary）
  - 升级停机 ~113s，回滚停机 ~68s
  - 7 plugins 全绿，A2A 3 peers，ACP 派发成功
  - 真人验收：飞书私聊 "A2A ✅ 在线，ACP 任务已派发" 返回正常
