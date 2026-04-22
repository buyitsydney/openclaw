---
name: carher-a2a-topology
description: CarHer A2A hub/spoke 拓扑 + docker 资源配额 fleet 策略。Use when user mentions A2A, hub, spoke, outbound, resource limits, CPU, memory, 资源, 配额, yitian-her, host-native Her.
---

# CarHer A2A 拓扑 + 资源配额 Fleet 策略

## 🎯 标准配置（2026-04-21 确认）

### 资源配额（所有 docker 用户容器）

| 维度   | 值                      | Mac 特殊                      |
| ------ | ----------------------- | ----------------------------- |
| CPU    | 10 cores（`--cpus=10`） | 同                            |
| Memory | 16 GB（`--memory=16g`） | 同                            |
| Swap   | 16 GB                   | 32 GB（Mac 可用 swap 更慷慨） |

**适用范围**：所有 `carher-NN` docker 容器（Mac 101-104、S1 12/198/199/200、S3 14/75 等）。

**⚠️ host-native 不设上限**：S1 yitian-her 作为 host 进程直接跑在裸机，不走 docker 资源限制，完全吃 S1 硬件（256GB DDR / 32 CPU）。

### A2A 拓扑

| 节点                             | 角色    | `outbound.enabled` | 说明                                 |
| -------------------------------- | ------- | ------------------ | ------------------------------------ |
| **S1 yitian-her（host-native）** | **Hub** | `true`             | 唯一出口；可主动 dispatch 到其他 her |
| 所有 docker 用户                 | Spoke   | `false`（默认）    | 只接收任务，不主动发起               |

**铁律**：全 fleet **只能有一个 hub**。提升另一个节点为 hub 之前，必须先把 yitian-her 降级为 spoke。两个 hub 会造成 A2A 路由冲突。

---

## 🛠 操作 Playbook

### 1. 新容器资源调整（live update，无需重启）

```bash
# 单机
docker update --cpus=10 --memory=16g --memory-swap=16g carher-N

# Mac（swap 32G）
docker update --cpus=10 --memory=16g --memory-swap=32g carher-101 carher-102 carher-103 carher-104

# S1（4 容器）
sshpass -p '<pwd>' ssh cltx@10.68.13.186 \
  "docker update --cpus=10 --memory=16g --memory-swap=16g carher-12 carher-198 carher-199 carher-200"

# S3（2 容器）
sshpass -p '<pwd>' ssh cltx@10.68.13.188 \
  "docker update --cpus=10 --memory=16g --memory-swap=16g carher-14 carher-75"
```

**验证**：`docker inspect <c> --format "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}"` 应显示 `10000000000 17179869184`。

### 2. 让 S1 yitian-her 成为 A2A hub

配置落在 `/home/cltx/.openclaw/openclaw.json` 的 `plugins.entries.a2a-gateway.config.outbound.enabled = true`。

```bash
sshpass -p '<pwd>' ssh cltx@10.68.13.186 "python3 <<'PY'
import json, pathlib
p = pathlib.Path('/home/cltx/.openclaw/openclaw.json')
c = json.loads(p.read_text())
plugins = c.setdefault('plugins', {})
entries = plugins.setdefault('entries', {})
a2a = entries.setdefault('a2a-gateway', {})
a2a['enabled'] = True
cfg = a2a.setdefault('config', {})
cfg['outbound'] = {'enabled': True}
p.write_text(json.dumps(c, ensure_ascii=False, indent=2) + '\n')
print('OK')
PY"

# 重启 host gateway 才生效
sshpass -p '<pwd>' ssh cltx@10.68.13.186 \
  "tmux kill-session -t her 2>/dev/null || true; sleep 2; tmux new-session -d -s her 'cd /Data/CarHer && ./start.sh 2>&1 | tee -a ~/logs/yitian-her.log'"

# 验证
sshpass -p '<pwd>' ssh cltx@10.68.13.186 \
  "grep 'outbound.enabled' ~/logs/yitian-her.log | tail -3"
# 期望: a2a-gateway: outbound.enabled=true
```

### 3. 确认 docker 用户为 spoke

shared-config.json5 里 `plugins.entries.a2a-gateway.config` **没有** `outbound` key → 默认 `outbound.enabled=false` → spoke ✅

如果意外被提升为 hub，在该容器的 volume `/data/.openclaw/openclaw.json` 里删除 `plugins.entries.a2a-gateway.config.outbound` 或显式设为 `{enabled: false}`，然后 `docker restart carher-N`。

---

## ⚠️ 注意事项

1. **`docker update` 是 live 的**：资源调整不需要 restart，当场生效。
2. **hub 切换需要 restart**：因为 a2a-gateway 插件只在启动时读取 `outbound.enabled`。
3. **host-native yitian-her 重启 != docker restart**：用 `tmux kill-session -t her` + `./start.sh`（start.sh 会自动把自己重新包进 tmux `her` 会话）。
4. **SSH-edit `openclaw.json` 是个例外**：它不是 git 追踪的 shared config，是 host-specific runtime overlay。相比 `shared-config.json5`（git 追踪、全 fleet 生效），`openclaw.json` 的 ssh-edit 可接受。
5. **长期改进方向**：把 `A2A_OUTBOUND=1` 做成 `docker/server.env` 里的 env 变量，然后 start.sh 里加 python 预处理把它合并进 openclaw.json。这样就不用 ssh-edit，改成 edit server.env → restart 即可。

---

## 🔍 源码锚点

- 插件代码：`docker/plugins/a2a-gateway/index.ts:262` 读 `config.outbound.enabled`（默认 false）
- 日志行：`docker/plugins/a2a-gateway/index.ts:346` 打印 `a2a-gateway: outbound.enabled=${value}`
- docker-user 默认配置：`docker/shared-config.json5` 的 `plugins.entries.a2a-gateway`（没有 outbound key）
