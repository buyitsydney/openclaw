---
name: her-self-inspect
description: her 自检当前跑的镜像身份和热 patch 状态（只看自己，不跨容器）。触发词：你什么版本 / 你 commit / 你有热 patch / 你是哪个 image / 你跑啥版本 / your version / your commit / what image / self inspect.
---

# her-self-inspect

任一 her 都能一句话报出自己当前运行的镜像身份与热 patch 状态，**只做 self，不跨容器、不跨主机**。

## 何时触发

- "你现在跑的什么 image / 你是哪个版本"
- "你最新的 commit 是啥 / 你最近改了啥"
- "你有没有热 patch / 你镜像干净吗"
- "self-inspect / 自检"

## 🔒 回答姿势（硬约束，不可自由发挥）

**被问到上述任何触发词时，her 的回答必须：**

1. **每次都实际跑一遍** `bash /app/skills/her-self-inspect/run.sh`（或 `/data/.openclaw/skills/her-self-inspect/run.sh`）。**不允许从对话记忆里回忆**、不允许凭上次输出回答、不允许只答其中一个字段（比如主人只问 commit 也要跑完整 skill）。
2. **1:1 粘贴 run.sh 的 stdout 到聊天里**，代码块包起来，**不做任何改写/美化/删减/重排**：
   - 保留 `🛠️  her-self-inspect` 头
   - 保留那条 `---...---` 分隔线
   - 保留字段名左对齐的原始表格样式
   - 保留 `recent_commits (top 5):` 标题行
3. **不要加主观解读**（例："我是最新的 / 我刚升级 / skill 是研究1的her 刚铺的" 等）—— skill 只报事实，评论留给主人。
4. **想答得更详细**（例如 top-10 commits）只能追加另起一段，**原生输出那部分必须完整在前**。

### 反面示例（不要这样答）

- ❌ 改成自定义表格 `image : xxx` 删掉图标和分隔线
- ❌ 主人只问 "最新 commit" → 只贴一行 commit（必须整段 self-inspect 原样输出，再在下面用一句话指 top-1）
- ❌ 加 "研究1的her 刚升级了 skill" 之类的背景解读
- ❌ 把 `hot_patches: 0 file(s)` 简写成 `hot_patches: 0 (clean)`

## 输出字段

运行 `bash skills/her-self-inspect/run.sh`（或镜像内 `/app/skills/her-self-inspect/run.sh`）即可。输出：

| 字段               | 说明                                                              |
| ------------------ | ----------------------------------------------------------------- |
| `hostname`         | 容器 hostname（例如 carher-200）                                  |
| `openclaw_version` | 从 `/app/package.json` 读到的 openclaw 版本                       |
| `build_hash_short` | CarHer 代码 git short hash（镜像构建时冻结，不依赖 runtime .git） |
| `build_branch`     | 构建时的 git branch                                               |
| `build_time`       | 镜像构建时间（ISO 8601 UTC）                                      |
| `build_tag`        | 如果构建点打了 git tag                                            |
| `recent_commits`   | 构建时冻结的最近 5 条 commit（hash/time/author/subject）          |
| `hot_patches`      | `/app/dist/*.bak*` 文件列表（非空 = 镜像被手改过）                |
| `uptime`           | 容器主进程 uptime（`ps -o etime= -p 1`）                          |

## 设计要点

- **镜像构建期冻结身份**：`/opt/carher/image-info.json`（444 只读）由 Dockerfile 在
  build 时从 `scripts/freeze-git-info.sh` 生成，runtime **不需要任何 .git 目录**，
  k8s / immutable-rootfs 友好。
- **降级优雅**：老镜像（没有 image-info.json）不崩溃，所有 `build_*` 字段输出
  `N/A · upgrade required to see this`，exit 0。
- **单容器 only**：不 SSH、不读跨容器路径、不接触任何服务器清单。
- **热 patch 雷达**：列出 `/app/dist/*.bak*`，把任何人留下的镜像内修改暴露给 her 自己。

## 升级路径

老镜像的 her 运行本 skill → build\_\* 字段全 `N/A`。升级到 ≥ `2026.5.3-self-inspect`
的新镜像即可看到完整身份字段。
