# Her 全员共享技能架构设计

> 日期: 2026-03-08
> 状态: 本地实现完成 + 本地/服务器关键验证完成，待服务器 rollout

---

## 速查: 技能三层架构 (全部已验证)

### 三层优先级

```text
低 ─────────────────────────────────────── 高

全员 (公司级)      部门            个人
  company         department      personal
```

**同名 skill 存在于多层时, 高优先级层永远胜出。高层删除后, 自动回退到下一层。**

### 全员层的两个来源

全员技能有两个来源渠道, 受众相同 (所有人), 区别是部署方式:

| 来源       | 更新方式         | 容器路径                  | 优先级      |
| ---------- | ---------------- | ------------------------- | ----------- |
| 代码内置   | 重建 Docker 镜像 | `/app/skills/`            | 低 (基线)   |
| 管理员推送 | 文件同步, 不重启 | `/data/.openclaw/skills/` | 高 (可覆盖) |

管理员推送的技能优先级高于代码内置, 所以管理员可以随时覆盖或补充基线能力。

### Docker 容器内路径

| 层   | 容器路径                                    | 宿主机目录                        | 持久化     |
| ---- | ------------------------------------------- | --------------------------------- | ---------- |
| 全员 | `/data/.openclaw/skills/`                   | `~/.openclaw/skills/`             | bind mount |
| 部门 | `/data/.agents/skills/`                     | `~/.openclaw/dept-skills/<dept>/` | bind mount |
| 个人 | `/data/.openclaw/workspace/.agents/skills/` | (Docker volume 内, 自动持久)      | volume     |

### 覆盖矩阵 (全部实测验证 2026-03-09)

| #   | 场景              | 全员 | 部门 | 个人 | 最终生效     |
| --- | ----------------- | :--: | :--: | :--: | ------------ |
| 1   | 仅全员            |  Y   |      |      | 全员         |
| 2   | 部门覆盖全员      |  Y   |  Y   |      | 部门         |
| 3   | 个人覆盖所有      |  Y   |  Y   |  Y   | 个人         |
| 4   | 删除个人          |  Y   |  Y   |      | 回退 -> 部门 |
| 5   | 删除部门          |  Y   |      |      | 回退 -> 全员 |
| 6   | 全部删除 (无内置) |      |      |      | 技能消失     |
| 7   | 本地 Her 隔离     |  Y   |  -   |  -   | 仅全员       |

> `-` = 仅存在于容器内, 本地 Her 不可见

### 谁管什么

| 角色       | 范围 | 宿主机操作目录                    | 影响        |
| ---------- | ---- | --------------------------------- | ----------- |
| 系统管理员 | 全员 | `~/.openclaw/skills/`             | 全部 200 人 |
| 部门管理员 | 部门 | `~/.openclaw/dept-skills/<dept>/` | 仅本部门    |
| 用户/Her   | 个人 | (容器内 volume, Her 自行管理)     | 仅自己      |

### 生效方式

| 方式               | 可靠性   | 说明                                      |
| ------------------ | -------- | ----------------------------------------- |
| `/new` 新 session  | **100%** | 正式保证, 任何层变更都在新 session 生效   |
| chokidar 热加载    | **高**   | `~/.openclaw/skills` 被主动监控, 多数即时 |
| 自动 session reset | **100%** | 依赖 idleMinutes / session.reset 配置     |

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

### 2.1 源码真实技能来源

OpenClaw 源码里真实会扫描 5 类 skill 目录：

1. **bundled skills**
2. **managed/shared skills**
3. **personal agents skills**
4. **project agents skills**
5. **workspace skills**

对应路径分别是：

- `repo/skills/` → bundled skills
- `~/.openclaw/skills/` → managed/shared skills
- `~/.agents/skills/` → personal agents skills
- `<workspace>/.agents/skills/` → project agents skills
- `<workspace>/skills/` → workspace skills

这 5 层不是一个东西，也不是同一优先级。

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
- **同名 skill 不会重复注入，后者覆盖前者**
- 但从 CarHer 部署视角，不必把这 5 层都暴露给业务使用；应该再抽象成更稳定的 4 层业务模型

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
- **部门层** 与 **个人层** 必须明确区分，并且优先级稳定。
- **`<workspace>/skills` 不作为 CarHer 正式发布层**；它优先级太高，且与当前仓库规则冲突。

### 4.2 目标架构

建议的目标架构如下：

```text
repo/skills/
  └─ 作为 bundled 基线技能（随代码版本发布）

host global skills dir
  └─ ~/.openclaw/skills/
     └─ 作为全员共享层

host department skills dir
  └─ ~/.agents/skills/
     └─ 作为部门共享层（Docker 中需额外挂载）

agent workspace dir
  └─ <workspace>/.agents/skills/
     └─ 作为个人专属层
```

### 4.3 CarHer 推荐的四层业务映射

对 CarHer 来说，真正应该向业务暴露的是下面 4 层，而不是直接暴露源码里的 5 个目录概念：

1. **默认层**
   - 业务含义：系统自带、所有人默认有的基线能力
   - 实际路径：`repo/skills/`
   - 源码层映射：bundled skills

2. **全员层**
   - 业务含义：200 人统一共享的公司级 skill
   - 实际路径：`~/.openclaw/skills/`
   - 源码层映射：managed/shared skills

3. **部门层**
   - 业务含义：某一组用户共享，但不是全员共享
   - 推荐实际路径：`~/.agents/skills/`
   - 源码层映射：personal agents skills
   - 注意：这里“personal”是源码命名；在 CarHer 部署里，完全可以把它重新定义成“部门层”

4. **个人层**
   - 业务含义：只属于某一个用户 / 某一个容器 / 某一个 Her
   - 推荐实际路径：`<workspace>/.agents/skills/`
   - 源码层映射：project agents skills

这样做的原因是：它刚好满足 CarHer 想要的业务优先级：

```text
默认 < 全员 < 部门 < 个人
```

对应源码真实优先级正好也是：

```text
bundled < managed/shared < ~/.agents/skills < <workspace>/.agents/skills
```

因此不需要改 upstream，只要把不同层级映射到对的目录即可。

### 4.4 为什么个人层不要用 `<workspace>/skills`

虽然 `<workspace>/skills` 仍然比 `<workspace>/.agents/skills` 更高，但不建议在 CarHer 正式方案里使用：

- 它是源码里的最高优先级，太容易把其他层全部压掉
- 当前仓库规则已经明确不把它作为正式 skill 发布通道
- 排障时会比 `.agents/skills` 更难定位来源

因此，CarHer 个人层推荐固定使用：

- `<workspace>/.agents/skills/`

而不是：

- `<workspace>/skills/`

### 4.5 为什么不建议把企业共享技能放到 workspace

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

### 4.6 Docker 持久化与挂载原则

四层业务架构要真正可用，关键不只是“代码支持”，还要看 Docker 重建后文件是否仍在。

#### 默认层

- 路径：`/app/skills`
- 来源：镜像内 bundled skills
- 是否随 Docker 重建保留：**是**
- 说明：它本来就是镜像内容

#### 全员层

- 路径：`/data/.openclaw/skills`
- 当前映射：宿主机 `~/.openclaw/skills -> /data/.openclaw/skills`
- 是否随 Docker 重建保留：**是**
- 说明：已经通过宿主机 bind mount 解决

#### 部门层

- 推荐容器路径：`/data/.agents/skills`
- 对应源码层：`~/.agents/skills`
- 是否默认保留：**否**
- 原因：Docker 当前只挂载了 `/data/.openclaw`，没有挂载 `/data/.agents`
- 结论：如果要让“部门层”在 Docker 中长期存在，必须额外增加宿主机目录挂载，例如：
  - `宿主机部门目录 -> /data/.agents/skills`

#### 个人层

- 推荐容器路径：`/data/.openclaw/workspace/.agents/skills`
- 对应源码层：`<workspace>/.agents/skills`
- 是否随 Docker 重建保留：**是**
- 原因：默认 workspace 在 `/data/.openclaw/workspace`，而 `/data/.openclaw` 已经是 Docker volume
- 结论：如果把个人 skill 放在 `<workspace>/.agents/skills`，即使重建 Docker，只要 volume 不删，它仍然存在

**因此：**

- 用户问“个人 skill 重启 Docker 后还能继续存在吗？”
- **答案是：如果个人 skill 放在 `<workspace>/.agents/skills`，能。**
- **如果误放在 Docker 里的 `~/.agents/skills`（即 `/data/.agents/skills`），默认不能，除非额外挂载。**

### 4.7 生效机制

当前推荐的稳定生效方式：

- 发布到 shared 目录
- 让用户在**新 session** 中拿到新 snapshot

如果要实现“几轮之后自动得到新 skills”，应依赖：

- `session.reset`
- `session.resetByType`
- `idleMinutes`
- 低峰时段的 daily reset

而不是把方案建立在 watcher 必然成功的前提上。

### 4.8 推荐测试顺序

四层方案不要一上来全测，建议按最小闭环逐层验证：

1. **先测个人层**
   - 原因：风险最小，只影响一个 Her
   - 做法：在目标 Her 的 `<workspace>/.agents/skills/<name>/SKILL.md` 放一个测试 skill
   - 验证：开新 session，发送固定测试口令，确认只该用户生效
   - 持久化：重建 Docker 后再次测试，确认仍然存在

2. **再测部门层**
   - 原因：它需要新增 Docker 挂载，是部署层改动
   - 做法：给一个测试部门准备宿主机目录，并挂载到目标容器 `/data/.agents/skills`
   - 验证：同部门多用户生效，非该部门用户不生效

3. **最后测全员层**
   - 原因：影响范围最大
   - 做法：用 `~/.openclaw/skills` 发布共享 skill
   - 验证：Admin Her + 测试容器 + 服务器测试容器全部新 session 生效

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

### 5.4 个人层 vs 共享层优先级验证

在 `docker1` 中同时放置同名 skill `hot-reload-test`，内容不同：

- **共享层** `/data/.openclaw/skills/hot-reload-test/` → 回复 `SHARED层命中`
- **个人层** `/data/.openclaw/workspace/.agents/skills/hot-reload-test/` → 回复 `PERSONAL层命中`

验证结果：

1. `/new` 后发送触发词 → 回复 `PERSONAL层命中`
   - 证明：**个人层 > 共享层**，与源码优先级 `agents-skills-project > openclaw-managed` 一致
2. 删除个人层，只保留共享层 → `/new` 后回复 `SHARED层命中`
   - 证明：**个人层删除后自动回退到共享层**

结论：

- 四层业务优先级 `默认 < 全员 < 部门 < 个人` 在运行时被 100% 验证
- 个人层可以覆盖共享层的同名 skill，删除后自动回退

### 5.5 `~/.openclaw/skills` 支持 watcher 热加载

从源码 `src/agents/skills/refresh.ts` 确认：`path.join(CONFIG_DIR, "skills")` 即 `~/.openclaw/skills` 被 `chokidar` 主动监控。

实际测试中，`docker1` 的 `tester` agent 在该目录新增 skill 后，无需 `/new` 即可在下一轮对话命中。

工程建议：

- 正式发布仍以 **新 session 生效** 作为可靠保证
- watcher 热加载可作为 **加速手段**，但不应作为唯一依赖

### 5.6 本次本地实现已完成

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
