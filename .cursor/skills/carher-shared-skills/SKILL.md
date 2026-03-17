---
name: carher-shared-skills
description: CarHer 三层技能架构管理（全员/部门/个人）。Use when the user mentions skill, 技能, 共享, shared, 全员, 部门, 个人, publish skill, push skill, 上线 skill, 发布技能, priority-test, 优先级, dept-skills, or any skill distribution/override operation.
---

# CarHer 三层技能管理

## 三层架构

```text
低 ──────────────── 高
全员    部门    个人
```

同名 skill 高层覆盖低层，删除后自动回退。`/new` 后生效。

## 路径

| 层级 | 宿主机路径                        | 容器内路径                                  | 挂载方式           |
| ---- | --------------------------------- | ------------------------------------------- | ------------------ |
| 全员 | `~/.openclaw/skills/`             | `/data/.openclaw/skills/`                   | bind mount **:ro** |
| 部门 | `~/.openclaw/dept-skills/<dept>/` | `/data/.agents/skills/`                     | bind mount **:ro** |
| 个人 | (容器 volume 内)                  | `/data/.openclaw/workspace/.agents/skills/` | Docker volume      |
| 内置 | `repo/skills/`（随镜像）          | `/app/skills/`                              | 镜像内             |

全员和部门层在容器内是**只读**的（`:ro`），Her 无法从容器内写入。

## 全员 skills 管理

全员 skills 存放在 Mac 本地 `~/.openclaw/skills/`，**不在 git 里**。bundled 版（`repo/skills/`）跟随 upstream 不修改。全员层放我们自己的版本，优先级高于 bundled。

```bash
./scripts/publish-shared-skills.sh list      # 查看本地全员 skills
./scripts/publish-shared-skills.sh diff      # 对比本地 vs 三台服务器
./scripts/publish-shared-skills.sh push      # 推送到所有服务器（rsync --delete）
```

`push` 读 `docker/servers.txt` 获取凭证，rsync 整体同步。不需要重建容器。

### skill-creator 最新版来源

Anthropic 官方最新版在 `github.com/anthropics/skills` 仓库（Apache 2.0）。ClawHub 上是旧版。本地全员层是 GitHub 最新版 + CarHer 企业适配（定时任务执行模型、三层路径等）。

## 查看容器内 skill

```bash
docker exec carher-N ls /data/.openclaw/skills/                        # 全员
docker exec carher-N ls /data/.agents/skills/                           # 部门
docker exec carher-N ls /data/.openclaw/workspace/.agents/skills/       # 个人
```

## 边界

- `:ro` 只对新建/重建的容器生效，已运行的旧容器可能仍是 rw
- 删除 shared 后旧 session 可能 ENOENT，新 session 自动回退
- 个人层在 Docker volume 中，重建不丢失
