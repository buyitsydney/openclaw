# CarHer 三产品线并行架构设计

**状态**：设计定稿草案  
**日期**：2026-05-11  
**适用范围**：CarHer OpenClaw 线、Hermes 线、Dual 热切换线的长期开发、发布、回滚和补丁治理。

---

## 1. 背景

CarHer 目前已经不是“官方 OpenClaw + 一个飞书插件”这么简单。为了把旧 `feishu-her` 的用户体验迁移到新架构，OpenClaw 侧和 Hermes 侧都积累了一批明确的兼容补丁、运行时插件和端到端验证脚本。

这些补丁覆盖了真实用户体验的关键路径：

- 飞书群聊命令解析，例如 `/new @bot`、`@bot /new`、多 bot mention 场景。
- 群聊上下文注入，要求 context 中看到的 history 与 `lark-cli` 拉到的飞书真实消息尽量 1:1。
- interactive card 展开，不能把卡片退化成“请升级至最新版本客户端，以查看内容”。
- knownBots / bot registry，把 `cli_xxx` app sender 渲染成“弋天的her / 林森的her”等可读身份。
- 回复统一使用美观的 Feishu card，减少连续碎片化 post。
- footer 信息密度对齐旧 Her 体验。
- cron/direct outbound 也走 card 输出。
- A2A hub/spoke、跨机路由和 peer discovery。
- memory search/session decay 等运行时行为修复。
- Hermes 侧的 Feishu card、footer、model shortcut、lark-cli user token、Knowledge QA、A2A bridge 等体验补齐。

因此，新架构必须把这些 patch 当成**一等发布资产**，不能继续依赖“某台服务器上刚好 git pull 过”“某个 bind mount 目录刚好是最新”的隐式状态。

---

## 2. 三条产品线

CarHer 后续应拆成三条产品线，而不是一个巨型镜像承载所有用户。

| 产品线      | 工程名            | 目标用户                                         | 运行形态                                        | 发布节奏                     |
| ----------- | ----------------- | ------------------------------------------------ | ----------------------------------------------- | ---------------------------- |
| OpenClaw 线 | `carher-openclaw` | fleet 主流用户                                   | OpenClaw + CarHer OpenClaw plugins/patches      | 跟随 OpenClaw 上游，稳定优先 |
| Hermes 线   | `carher-hermes`   | Hermes 早期用户和实验用户                        | Hermes + CarHer Feishu UX patches/tools/skills  | 跟随 Hermes 上游，实验到稳定 |
| Dual 线     | `carher-dual`     | 需要 `/hermes` / `/openclaw` 热切换的 power user | OpenClaw artifact + Hermes artifact + dual glue | 任一基础线升级后显式组合验证 |

### 命名约定

- `carher-openclaw` 是现有 OpenClaw 工程和 fleet 运行线。
- `carher-hermes` 是当前 `hermestest` 工程成熟后的正式名称。
- `carher-dual` 是二合一组合工程，只负责热切换和兼容性验证，不复制两边业务代码。

---

## 3. 核心原则

### 3.1 独立演进，不自动互相影响

三条线可以自由向前走，但不能互相暗中影响：

```text
carher-openclaw 发布新版本
  不自动影响 carher-hermes
  不自动影响 carher-dual

carher-hermes 发布新版本
  不自动影响 carher-openclaw
  不自动影响 carher-dual

carher-dual 只有更新 release manifest 后
  才显式采用某个 OpenClaw 版本和某个 Hermes 版本
```

绝对的“0 耦合”在产品层面不成立，因为 `carher-dual` 天然由另外两条线组合而成。但可以做到：

- 源码不互相 import。
- 基础产品线不互相依赖。
- 运行故障不跨产品线传播。
- Dual 的耦合全部写在 release manifest 和 compatibility matrix 中。

### 3.2 Patch 是发布资产，不是服务器副作用

当前 OpenClaw 侧的关键 patch 包括：

```text
scripts/carher-patches/apply-command-body-normalize.sh
scripts/carher-patches/apply-history-fill.sh
scripts/carher-patches/apply-history-fill-dm.sh
scripts/carher-patches/apply-inbound-history-meta.sh
scripts/carher-patches/apply-reply-card-default.sh
scripts/carher-patches/apply-outbound-card-default.sh
scripts/carher-patches/apply-footer-status.sh
scripts/carher-patches/apply-session-decay.sh
scripts/carher-patches/history-fill-helper.js
```

当前 OpenClaw 侧的关键插件包括：

```text
docker/plugins/feishu-her
docker/plugins/a2a-gateway
docker/plugins/shadow-daemon
docker/plugins/her-antitalker-poc
```

Dual 额外需要：

```text
carher-engine-swap
hermestest-entrypoint-dual.sh
/data/.engine/active
dual lark-cli token-store sync
```

这些都必须被版本化、打包、测试和记录。生产路径不能出现：

```text
no carher-patches dir bind-mounted; running openclaw stock
```

一旦出现这类日志，就表示 CarHer 体验退回裸官方 OpenClaw，属于发布事故。

### 3.3 消灭 `@latest`

生产发布必须 pin：

- OpenClaw npm/image version。
- `@larksuite/openclaw-lark` npm version。
- CarHer OpenClaw patch/plugin revision。
- Hermes revision。
- Dual glue revision。

闭源或外部依赖尤其不能使用 `@latest`，否则无法复现昨晚已验证的行为。

---

## 4. 工程职责

### 4.1 `carher-openclaw`

职责：

- 维护主流 fleet 的 `carher-openclaw` image。
- 跟随 OpenClaw 上游发版。
- 维护 OpenClaw 侧 CarHer plugins：
  - `feishu-her`
  - `a2a-gateway`
  - `shadow-daemon`
  - `her-antitalker-poc`
- 维护 OpenClaw 侧 runtime patch bundle：
  - openclaw-lark command normalize。
  - group/DM history fill。
  - inbound history metadata。
  - card default / outbound card default。
  - compact footer。
  - session decay / memory search 修复。
- 维护 fleet config、compose、A2A registry、knownBots、skills 分发。

不负责：

- Hermes runtime。
- `/hermes` / `/openclaw` 热切换。
- Hermes state、Hermes patch 和 Hermes release cadence。

### 4.2 `carher-hermes`

职责：

- 维护纯 Hermes 运行线。
- 复刻 Her 的飞书用户体验：
  - card 输出。
  - compact footer。
  - Markdown table 到 Feishu native table。
  - cron/direct outbound 样式。
  - model shortcut。
  - lark-cli tools/skills。
  - user-token Knowledge QA。
  - A2A bridge。
- 维护 Hermes 侧 patch scripts 和端到端 Feishu 测试。

不负责：

- OpenClaw core 升级。
- OpenClaw 插件加载。
- OpenClaw memory/session 格式兼容。

### 4.3 `carher-dual`

职责：

- 组合某个 `carher-openclaw` artifact 和某个 `carher-hermes` artifact。
- 提供 dual entrypoint。
- 维护 `/data/.engine/active` 状态机。
- 提供 `/hermes` 和 `/openclaw` owner-only 热切换命令。
- 保证同一时间只有一个 Feishu websocket engine 活跃。
- 维护 OpenClaw/Hermes 双 HOME 的 lark-cli token-store 同步。
- 跑 compatibility matrix 和 S1 灰度测试。
- 提供 rollback playbook。

不负责：

- 在 dual repo 内复制 OpenClaw 或 Hermes 的业务代码。
- 自动吃两边最新 dev。
- 修改纯 OpenClaw 用户或纯 Hermes 用户的运行路径。

---

## 5. Release Manifest

`carher-dual` 必须通过 manifest 显式组合版本：

```yaml
product: carher-dual
tag: oc-2026.5.3-p14+hm-0.13.0-r4+d0.1.0

openclaw:
  image: carher-openclaw:2026.5.3-p14
  openclaw_npm: 2026.5.3
  openclaw_lark_npm: 1.2.3
  carher_patch_bundle: carher-openclaw-patches:2026.5.3-p14
  git_ref: <carher-openclaw commit sha>

hermes:
  image: carher-hermes:0.13.0-r4
  hermes_version: 0.13.0
  carher_patch_bundle: carher-hermes-patches:0.13.0-r4
  git_ref: <carher-hermes commit sha>

dual:
  glue_version: 0.1.0
  git_ref: <carher-dual commit sha>
```

规则：

- Dual 不跟随任何一边的 `dev` 自动漂移。
- 任一基础线升级后，必须生成新 manifest、新 tag、新 E2E 结果。
- Manifest 是发布、回滚和事故定位的唯一真相。

---

## 6. Build Info / SBOM

每个 image 必须写入 build info：

```json
{
  "product": "carher-dual",
  "image": "carher-dual:oc-2026.5.3-p14+hm-0.13.0-r4+d0.1.0",
  "openclaw_npm": "2026.5.3",
  "openclaw_lark_npm": "1.2.3",
  "carher_openclaw_ref": "<sha>",
  "carher_openclaw_patch_bundle": "2026.5.3-p14",
  "hermes_version": "0.13.0",
  "carher_hermes_ref": "<sha>",
  "dual_ref": "<sha>",
  "build_at": "2026-05-11T08:00:00Z"
}
```

建议同时写入：

```text
/etc/carher-release.json
Docker image labels
container startup log first screen
```

生产事故第一步必须能通过：

```bash
docker exec <container> cat /etc/carher-release.json
```

直接知道当前到底跑的是哪组组合，而不是从服务器 git 状态猜。

---

## 7. Compatibility Matrix

Dual 不是无限 N x M 测试矩阵，而是显式支持矩阵：

| 组合                    | 目的       | 必须验证   |
| ----------------------- | ---------- | ---------- |
| current stable tuple    | 当前生产   | 全量 gate  |
| next canary tuple       | 下一版灰度 | 全量 gate  |
| previous rollback tuple | 快速回滚   | smoke gate |

每个 tuple 至少验证：

- OpenClaw mode 私聊和群聊。
- Hermes mode 私聊和群聊。
- `/hermes` 切换。
- `/openclaw` 切换。
- 切换后的 history continuity。
- group history 1:1 注入。
- interactive card 展开。
- knownBots 渲染。
- `/new`、`/status`、model shortcut。
- A2A inbound/outbound。
- Knowledge QA user-token 路径。
- card/footer 样式。
- lark-cli token-store 双 HOME 同步。
- rollback。

---

## 8. CICD 边界

### 8.1 `carher-openclaw` 发布

```text
checkout carher-openclaw
  -> build carher-openclaw:<tag>
  -> run OpenClaw-side unit tests
  -> run patch regression tests
  -> run Feishu E2E on canary bot
  -> push registry
```

### 8.2 `carher-hermes` 发布

```text
checkout carher-hermes
  -> build carher-hermes:<tag>
  -> run Hermes patch regression tests
  -> run Feishu E2E on canary bot
  -> push registry
```

### 8.3 `carher-dual` 发布

```text
checkout carher-dual
read release-manifest.yaml
pull carher-openclaw:<pinned>
pull carher-hermes:<pinned>
build carher-dual:<tuple-tag>
write /etc/carher-release.json
run local dual E2E
run S1 canary dual E2E
push registry
```

生产 dual image 不应依赖服务器上的 `/Data/CarHer` 或 `/Data/hermestest` 当前 git 状态。服务器 git checkout 可以保留为调试和灰度工具，但不能是正式发布真相。

---

## 9. Rollback 规则

### 9.1 纯 OpenClaw 回滚

```text
IMAGE_TAG=old-carher-openclaw-tag
docker compose up -d
```

### 9.2 纯 Hermes 回滚

```text
IMAGE_TAG=old-carher-hermes-tag
docker compose up -d
```

### 9.3 Dual 回滚到旧 dual

```text
IMAGE_TAG=old-carher-dual-tag
docker compose up -d
```

### 9.4 Dual 回滚到纯 OpenClaw

先把 active marker 写回 OpenClaw，再切回原 compose 或原 image：

```bash
echo openclaw > /data/.engine/active
docker compose down
cd /Data/CarHer/deploy/carher-200
docker compose up -d
```

原因：旧纯 OpenClaw 不读取 marker，但保留正确 marker 可以避免未来再切回 dual 时继承 `hermes` 残留状态。

如果回滚原因是 Hermes storage 损坏，还需要检查并清理 Hermes 私有数据目录中的 lock 文件，例如 `/opt/data` 下的 state lock；不要清理 OpenClaw `/data/.openclaw` 会话和 memory。

---

## 10. Patch 治理路线

### Phase 1：立即可生产复现

- `carher-dual` 使用 release manifest 锁双工程 ref。
- build 时 COPY 固定版本的 patch/plugin bundle。
- 移除正式路径中的 runtime bind mount 漂移。
- pin `@larksuite/openclaw-lark`。
- 生成 `/etc/carher-release.json`。
- 每次发布跑 compatibility matrix。

### Phase 2：三产品线正式分流

- `carher-openclaw`、`carher-hermes`、`carher-dual` 分别有 image tag、channel 和 rollback playbook。
- fleet 主流用户继续走 `carher-openclaw`。
- Hermes 用户走 `carher-hermes`。
- power user 走 `carher-dual`。

### Phase 3：patch/plugin 独立包化

将当前 openclaw 工程中的插件和 patch bundle 独立为版本化产物：

```text
@carher/openclaw-patches
@carher/feishu-her-plugin
@carher/a2a-gateway-plugin
@carher/shadow-daemon-plugin
@carher/carher-engine-swap
```

每个包有自己的 changelog、semver、contract tests。`carher-openclaw` 和 `carher-dual` 从 registry 安装固定版本，而不是从某个 dev checkout 拿当前文件。

---

## 11. Plugin SDK 漂移防线

此前 dual PoC 暴露过一个风险：同一个插件 hook 在不同 OpenClaw plugin SDK profile 下可能需要不同注册路径。如果 SDK 变化导致 hook 静默失效，热切换命令会看似加载成功但不触发。

防线：

- 插件生产代码使用 `openclaw/plugin-sdk/*` 类型，不使用 `api: any`。
- 启动时输出 hook 注册摘要。
- CI 用黑盒 contract test 发送 mock dispatch event，验证 hook 真的触发。
- SDK major/minor 升级时 contract test 必须先绿。

不要依赖 SDK 内部私有结构做 `api.hooks.has(...)` 这类检查，除非上游公开了稳定 API。

---

## 12. 结论

三产品线不是为了增加复杂度，而是为了把风险边界和发布边界对齐：

```text
carher-openclaw: 稳定主线
carher-hermes: Hermes 新引擎线
carher-dual: 显式组合线
```

旧 Her 体验依赖的大量 OpenClaw-side 和 Hermes-side patch 必须被新架构妥善处理。正确处理方式不是把所有东西塞进一个仓库或一个巨型镜像，而是：

- 基础线独立演进。
- Patch/plugin bundle 显式版本化。
- Dual 用 release manifest 显式组合。
- 每个组合有可复现 image、build info、E2E 证据和 rollback playbook。

这样 OpenClaw 用户不会被 Hermes 风险影响，Hermes 用户不会被 OpenClaw 节奏拖住，Dual 用户也能获得可审计、可回滚、可复现的热切换体验。
