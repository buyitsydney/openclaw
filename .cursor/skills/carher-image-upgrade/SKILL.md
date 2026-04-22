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

## Her 可读 openclaw upstream src（架构扩展，2026-04-22 加入）

A+B 解耦后，官方 runtime image **只 ship `/app/dist/*.js`（minify + hash chunk，几乎不可读），不 ship `/app/src/`**。Her 要 debug openclaw core（auto-reply、compaction 等）时没有源码可查，debug 能力相对 native 架构退化。

**补救**：Dockerfile.carher.v2 多加一个 builder stage，从 GitHub clone 对应 tag 的 openclaw 源码，只 COPY `src/` 进最终镜像（+58MB），放在 `/app/openclaw-src/src/` 只读位置。

### Dockerfile 片段（`FROM ghcr.io/openclaw/...` 之前）

**为什么用 openclaw 官方 image 做 fetcher**：docker.io（含 `alpine/git`）在大陆常常 TLS 握手超时，S1 上还遇到过 `x509: certificate is valid for *.extern.facebook.com, not registry-1.docker.io` 的劫持证书。ghcr.io 稳定可达，且 openclaw image 自带 `git 2.39.5`，直接复用最省事，不引入新依赖。

```dockerfile
# Her 可读的 upstream src（只读、不参与 runtime）
# 用 openclaw 官方 image 本身作 builder —— 它已经装了 git 2.39，省掉 docker.io 依赖
# （docker.io 在大陆常有 TLS 握手超时，ghcr.io 稳定可达）
# 3 层 fallback: v 前缀 → bare → 空目录（GitHub 挂了不阻塞 build）
FROM ghcr.io/openclaw/openclaw:${OPENCLAW_TAG} AS openclaw-src-fetcher
ARG OPENCLAW_TAG
USER root
RUN set -e; \
    (git clone --depth=1 --branch v${OPENCLAW_TAG} \
        https://github.com/openclaw/openclaw.git /src 2>/dev/null \
     || git clone --depth=1 --branch ${OPENCLAW_TAG} \
        https://github.com/openclaw/openclaw.git /src 2>/dev/null \
     || mkdir -p /src/src); \
    echo "openclaw-src-fetcher: $(ls /src/src 2>/dev/null | wc -l) entries in /src/src"
```

主 stage 末尾：

```dockerfile
COPY --from=openclaw-src-fetcher /src/src /app/openclaw-src/src
```

### Tag 格式注意

openclaw 官方 **git tag = `v${OPENCLAW_TAG}`**（有 `v` 前缀，实测 `v2026.3.12` / `v2026.4.14` / `v2026.4.20`），**docker tag = `${OPENCLAW_TAG}`**（无前缀）。Dockerfile 里先试 `v` 主路径，再试 bare 兼容，最后空目录兜底。

### 实测（2026-04-22）

| 环境               | `ls-remote` | shallow clone v2026.4.20         | 仓库总大小 | `src/` 大小 |
| ------------------ | ----------- | -------------------------------- | ---------- | ----------- |
| 本地 Mac           | 5.7s        | 64s（fetcher 用 openclaw image） | 198MB      | 58MB        |
| S1（10.68.13.186） | 0.9s        | **12.8s**                        | 142MB      | 59MB        |

本地 Mac clone 较慢是因为 fetcher 复用的是已 pull 好的 openclaw image（阿里云镜像也会重新装 git 索引），跟 docker.io 的不可达无关；S1 因为 git proxy 更快。最终 image `/app/openclaw-src/src` 含 **6745 个 `.ts` 文件**，Her 可直接 grep。

### Her 使用姿势

```bash
# 查 upstream core 逻辑（注意路径不是 /app/src 而是 /app/openclaw-src/src）
grep -r 'shouldReplyToUser' /app/openclaw-src/src/
grep -r 'compaction' /app/openclaw-src/src/auto-reply/

# B 侧插件源码路径不变
grep -r 'WSClient' /app/docker/plugins/feishu-her/src/
```

### 设计哲学

A 侧（openclaw）源码 **只读可查阅**，**不参与 runtime**（runtime 始终走 `/app/dist/*.js`）。改 A 侧必须回 openclaw 官方提 PR，**不在 CarHer 容器内直接改** —— 那样会破坏 A+B 解耦，升级时必丢失。

### GitHub 挂了怎么办

3 层 fallback 最后会 `mkdir -p /src/src` 兜底，build 不失败，但 `/app/openclaw-src/src` 将是空目录。Her 提示空目录时，告诉用户"build 时 GitHub 不可达，升级完后可用 `docker cp <host>/openclaw-src/. <container>:/app/openclaw-src/` 手动补"。

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

---

## 兼容性两道 Gate(必须全过才能 docker build)

这两道 gate 在 **docker build 之前/期间**拦住已知 SDK drift。
编译期零误报的 preflight 已砍掉 —— 实测维护成本太高,真的 drift 还是 verify Gate 6/10 运行期抓最可靠。

### Gate 1: `peerDependencies` 范围保险

两个 plugin 的 `package.json` 都声明了:

```json
"peerDependencies": {
  "openclaw": ">=2026.1.26 <2026.5.0"
}
```

这是 **npm install 期的保险**。如果 base image 里 openclaw 版本超出该范围,`docker build` 会因 `npm install` ERESOLVE 失败,直接拦住跨代升级。

**跨上界(比如升到 2026.5.x)时**:

- 先手动在新版 base image 里跑 `docker run --rm ghcr.io/openclaw/openclaw:<新tag> sh -c "cd /app && node -e 'require(\"openclaw/plugin-sdk\")'"` 冒一下烟
- 真的兼容就把上界放宽到 `<2026.6.0`,否则停在旧版保护用户
- 改 plugin 的 `package.json` 版本也记得同步 plugin 自身的 semver

### Gate 2: 查 drift-fix patch 库

```bash
ls patches/drift-fix/feishu-her-v2026.X.Y*.patch 2>/dev/null
ls patches/drift-fix/a2a-gateway-v2026.X.Y*.patch 2>/dev/null
```

- 有文件 = 这个版本有已知漂移,Dockerfile build 会应用 patch
- 无文件 = 没有已知漂移,直接 build;真踩到未知漂移会被 `carher-verify.sh` Gate 6(plugin validation)或 Gate 10(fatal)抓到

## 升级执行 — 4 条命令

```bash
# 1. 改 Dockerfile.carher.v2 第 9 行
#    ARG OPENCLAW_TAG=2026.X.OLD  →  ARG OPENCLAW_TAG=2026.X.NEW

# 2. 构建新镜像(起独立 tag,永远不覆盖旧的)
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<MMDD>-ab-v2 .
#    BuildKit 必须开(cache mount 依赖)。npm 包命中 cache 后升级降到 30-60s

# 3. 停旧容器 + 用新 tag 起(canary 先切 102)
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./start-user.sh --id=102 --image=carher-core:<MMDD>-ab-v2

# 4. 自动自检(10 gate)— 失败立刻回滚
scripts/carher-verify.sh --id=102 --wait=60
#    exit 0 = 全过  /  exit 3 = 有 FAIL,按提示回滚
```

### 预期时间成本

| 步骤                     | 冷(首次新 base tag)                 | 热(same base,改 plugin) |
| ------------------------ | ----------------------------------- | ----------------------- |
| `docker pull` 新 base    | 30s-5min                            | 0s                      |
| `docker build`           | **~30 min**(2026-04-20 实测 34m26s) | 3-5 min                 |
| `docker rm + start-user` | ~90s                                | ~90s                    |
| Gateway ready            | ~25-30s                             | ~25-30s                 |
| `carher-verify.sh`       | 0-2s(gateway 已 ready)              | 0-2s                    |
| **总停机**(不含 build)   | **~90s + 25s ≈ 2 min**              | **~90s + 25s ≈ 2 min**  |

**重要更正(2026-04-20 演练后)**:冷 build 实测 **~30min**,不是旧版 skill 估的 3-5min。
原因:base tag 变 → FROM 层失效 → apt/pip/npm/COPY 全部重跑。`--mount=type=cache,target=/root/.npm`
只救 npm 包下载段(30s),apt 系仍全量。规划时间时按 **30min** 准备。

注:build 时间 ≠ 停机时间。新 image 后台构建,`docker rm -f` 那一刻才开始停机。

## 升级后 — 自动自检(10 gate,脚本化)

```bash
scripts/carher-verify.sh --id=102 --wait=60
```

10 个 gate,全过退出码 0,任一失败退出码 3 并打印建议回滚命令。

### 10 个 Gate 一览

| #   | Gate                | 关键日志/检查                                        | 失败含义                                                                             |
| --- | ------------------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 1   | gateway ready       | `[gateway] ready (N plugins...)`                     | 容器没起来,升级彻底失败                                                              |
| 2   | plugin 数量         | `N plugins` 中 N ≥ 7                                 | A+B 架构缺插件(a2a/acpx/device-pair/feishu-her/memory-wiki/phone-control/talk-voice) |
| 3   | feishu WSClient     | `[feishu] WSClient connected`                        | tenant_access_token 失效或 appId/botOpenId 错                                        |
| 4   | A2A peers           | `refreshRegistryPeers found N peers`,N>0             | Redis 连不上或 A2A 没启用(警告,非失败)                                               |
| 5   | acpx runtime        | `embedded acpx runtime backend ready`                | ACP 未启用或冷启动还没完(警告)                                                       |
| 6   | 无 plugin 契约错误  | 无 `plugin validation/schema failed`                 | **SDK drift 运行时暴露** — 立刻回滚 + 补 drift-fix patch                             |
| 7   | bundled feishu 清理 | `/app/{extensions,dist,dist-runtime}/feishu/` 不存在 | Dockerfile rm -rf 不全,官方挪了目录                                                  |
| 8   | a2a-gateway ioredis | `node_modules/ioredis/package.json` 存在             | npm install 失败被忽略,peers 会为 0                                                  |
| 9   | feishu-her 依赖     | `node_modules/@larksuiteoapi` 存在                   | feishu 连不上                                                                        |
| 10  | 无严重运行时错误    | 无 `FATAL/uncaughtException/crash`                   | 运行期炸了,立刻回滚                                                                  |

### 脚本返回码

- `0` — 全部通过,可以继续推广
- `3` — 有 FAIL,建议立即回滚(脚本会打印回滚命令)
- `2` — 容器不存在或未运行

### 真人验收(10 gate 之外,必做)

挂 monitor 盯 `deliver:` 事件后,请真人(102 是 tester2)在飞书私聊发一句:

```
你好。检查下 A2A 和 ACP 状态？
```

期望:

- 飞书看到回复
- 日志出现 `deliver: kind=final hasText=true`
- bot 回复里应包含 `A2A ✅` 和 `ACP` 两个关键词(bot 自检)

### Monitor 模板(Claude 的 Monitor 工具)

```bash
docker logs -f --since=1s carher-102 2>&1 | grep --line-buffered -E \
  "(deliver:|gateway\] ready|WSClient connected|acpx runtime backend ready|refreshRegistryPeers found|Error|FAILED|exception|plugin (validation|schema))"
```

## 回滚 — 同大版本换 tag,不 checkout

```bash
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./start-user.sh --id=102 --image=carher-core:<旧日期>-ab-v2
```

**旧 image 要保留**。每次升级产出的 tag 至少保留 30 天,不要 `docker rmi` 清。

**回滚比升级快** — 镜像已在本地,省掉 build 和 pull,~60-70s 搞定。

### ⚠️ 跨 schema 版本回滚(4.x → 3.x 这类)不无缝

2026-04-20 演练发现:直接把 102 从 4.x 回到 2026.3.12,容器 restart loop:

```
Invalid config at /data/.openclaw/openclaw.json:
- agents.defaults: Unrecognized key: "llm"
- messages.tts: Unrecognized key: "providers"
```

**根因**:`docker/shared-config.json5` 写了 4.x 才引入的 schema 键,3.x 的 strict schema 不认。

**回滚流程**(跨 schema 时):

```bash
# 1) 先注释掉 shared-config.json5 里 4.x-only 的 key
#    agents.defaults.llm、messages.tts.providers、其他由 openclaw doctor 列出
# 2) 清掉持久 config
docker rm -f carher-102
docker run --rm -v carher-102-data:/data alpine rm -f /data/openclaw.json
# 3) 再起旧 image
CARHER_ACP_ENABLED=1 ./start-user.sh --id=102 --image=carher-core:<老 tag>
```

**经验法则**:同大版本(4.x 之间)来回换无脑 swap 即可。跨代的回滚按上面流程。

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

**纵深防御(2026-04-20 后)**:

1. **包管理器期**:`peerDependencies: ">=2026.1.26 <2026.5.0"` 拦跨代(Gate 1)
2. **构建期**:`patches/drift-fix/` 应用已知漂移 patch(Gate 2)
3. **启动期**:`carher-verify.sh` 的 Gate 6 查 `plugin validation/schema` 错误
4. **运行期**:canary 真人消息

出现下面 stack trace 立刻回滚,并**补 drift-fix patch**:

- `TypeError: xxx.yyy is not a function` 来自 `@openclaw/` 任何包
- `manifest validation failed`
- `schema: additionalProperties not allowed`
- `Cannot find module 'openclaw/plugin-sdk/<某符号>'`

历史常见漂移参考 `patches/drift-fix/README.md` 的"已知漂移清单"。

### 踩坑 5：本地 worktree push 被 pre-push hook 挡住

hook 要跑 build + test，worktree 没 node_modules。解决：

```bash
pnpm install   # 一次性，后续 push 都通
```

或（用户授权时）`git push --no-verify`。

### 踩坑 6：`build-image.sh` 是旧 v1 架构

`build-image.sh` 用的是旧 `Dockerfile.carher`（单一镜像 monorepo 编译），**不是 A+B**，不支持 `--build-arg OPENCLAW_TAG`。A+B 升级必须走 raw `docker build -f Dockerfile.carher.v2`，**不要用 `build-image.sh`**。（未来可能让 `build-image.sh` 加 `--v2` flag 自动转发，目前还没做。）

### 踩坑 7：`openclaw-src-fetcher` stage clone 失败

3 层 fallback 兜底后 `/app/openclaw-src/src` 可能是空目录。Her 自查：

```bash
docker exec carher-<id> ls /app/openclaw-src/src | head -5
# 正常: abort-cutoff.ts  abort-primitives.ts  abort.runtime.ts ... (6745 个 .ts)
# 异常: 空 → GitHub 在 build 时不可达，按上面"GitHub 挂了怎么办"手动补
```

## Worktree + Branch 注意

- 这套架构文件活在 **`feat/carher-a-b-decouple` 分支**（worktree `.claude/worktrees/carher-ab-decouple/`）
- 未合入 `main`/`dev`。合入前升级操作都要在 worktree 里做
- 远程推到 `carher/feat/carher-a-b-decouple`（不是 `origin`，因为个人账号没有 openclaw push 权）

## 与旧 skill 的关系

- **旧 skill `upgrade-upstream`**：`git merge v2026.X.Y --no-edit` 把 upstream 代码合进来 → 全量重编译。**已弃用**。
- **本 skill `carher-image-upgrade`**：只改 Dockerfile ARG，用官方编好的镜像。**当前推荐**。

如果用户问"如何升级 OpenClaw"，默认走本 skill。只有在 **真的需要改 OpenClaw core 代码**（我们给 upstream 提 PR 前的本地验证）时才回退到 `upgrade-upstream`。

## 历史演练记录

- **2026-04-20**:0414 → 0415 → 回滚 0414 全链路实测通过(102 canary)
  - 升级停机 ~113s,回滚停机 ~68s
  - 7 plugins 全绿,A2A 3 peers,ACP 派发成功
  - 真人验收:飞书私聊 "A2A ✅ 在线,ACP 任务已派发" 返回正常
- **2026-04-20 晚**: 加纵深防御(peerDependencies 上界 + drift-fix 库 + verify 10 gate + npm cache mount)
  - `scripts/carher-verify.sh` — 升级后 10 gate 自动自检(SIGPIPE fix 后 10/10 PASS 实测)
  - `patches/drift-fix/` — 每版本已知漂移 patch 库
  - Dockerfile 加 npm cache mount → 预期 build 时间 14min → 3-5min
  - 编译期 preflight 尝试后砍掉 —— 复现 plugin tsc 环境复杂度过高,真 drift verify Gate 6/10 抓更可靠
- **2026-04-21 夜间演练**(生产级 playbook 定稿,详见 `UPGRADE_DRILL_REPORT.md`):
  - **冷 build 实测 ~30min**(34m26s),比原估 3-5min 长 10 倍 — 原因:FROM 变动下游层全部失效,npm cache mount 只救 npm 段
  - **跨 schema 回滚不无缝**:4.x → 3.12 restart loop,因 `shared-config.json5` 有 4.x-only key(`agents.defaults.llm`、`messages.tts.providers`)。同大版本回滚仍秒级
  - 热 swap(0414 → 0415,image 已 build)实测 90s + verify 0s + 10/10 绿
  - 产出:`UPGRADE_DRILL_REPORT.md` 含全量推广脚本、紧急回滚脚本、时间预算
- **2026-04-22 架构补强**:加 `openclaw-src-fetcher` stage,让 Her 在容器里能读 upstream src(填补 A 侧黑盒 debug 缺口)
  - shallow clone v2026.4.20 本地 40s / S1 13s,镜像膨胀 +58MB
  - 3 层 fallback: `v${TAG}` → `${TAG}` → 空目录,GitHub 挂了不阻塞 build
  - 路径: `/app/openclaw-src/src/`(只读,不影响 runtime — runtime 走 `/app/dist/`)
