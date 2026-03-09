---
name: carher-shared-skills
description: CarHer 三层技能架构管理（全员/部门/个人）。Use when the user mentions skill, 技能, 共享, shared, 全员, 部门, 个人, publish skill, sync skill, 上线 skill, 发布技能, priority-test, 优先级, dept-skills, or any skill distribution/override operation.
---

# CarHer 三层技能管理

## 优先级

```text
全员 < 部门 < 个人
```

同名 skill 高层胜出，高层删除自动回退下一层。

## 路径速查

### 宿主机 (Mac / 服务器通用)

| 层   | 宿主机目录                               |
| ---- | ---------------------------------------- |
| 全员 | `~/.openclaw/skills/<name>/`             |
| 部门 | `~/.openclaw/dept-skills/<dept>/<name>/` |
| 个人 | (Her 自行管理, 不需手动操作)             |

### Docker 容器内

| 层   | 容器路径                                    | 挂载方式      |
| ---- | ------------------------------------------- | ------------- |
| 全员 | `/data/.openclaw/skills/`                   | bind mount    |
| 部门 | `/data/.agents/skills/`                     | bind mount    |
| 个人 | `/data/.openclaw/workspace/.agents/skills/` | Docker volume |

全员层内还有 **代码内置** (bundled, `/app/skills/`)，管理员推送覆盖内置。

## 操作

### 发布全员 skill

```bash
./scripts/publish-shared-skills.sh sync <name>     # repo -> ~/.openclaw/skills/
./scripts/publish-shared-skills.sh remove <name>    # 删除
./scripts/publish-shared-skills.sh list-target      # 查看已发布
```

### 发布部门 skill

```bash
mkdir -p ~/.openclaw/dept-skills/<dept>/<name>
# 写入 SKILL.md
```

部门名默认 `default`，可通过 `CARHER_DEPT=<name>` 环境变量指定。

### 服务器操作

服务器路径相同，通过 sshpass 执行（凭证在 `docker/servers.txt`）：

```bash
sshpass -p 'PWD' ssh USER@IP "cd /Data/CarHer && ./scripts/publish-shared-skills.sh sync <name>"
```

### 查看容器内 skill

```bash
docker exec carher-N sh -lc 'ls /data/.openclaw/skills/ /data/.agents/skills/ /data/.openclaw/workspace/.agents/skills/ 2>/dev/null'
```

## 生效规则

- **`/new` 新 session**：100% 生效
- **chokidar 热加载**：`~/.openclaw/skills` 被监控，多数即时生效
- **自动 reset**：依赖 `idleMinutes` / `session.reset` 配置

## 边界

- 删除 shared 后旧 session 可能 ENOENT，不保证平滑回退
- 只有镜像内原本有 bundled 版的 skill，删除 shared 后才能回退
- 部门层 bind mount 需容器重建才首次挂载；已挂载的放文件即可
- 个人层在 Docker volume 中，重建不丢失
