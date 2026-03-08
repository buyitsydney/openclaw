# Her 全员共享技能架构设计

> 日期: 2026-03-08
> 状态: 本地实现完成 + 本地/服务器关键验证完成，待服务器 rollout

---

## 1. 目标

我们要获得这样一种能力：

- 在不修改 upstream 代码的前提下，为 CarHer 体系增加一套企业级共享 skills 发布机制。
- 新增一个共享 skill 后，本地 Her、服务器 Admin Her、各 Docker 用户容器都能获得同样能力。
- 技能生效不依赖 Docker 重启。
- 技能发布过程可审计、可回滚，严格走 Git 和部署脚本流程。

这里的“获得同样能力”需要拆成两层：

1. **分发层**：所有目标环境都能读到同一份 skill 文件。
2. **运行时层**：OpenClaw 在新 session 中实际选择并加载这份 skill。

当前已经确认第 2 层的稳定结论是：

- **新 session 生效** 是稳定能力。
- **同 session 热更新** 在当前 Docker / watcher 条件下不作为强保证依赖。

---

## 2. 现状与关键事实

### 2.1 三类技能来源

OpenClaw 运行时会从多个来源加载 skill，CarHer 当前实际涉及三类：

1. **bundled skills**
2. **managed/shared skills**
3. **workspace skills**

其中：

- `repo/skills/` 在当前 CarHer 运行方式下，会被解析成 **bundled skills**
- `~/.openclaw/skills/` 是 **managed/shared skills**
- `<workspace>/skills/` 才是 **workspace skills**

这三者不是一个东西。

### 2.2 repo 下的 `skills/` 为什么会被找到

这不是因为 repo 自动等于 workspace，而是因为 OpenClaw 会解析 bundled skills 目录。

运行在 npm/dev 模式时，源码会把 `<packageRoot>/skills` 视为 bundled skills：

```ts
// src/agents/skills/bundled-dir.ts
// npm/dev: resolve `<packageRoot>/skills` relative to this module.
const candidate = path.join(packageRoot, "skills");
if (looksLikeSkillsDir(candidate)) {
  return candidate;
}
```

所以：

- Mac 本地 Her 运行 repo 里的 `node dist/index.js ...`
- S1 Admin Her 运行 `/Data/CarHer`
- Docker 容器运行 `/app`

这些环境中的 `skills/` 都会被当成 bundled skills 参与加载。

### 2.3 workspace 不是“当前打开的 repo”

OpenClaw 对 workspace 有严格定义：**agent workspace directory**。

默认情况下：

- Mac 本地 Her: `~/.openclaw/workspace`
- S1 Admin Her: `/home/cltx/.openclaw/workspace`
- Docker 容器: `/data/.openclaw/workspace`

如果没有显式配置 `agents.defaults.workspace`，就走默认值。

因此，只有下面这个路径才是 workspace skills：

- `<workspace>/skills`

不是任意 repo 根目录下的 `skills/`。

### 2.4 当前服务器真实状态

根据只读检查，S1 当前状态是：

- **Admin Her**
  - `agents.defaults.workspace` 未显式配置
  - workspace 实际存在于 `/home/cltx/.openclaw/workspace`
  - `/home/cltx/.openclaw/workspace/skills` 不存在
  - `/home/cltx/.openclaw/skills` 不存在
- **Docker 容器**
  - workspace 实际存在于 `/data/.openclaw/workspace`
  - `/data/.openclaw/workspace/skills` 不存在
  - `/data/.openclaw/skills` 不存在

这意味着服务器当前能用的 `twitter-monitor`、`her-debate-mode` 等技能，本质上来自 repo/image 自带的 bundled skills，而不是 shared 目录，也不是 workspace skills。

---

## 3. 加载优先级与开关

### 3.1 真实优先级

CarHer 当前应以源码中的真实优先级为准：

```ts
// src/agents/skills/workspace.ts
// Precedence: extra < bundled < managed < agents-skills-personal < agents-skills-project < workspace
```

完整展开为：

1. `skills.load.extraDirs`
2. bundled skills
3. `~/.openclaw/skills`
4. `~/.agents/skills`
5. `<workspace>/.agents/skills`
6. `<workspace>/skills`

结论：

- **最高优先级是 `<workspace>/skills`**
- **企业共享技能推荐放 `~/.openclaw/skills`**
- 同名 skill 不会重复注入，后者覆盖前者

### 3.2 为什么不是所有 skill 都加载

OpenClaw 不是“只要存在就全部启用”，而是先经过资格过滤，再进入 session snapshot。

过滤条件主要有四类：

1. `skills.entries.<name>.enabled`
2. `skills.allowBundled`
3. frontmatter 里的 `requires.*` / `os`
4. prompt 限制（最大 skills 数量、最大 prompt 字符数）

其中最容易混淆的是：

- `skills.allowBundled` **只限制 bundled skills**
- `~/.openclaw/skills` 和 `<workspace>/skills` **不受 allowBundled 限制**
- 但 `skills.entries.<name>.enabled = false` 可以禁用任意来源的同名 skill

### 3.3 shared 目录为什么看起来“不需要开关”

因为 `~/.openclaw/skills` 本来就是默认扫描目录之一。

一个新 skill 放进 shared 目录后，要真正生效，仍然要满足以下条件：

- 没有被 `skills.entries.<name>.enabled = false` 禁用
- 没有被更高优先级的同名 workspace skill 覆盖
- 通过 `requires.env` / `requires.bins` / `requires.config` / `os` 检查
- session snapshot 在新 session 中重新构建，或 watcher 成功刷新

所以 shared 目录不是“特殊模式”，而是默认加载来源之一。

---

## 4. 推荐方案

### 4.1 设计原则

企业共享技能方案应遵循以下原则：

- **bundled** 继续承担“基线技能集”的职责。
- **shared** 负责企业全员共享的新增 skill 或临时覆盖 skill。
- **workspace** 只留给单机 / 单 agent 的特例覆盖，避免污染全局策略。

### 4.2 目标架构

建议的目标架构如下：

```text
repo/skills/
  └─ 作为 bundled 基线技能（随代码版本发布）

host shared skills dir
  └─ 同步到 ~/.openclaw/skills/
     └─ 作为企业共享覆盖层

agent workspace
  └─ <workspace>/skills/
     └─ 保留给单 agent 特例，不作为企业共享发布主通道
```

### 4.3 为什么不建议把企业共享技能放到 workspace

因为 workspace 是最高优先级。

一旦把企业共享 skill 放到 workspace：

- 会压过 shared 和 bundled
- 排障时很难快速判断到底是哪一份生效
- 多机扩容时更难统一
- 未来如果某个 agent 需要例外配置，优先级容易打架

因此企业共享技能的主通道应是：

- **repo 管理内容**
- **发布脚本同步到 shared 目录**
- **运行时由 `~/.openclaw/skills` 覆盖 bundled**

### 4.4 生效机制

当前推荐的稳定生效方式：

- 发布到 shared 目录
- 让用户在**新 session** 中拿到新 snapshot

如果要实现“几轮之后自动得到新 skills”，应依赖：

- `session.reset`
- `session.resetByType`
- `idleMinutes`
- 低峰时段的 daily reset

而不是把方案建立在 watcher 必然成功的前提上。

---

## 5. 已完成验证

### 5.1 本地 shared 新 skill 验证

已通过一个全新 skill 做过验证：

- 先把全新 skill 放进 `repo/skills/`
- 再通过发布脚本同步到 `~/.openclaw/skills`
- 本地 Admin Her 与 `docker1` 都能在**新 session** 中加载 shared 版
- 不需要修改 upstream 代码
- 不需要重启 Docker

这个实验说明：

- `repo/skills -> ~/.openclaw/skills -> /data/.openclaw/skills -> 新 session`
  这条链路是成立的
- shared 新增 skill 的基本分发与运行时加载都成立

### 5.2 同名 bundled skill 覆盖验证

已使用 `twitter-monitor` 做过验证：

- repo/image 原本已有 bundled 版
- 本地将 shared 版放到 `~/.openclaw/skills/twitter-monitor`
- shared 版加入无害 marker 和精确测试触发句
- 本地 Admin Her 与 `docker1` 在新 session 中都实际命中了 shared 版

这个实验说明：

- shared 可以覆盖 bundled
- 覆盖生效不需要额外“共享模式开关”
- 对于镜像里原本就存在的 bundled skill，shared 删除后可在新 session 中回退

### 5.3 删除 shared 后的真实边界

这次补充验证得到两个非常重要的工程边界：

1. **旧 session 不保证平滑回退**
   - 删除 shared override 后，旧 session 仍可能持有旧 `skillFilePath`
   - 下一轮继续执行时，可能出现 `ENOENT`，而不是立刻优雅回退
   - 因此生产上不能把“删除 shared skill 后旧对话立刻恢复正常”当成强保证

2. **只有容器镜像里原本就有 bundled 基线的 skill，删除 shared 后才有 bundled 可回退**
   - 例：`twitter-monitor` 在 Docker 镜像 `/app/skills/twitter-monitor` 中本来就存在
   - 所以删除 shared override 后，**新 session** 可以回退到 bundled
   - 反例：`shared-flow-e2e` 是本次临时新增到 repo 的 skill，但现有 `docker1` 容器镜像里并没有 `/app/skills/shared-flow-e2e`
   - 因此删除 shared 版后，Docker 新 session 不能回退到 bundled；本机 Her 可以看到 repo skill，但旧容器镜像不行

### 5.4 本次本地实现已完成

为支持正式 rollout，本地已经完成两项工程实现：

- `start-user.sh`
  - 自动确保宿主机 `~/.openclaw/skills` 存在
  - 启动 Docker 容器时挂载到 `/data/.openclaw/skills`
- `scripts/publish-shared-skills.sh`
  - `sync <skill...>`: 把 `repo/skills/<name>/` 同步到 `~/.openclaw/skills/<name>/`
  - `remove <skill...>`: 删除 `~/.openclaw/skills/<name>/`
  - `list-source` / `list-target`: 查看 repo 与 shared 目录当前 skill 列表

---

## 6. TODO 与 rollout

### 6.1 必做 TODO

- 确定 Mac 与三台服务器统一使用的 shared skills 宿主机目录规则
- 把 `start-user.sh` 的 shared 挂载能力同步到三台服务器代码
- 在三台服务器创建并约定统一的 `~/.openclaw/skills` 宿主机目录
- 把 `scripts/publish-shared-skills.sh` 同步到三台服务器代码
- 配置 session reset，让新 skill 可以在一段时间后自动进入新 session
- 制定 shared skill 删除/回退操作规范（必须按“新 session 生效”原则执行）

### 6.2 rollout 顺序

必须按下面顺序推进：

1. Mac 本地验证（已完成）
2. S1 Admin Her 验证（已完成）
3. S1 `carher-13` 验证（已完成）
4. 把共享挂载与发布脚本通过 Git 同步到三台服务器
5. 单服务器小范围 rollout
6. 三台服务器全量 rollout

---

## 7. 服务器实验设计

### 7.1 实验目标

本次服务器实验的目标不是改生产，而是证明：

- S1 Admin Her 可以在不重启网关的情况下，于新 session 中加载 shared override
- S1 `carher-13` 也可以在新 session 中加载同一份 shared override

### 7.2 实验对象

- **S1 Admin Her**：原生进程，tmux session `admin-her`
- **S1 `carher-13`**：按当前用户指定，作为服务器实验容器

### 7.3 实验 skill 选择

建议继续使用 `twitter-monitor` 做 override，而不是新造复杂 skill。

原因：

- 这个 skill 已经存在 bundled 版本，最适合验证“shared 覆盖 bundled”
- 可以加一个无害 marker，100% 区分来源
- 可以加一个精确测试触发句，100% 验证执行结果

推荐测试 marker：

- description 追加 `TWITTER_SHARED_S1_V1`

推荐测试触发句：

- 用户消息精确等于 `服务器推特共享技能测试V1`
- assistant 必须精确回复 `服务器推特共享技能V1已生效`

### 7.4 实验步骤

1. 只读确认 S1 当前没有 shared 目录：
   - `/home/cltx/.openclaw/skills`
   - `/data/.openclaw/skills`
2. 在 S1 Admin Her 侧准备 shared override：
   - 创建 `/home/cltx/.openclaw/skills/twitter-monitor/SKILL.md`
   - 内容来自 repo 版 `twitter-monitor`
   - 只增加 marker 和精确测试触发句
3. 在 `carher-13` 侧准备同一份 override：
   - 若已有 shared 挂载，则写入挂载目录
   - 若尚未挂载，则先做一次容器内一次性目录验证，用于证明运行时逻辑成立
4. 各自开启**新 session**
5. 发送测试触发句
6. 同时检查两类证据：
   - session snapshot 的 `skillFilePath`
   - description 中是否含 `TWITTER_SHARED_S1_V1`
7. 验证 assistant 回复是否精确命中
8. 验证完成后删除测试 override，恢复环境干净状态

### 7.5 通过标准

必须同时满足：

- Admin Her 新 session 命中 shared override
- `carher-13` 新 session 命中 shared override
- 两边都不需要重启 Docker
- 两边都能从 session snapshot 看出 skill 来源是 shared 路径，而不是 bundled 路径

### 7.6 风险边界

- 不操作 `carher-1`
- 不操作任何董事长相关容器
- 不做批量重启
- 不修改 upstream 代码
- 实验只允许使用：
  - S1 Admin Her
  - S1 `carher-13`

---

## 8. 下一步如何正式推进

当前不再是“继续做实验”，而是进入 **服务器代码同步 + 小范围 rollout** 阶段。

建议按下面顺序执行：

1. 把本地已完成的实现通过 Git 同步到服务器代码：
   - `start-user.sh`
   - `scripts/publish-shared-skills.sh`
   - `docs/her/her-shared-skills-architecture.md`
2. 在 **S1** 先做最小正式接入：
   - 确认服务器宿主机存在 `~/.openclaw/skills`
   - 用新版本 `start-user.sh` 重建 **仅测试容器**
   - 用 `scripts/publish-shared-skills.sh sync <skill>` 推送 shared skill
3. 用 **S1 Admin Her + S1 `carher-13`** 各做一次新 session 验证：
   - 新增 shared skill 是否生效
   - 同名 shared override 是否覆盖 bundled
   - 删除 shared override 后，新的 session 是否按预期消失/回退
4. 如果 S1 稳定，再按服务器逐台 rollout

上线时必须记住两个运行时边界：

- **新增/更新/删除 shared skill 的收敛单位是新 session，不是当前对话**
- **删除 shared 后能否回退 bundled，取决于目标环境镜像里是否原本就有该 bundled skill**
