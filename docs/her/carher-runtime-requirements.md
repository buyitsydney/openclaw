# CarHer Runtime 三工程解耦需求与验收标准

**状态**：执行中，最终交付必须落在三个仓库的 `dev` 分支  
**日期**：2026-05-11  
**目标工程**：`carher-openclaw`、`carher-hermes`、`carher-runtime`

---

## 1. 背景

CarHer 当前已经形成三类用户和三条工程线：

1. 只使用 OpenClaw 的用户。
2. 只使用 Hermes 的用户。
3. 使用 Runtime 热切换能力的多 engine 用户。

本次重构不是简单把文件拆成三个仓库，而是要证明三条线可以独立演进、独立发布、独立回滚，并且 runtime 模式下仍然完整保留 OpenClaw 与 Hermes 两边已经验证过的用户体验。

最终交付口径：

- `carher-openclaw`：最终成果必须在 `dev`，不能停留在 `feat/*` 或历史 PoC 分支。
- `carher-hermes`：最终成果必须在 `dev`，不能依赖 `hermestest-dual-engine` 等历史 worktree。
- `carher-runtime`：最终成果必须在 `dev`，不能只存在于 S1 手工目录或本地临时目录。
- 可以先用 feature branch / worktree 做实验，但验收前必须合入对应仓库的 `dev`。
- 合入 `dev` 后必须从 `dev` 的固化 commit 重新构建、重新部署 canary、重新跑端到端回归。
- 最终状态不能依赖服务器上未提交文件、手工 patch、旧 feature 分支或“昨晚能跑”的偶然状态。

---

## 2. 三类用户

### 2.1 OpenClaw 用户

只使用 `carher-openclaw`。这类用户不应该感知 Hermes 或 runtime 的存在。

他们需要的能力包括但不限于：

- 飞书群聊 mention 路由。
- `/new`、`/status`、model shortcut。
- 多 bot mention。
- knownBots / bot registry。
- 群历史与 DM history-fill。
- interactive card 展开。
- compact footer。
- cron/direct outbound card。
- A2A。
- ACP / daemon / reset index / Knowledge QA 等 OpenClaw 既有能力。

### 2.2 Hermes 用户

只使用 `carher-hermes`。这类用户不应该感知 OpenClaw 或 runtime 的存在。

他们需要的能力包括但不限于：

- Feishu card 输出。
- compact footer。
- Markdown table 到 Feishu native table。
- context preamble。
- lark-cli user-token 工具链。
- Knowledge QA。
- A2A bridge。
- model shortcut。
- busy mode 对齐 OpenClaw 的 `steer`。

### 2.3 Runtime 用户

使用 `carher-runtime`。这类用户需要在一个容器或一个运行单元内切换多个 engine。

当前第一阶段至少包含：

- OpenClaw mode。
- Hermes mode。
- `/hermes` / `/openclaw` 热切换。
- 切换后的 Feishu history continuity。
- 每个 engine 的 HOME、volume、session、memory 隔离。
- lark-cli token-store 双 HOME 同步。

未来 runtime 必须能扩展到第 3 个、第 10 个 agent framework，而不是被写死成 dual-only 产品。

---

## 3. 工程职责

### 3.1 `carher-openclaw`

负责纯 OpenClaw 用户。

拥有：

- OpenClaw 侧 Feishu UX patches。
- OpenClaw 侧 Feishu plugins。
- OpenClaw 侧 A2A、knownBots、history-fill、footer、`/new` 等体验修复。
- OpenClaw-only CI/CD 与 E2E。

不拥有：

- Hermes runtime。
- Hermes 侧 patch。
- runtime 热切换 supervisor。

### 3.2 `carher-hermes`

负责纯 Hermes 用户。

拥有：

- Hermes 侧 Feishu UX patches。
- Hermes 侧 card、footer、KQA、A2A bridge、context preamble。
- Hermes-only CI/CD 与 E2E。

不拥有：

- OpenClaw core。
- OpenClaw patch bundle。
- runtime 热切换 supervisor。

### 3.3 `carher-runtime`

负责多 engine 组合、切换、发布、回滚和兼容性验证。

拥有：

- engine registry / release manifest。
- immutable image digest pin。
- active engine marker。
- runtime supervisor / entrypoint。
- runtime-only engine switch glue。
- `/hermes` / `/openclaw` 等 switch command contract。
- per-engine HOME / volume layout contract。
- Feishu history substrate contract。
- compatibility E2E matrix。
- rollback playbook。
- SBOM / build-info。

不拥有：

- OpenClaw 的 `/new`、footer、knownBots、history-fill 等 UX patch 源码。
- Hermes 的 card、KQA、A2A bridge、context preamble 等 UX patch 源码。
- 任一 engine 的 prompt、model、tool、LLM 调用业务逻辑。

---

## 4. Patch 归属规则

### 4.1 Solo + Runtime-Aware Patch

这类 patch 原本就是为单 engine 用户解决问题，只是在 runtime 环境下需要读取额外 env 或兼容双 HOME。

归属：对应 engine repo。

例子：

- OpenClaw history-fill。
- OpenClaw footer。
- OpenClaw knownBots。
- OpenClaw `/new` command normalize。
- Hermes card renderer。
- Hermes context preamble。
- Hermes KQA skill。

### 4.2 Runtime-Only Glue

这类代码对单 engine 用户没有价值，只为多 engine 切换存在。

归属：`carher-runtime`。

例子：

- OpenClaw 侧 engine-swap plugin。
- Hermes 侧 `/openclaw` / `/hermes` switch glue。
- `/data/.engine/active` marker 写入逻辑。
- switch card lifecycle。
- 写 marker -> 发卡 -> drain -> process exit -> docker restart -> 新 engine 接管。

---

## 5. Release Manifest 要求

`carher-runtime` 必须通过 manifest 显式组合 engine artifact。

生产 manifest 不允许使用：

- `latest`
- `dev`
- floating tag
- 未锁定的 branch ref

必须使用 immutable digest pin。

示例：

```yaml
product: carher-runtime
protocol_version: 1

engines:
  openclaw:
    image: registry.example.com/carher-openclaw
    digest: sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa
    git_ref: <carher-openclaw commit sha>
    role: openclaw

  hermes:
    image: registry.example.com/carher-hermes
    digest: sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb
    git_ref: <carher-hermes commit sha>
    role: hermes

runtime:
  image: registry.example.com/carher-runtime
  git_ref: <carher-runtime commit sha>
  glue_version: 0.1.0
```

只有 runtime manifest 显式更新并通过 E2E，runtime 用户才会采用新的 engine 组合。

---

## 6. 五条总体验收标准

### 6.1 OpenClaw 能力在 Runtime OpenClaw Mode 下 1:1

`carher-openclaw` 最新已验证能力，在 `carher-runtime` 的 OpenClaw mode 下必须 1:1 保留。

尤其要逐项验证每一个 OpenClaw patch 没有丢失、没有回退。

最低验证项：

- `/new @bot`
- `@bot /new`
- `/new @bot1 @bot2`
- `/status`
- 多 bot mention 路由。
- knownBots 渲染。
- group history-fill。
- DM history-fill。
- interactive card 展开。
- compact footer。
- cron/direct outbound card。
- A2A inbound/outbound。
- ACP。
- daemon。
- reset index / memory index。
- Feishu Knowledge QA。

### 6.2 Hermes 能力在 Runtime Hermes Mode 下 1:1

`carher-hermes` `dev` 最新已验证能力，在 `carher-runtime` 的 Hermes mode 下必须 1:1 保留。

尤其要逐项验证每一个 Hermes patch 没有丢失、没有回退。

最低验证项：

- Feishu card 输出。
- Markdown table 到 Feishu native table。
- compact footer。
- context preamble。
- lark-cli user-token。
- Knowledge QA。
- A2A bridge。
- model shortcut：`/gpt`、`/opus`。
- busy mode = `steer`。
- Hermes DM。
- Hermes group mention。

### 6.3 OpenClaw 独立升级对 Hermes 和 Runtime 0 影响

动 `carher-openclaw` 一行代码，走 `carher-openclaw` CI/CD。

预期：

- OpenClaw-only 用户可以升级并验证新能力。
- Hermes-only 用户不受影响。
- Runtime 用户不受影响，除非 `carher-runtime` manifest 显式 bump 到新的 OpenClaw image digest。

这条验收必须量化，不能只口头宣称“0 影响”。

执行验收方式：

1. 升级前记录 baseline：
   - OpenClaw-only E2E score = `O1`
   - Hermes-only E2E score = `H1`
   - Runtime E2E score = `R1`
   - Runtime manifest 中 OpenClaw digest = `DO1`
   - Runtime manifest 中 Hermes digest = `DH1`
2. 修改 `carher-openclaw` 一行代码，走 `carher-openclaw` CI/CD。
3. 不修改 `carher-runtime` manifest。
4. 升级后记录：
   - OpenClaw-only E2E score = `O2`
   - Hermes-only E2E score = `H2`
   - Runtime E2E score = `R2`
   - Runtime manifest 中 OpenClaw digest = `DO2`
   - Runtime manifest 中 Hermes digest = `DH2`
5. PASS 标准：
   - `O2` 反映 OpenClaw 新能力且 OpenClaw-only 全绿。
   - `H1 == H2`，逐 case 一致。
   - `R1 == R2`，逐 case 一致。
   - `DO1 == DO2` 且 `DH1 == DH2`。

### 6.4 Hermes 独立升级对 OpenClaw 和 Runtime 0 影响

动 `carher-hermes` 一行代码，走 `carher-hermes` CI/CD。

预期：

- Hermes-only 用户可以升级并验证新能力。
- OpenClaw-only 用户不受影响。
- Runtime 用户不受影响，除非 `carher-runtime` manifest 显式 bump 到新的 Hermes image digest。

执行验收方式：

1. 升级前记录 baseline：
   - OpenClaw-only E2E score = `O1`
   - Hermes-only E2E score = `H1`
   - Runtime E2E score = `R1`
   - Runtime manifest 中 OpenClaw digest = `DO1`
   - Runtime manifest 中 Hermes digest = `DH1`
2. 修改 `carher-hermes` 一行代码，走 `carher-hermes` CI/CD。
3. 不修改 `carher-runtime` manifest。
4. 升级后记录：
   - OpenClaw-only E2E score = `O2`
   - Hermes-only E2E score = `H2`
   - Runtime E2E score = `R2`
   - Runtime manifest 中 OpenClaw digest = `DO2`
   - Runtime manifest 中 Hermes digest = `DH2`
5. PASS 标准：
   - `H2` 反映 Hermes 新能力且 Hermes-only 全绿。
   - `O1 == O2`，逐 case 一致。
   - `R1 == R2`，逐 case 一致。
   - `DO1 == DO2` 且 `DH1 == DH2`。

### 6.5 Runtime 独立升级对 OpenClaw 和 Hermes 0 影响

动 `carher-runtime` 一个 runtime-only patch，走 `carher-runtime` CI/CD。

预期：

- Runtime 用户可以升级并验证热切换能力。
- OpenClaw-only 用户不受影响。
- Hermes-only 用户不受影响。

执行验收方式：

1. 升级前记录 baseline：
   - OpenClaw-only E2E score = `O1`
   - Hermes-only E2E score = `H1`
   - Runtime E2E score = `R1`
   - OpenClaw-only image digest = `IO1`
   - Hermes-only image digest = `IH1`
2. 修改 `carher-runtime` 一个 runtime-only patch，走 `carher-runtime` CI/CD。
3. 不修改 `carher-openclaw` 与 `carher-hermes` 运行部署。
4. 升级后记录：
   - OpenClaw-only E2E score = `O2`
   - Hermes-only E2E score = `H2`
   - Runtime E2E score = `R2`
   - OpenClaw-only image digest = `IO2`
   - Hermes-only image digest = `IH2`
5. PASS 标准：
   - `R2` 反映 runtime 新能力且 Runtime E2E 全绿。
   - `O1 == O2`，逐 case 一致。
   - `H1 == H2`，逐 case 一致。
   - `IO1 == IO2` 且 `IH1 == IH2`。

---

## 7. E2E 验收矩阵

### 7.0 测试资源

默认只使用测试/灰度 bot，不触碰 14/75。

S1 测试资源：

| 角色             | 容器                                         | 产品线            | 用途                                             | 飞书群         |
| ---------------- | -------------------------------------------- | ----------------- | ------------------------------------------------ | -------------- |
| OpenClaw control | `carher-198`                                 | `carher-openclaw` | 验证纯 OpenClaw 用户体验                         | 199/200 测试群 |
| Hermes control   | `hermestest-199`                             | `carher-hermes`   | 验证纯 Hermes 用户体验，并作为 user-token driver | 199/200 测试群 |
| Runtime canary   | `hermestest-200` 或后续 `carher-runtime-200` | `carher-runtime`  | 验证 runtime OpenClaw/Hermes mode 与热切换       | 199/200 测试群 |

已知 199/200 测试群：

```text
oc_fd0624fa2a9cb343cc9371be5c527686
```

已知 bot mention id：

```text
198: ou_b115c0942d35446311232f584e697d2c
199: ou_57078c733f9584da21aa37d4373b4969
200: ou_c2bc759110aa5bc80b2edea2ede864e9
```

已知 200 DM chat：

```text
oc_f5065ccf48849859a8fe7d04f42db6e6
```

可选本地测试资源：

| 角色                    | 容器             | 用途                          |
| ----------------------- | ---------------- | ----------------------------- |
| user-token driver       | `carher-101`     | 本地 Feishu user token driver |
| Runtime/local candidate | `hermestest-103` | 本地 runtime PoC              |
| OpenClaw/local control  | `carher-104`     | 本地 OpenClaw control         |

本轮目标以 S1 198/199/200 为准。14/75 已经是灰度基线，除非用户重新授权，不作为本次 runtime 重构测试对象。

### 7.1 OpenClaw-Only E2E

目标：证明 `carher-openclaw` 用户完整可用。

测试对象：OpenClaw control bot。

必须覆盖：

- OpenClaw patch inventory。
- Feishu card/footer。
- `/new`、`/status` 和普通对话的单 bot / 多 bot mention 矩阵。
- knownBots。
- group/DM history。
- A2A。
- ACP / daemon / reset index / KQA。

命令与 mention 矩阵最低要求：

| 场景                           | 示例                           | 期望                                                       |
| ------------------------------ | ------------------------------ | ---------------------------------------------------------- |
| 单 bot 普通对话，mention 在前  | `@198 在吗`                    | 只有 198 回复，且 card/footer 正常                         |
| 单 bot 普通对话，mention 在后  | `在吗 @198`                    | 只有 198 回复，且上下文正常                                |
| 多 bot 普通对话                | `@198 @200 各自说出自己的名字` | 被 mention 的 bot 都正确回复，不串身份                     |
| 单 bot `/new`，命令在前        | `/new @198`                    | 系统直接 reset，回复 `✅ New session started.`，不进入 LLM |
| 单 bot `/new`，mention 在前    | `@198 /new`                    | 系统直接 reset，回复 `✅ New session started.`，不进入 LLM |
| 多 bot `/new`                  | `/new @198 @200`               | 两个 bot 各自 reset，各回复一次，不串 session              |
| 单 bot `/status`，命令在前     | `/status @198`                 | 系统直接 status，非 LLM 编造                               |
| 单 bot `/status`，mention 在前 | `@198 /status`                 | 系统直接 status，非 LLM 编造                               |
| 多 bot `/status`               | `/status @198 @200`            | 两个 bot 各自返回自己的状态，不双回复、不串 bot            |

Runtime OpenClaw mode 也必须跑同一矩阵，将 `198` 替换为 runtime canary 的 OpenClaw mode，并与 pure OpenClaw control 对齐。

### 7.2 Hermes-Only E2E

目标：证明 `carher-hermes` 用户完整可用。

测试对象：Hermes control bot。

必须覆盖：

- Hermes patch inventory。
- card/table/footer。
- context preamble。
- KQA。
- A2A bridge。
- model shortcut。
- lark-cli user-token。

### 7.3 Runtime E2E

目标：证明 runtime 用户完整可用，且两个 mode 都与对应 solo 用户 1:1。

测试对象：runtime canary bot。

必须覆盖：

- runtime OpenClaw mode 与 OpenClaw-only control 对齐。
- runtime Hermes mode 与 Hermes-only control 对齐。
- `/hermes` 切换。
- `/openclaw` 切换。
- runtime OpenClaw mode 下单 bot / 多 bot mention 的普通对话、`/new`、`/status` 矩阵。
- runtime Hermes mode 下单 bot / 多 bot mention 的普通对话、model shortcut、KQA、A2A 矩阵。
- 切换后 group history continuity。
- 切换后 DM history continuity。
- lark-cli token-store 双 HOME 同步。
- runtime 最终回到安全态：OpenClaw mode。

特别用例：群里同时艾特多个 bot。

必须至少覆盖：

1. `@198 @200 普通对话`：两个 bot 都应该只以自己的身份回复。
2. `/new @198 @200`：两个 bot 都应该走系统 reset，不进入 LLM。
3. `/status @198 @200`：两个 bot 都应该走系统 status，不进入 LLM。
4. `@198 /new` 与 `@200 /new` 单独测试：命令在 mention 后也必须正确。
5. `@198 /status` 与 `@200 /status` 单独测试：命令在 mention 后也必须正确。
6. runtime 200 在 OpenClaw mode 和 Hermes mode 间切换后，再重复关键 mention/command case，确认切换没有破坏命令解析和身份归属。

验收时必须从飞书真实消息拉回结果，不允许只看容器日志判断通过。

---

## 8. 执行纪律

本轮 scope 明确为 **建仓 + canary + 真实 E2E**。不得退化成只建骨架。

最终发布分支纪律：

- 所有最终可交付代码、文档、脚本、skills 必须在对应仓库 `dev` 分支。
- 任何 feature branch 只允许作为中间验证手段。
- 如果使用 feature branch 测试，必须先 merge/cherry-pick 到 `dev`，再从 `dev` 重新走 CICD。
- E2E 通过必须发生在 `dev` 产物上，而不是 feature branch 产物上。
- 最终报告必须列出三个 `dev` 的 commit sha、S1 部署来源、image digest、E2E artifact。

下一轮执行必须一气呵成完成以下顺序，不得只做文件拆分就宣称成功：

0. 善后老工件并明确迁移计划：
   - 识别 `carher/feat/dual-engine-poc` 中哪些改动属于 `carher-openclaw`，哪些属于 `carher-runtime`。
   - OpenClaw UX patch 必须进入 `carher-openclaw`，不得被 runtime 接管。
   - `carher-engine-swap` 这类 runtime-only glue 必须迁移到 `carher-runtime`。
   - `hermestest-dual-engine` 仅作为历史证据，后续新 CICD 不从这里发车。
1. 更新 `carher-openclaw` 文档和 skills。
2. 创建 `carher-runtime` 独立仓。
3. 写入 runtime 交付物：
   - `spec/engine-marker.md`
   - `spec/swap-command.md`
   - `spec/swap-lifecycle.md`
   - `spec/feishu-history-substrate.md`
   - `spec/volume-layout.md`
   - `spec/env-contract.md`
   - `release/manifest.example.yaml`，必须 digest pin。
   - `runtime/supervisor/dual-entrypoint.sh`，包含 token-store sync。
   - `docker/Dockerfile.runtime` 或等价 runtime image build 文件。
   - `runtime/plugins/carher-engine-swap/`，从 OpenClaw PoC 分支迁移。
   - `runtime/patches/hermes-engine-swap.sh`，从 Hermes 临时实现迁移。
   - `e2e/dual-swap.sh` 或 S1 runtime E2E driver。
   - `e2e/feature-matrix.sh`。
   - `deploy/compose.runtime.example.yaml`，脱敏。
   - `rollback/playbook.md`。
   - `README.md`。
4. secret 扫描。
5. push `carher-runtime` `dev`。
6. 从 `carher-runtime` 固化版本部署 S1 runtime canary。
7. 跑 OpenClaw-only、Hermes-only、Runtime 三套 E2E。
8. 记录 artifact、commit sha、image digest、最终状态。
9. 更新需求文档和 skills。

如果中途遇到不可恢复问题：

- 不碰 14/75。
- 不影响 198 control。
- 只回滚 runtime canary。
- 保留 artifact 和日志。
- 在文档中记录失败点，不得用半通过状态冒充完成。

---

## 9. 成功定义

只有同时满足以下条件，才算本次重构成功：

1. 三个仓库职责清晰，runtime 不吞掉 engine UX patch。
2. `carher-runtime` 远端仓存在，并通过 git 管理。
3. runtime manifest 使用 immutable digest pin。
4. runtime canary 是从 `carher-runtime` 固化版本部署出来的。
5. OpenClaw-only、Hermes-only、Runtime 三套真实 Feishu E2E 全绿。
6. runtime canary 最终回到 OpenClaw 安全态。
7. 文档、skills、artifact 全部更新。

---

## 10. 2026-05-11 当前验收结果

当前已完成一次基于三个 `dev` 的 S1 runtime canary 验收。

### 10.1 三仓 dev 状态

| 仓库                         | dev commit     | 状态                                                                                      |
| ---------------------------- | -------------- | ----------------------------------------------------------------------------------------- |
| `carher-openclaw` / `CarHer` | `74ea84b0db9`  | 已推送 `carher/dev`，S1 `/Data/CarHer` 已 fast-forward 到该提交                           |
| `carher-hermes`              | `ae5542fd9ef6` | 已推送 `origin/dev`；S1 Hermes image 使用 `1224dbbace9d` 行为源，`ae5542f` 仅追加基线文档 |
| `carher-runtime`             | `742ff122e346` | 已推送 `origin/dev`，S1 `/Data/carher-runtime` 已由该 commit 的 `git archive` 同步        |

### 10.2 S1 runtime canary

| 项                   | 值                                                                        |
| -------------------- | ------------------------------------------------------------------------- |
| Runtime 容器         | `hermestest-200`                                                          |
| Runtime source       | `/Data/carher-runtime/.carher-runtime-source-ref = 742ff12`               |
| Runtime image        | `carher-runtime:dev`                                                      |
| Runtime image digest | `sha256:e9d17af6e22e7afe6727fd539289cc9e512595fde255ddc2566004c1ecc66cb8` |
| OpenClaw control     | `carher-198`                                                              |
| Hermes control       | `hermestest-199`                                                          |
| Test group           | `oc_fd0624fa2a9cb343cc9371be5c527686`                                     |
| Final engine marker  | `/data/.engine/active=openclaw`                                           |

### 10.3 已通过的真实 Feishu E2E artifacts

| Artifact                            | 覆盖内容                                                                                                                                                |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `s1-dual-200-20260511T094344`       | 198 OpenClaw control、199 Hermes control、200 OpenClaw mode、`/hermes`、Hermes group continuity、Hermes DM、`/openclaw`、OpenClaw DM history continuity |
| `s1-feature-20260511T094908`        | 199 table card、199 KQA、199→200 A2A、199 `/gpt`、199 `/opus`、200 Hermes KQA、切回 OpenClaw                                                            |
| `s1-command-matrix-20260511T095943` | 多 bot 普通 mention、`/status @198 @200`、`/new @198 @200`、`@200 /status`、`@200 /new`                                                                 |

### 10.4 关键结论

- `carher-runtime` 没有吞掉 OpenClaw/Hermes UX patch；runtime 只拥有 supervisor、marker、switch glue 和 E2E。
- OpenClaw DM history-fill 是 runtime-aware 可选补丁：默认保持纯 OpenClaw 行为，只有 runtime 设置 `CARHER_DUAL_ENGINE_HISTORY_FILL=1` 时启用 DM/thread history continuity。
- `@larksuite/openclaw-lark` 在 runtime 中固定为 `2026.4.10`，不使用 `@latest`。
- S1 200 最终已回到 OpenClaw 安全态。
