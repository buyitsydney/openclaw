---
name: carher-a2a-topology
description: CarHer A2A hub/spoke 拓扑 + docker 资源配额 fleet 策略。Use when user mentions A2A, hub, spoke, outbound, resource limits, CPU, memory, 资源, 配额.
---

# CarHer A2A 拓扑 + 资源配额 Fleet 策略

## 标准配置（2026-04-30 确认）

### 资源配额（所有 docker 用户容器）

| 维度   | 值       | Mac 特殊                      |
| ------ | -------- | ----------------------------- |
| CPU    | 10 cores | 同                            |
| Memory | 16 GB    | 同                            |
| Swap   | 16 GB    | 32 GB（Mac 可用 swap 更慷慨） |

**适用范围**：所有 `carher-NN` docker 容器（Mac 101-104、S1 13/198/199/200、S3 14/75 等）。

资源限制声明在各用户的 `deploy/carher-{id}/compose.yaml` 里，`docker compose up -d` 时自动应用。

### A2A 拓扑

| 节点                   | 角色    | `outbound.enabled` | 说明                       |
| ---------------------- | ------- | ------------------ | -------------------------- |
| **carher-13** (卜弋天) | **Hub** | `true`             | 可主动 dispatch 到其他 her |
| **carher-198** (admin) | **Hub** | `true`             | admin，可主动 dispatch     |
| **carher-199** (研究2) | **Hub** | `true`             | 研究用 hub                 |
| **carher-200** (研究3) | **Hub** | `true`             | 研究用 hub                 |
| 其他所有 docker 用户   | Spoke   | `false`（默认）    | 只接收任务，不主动发起     |

A2A hub/spoke 由 `config/u<N>.json5` 的 `plugins.entries.a2a-gateway.config.outbound.enabled` 控制。

### A2A 路由环境变量（2026-05-09 事故修复）

每台服务器的 `docker/server.env` 必须声明真实物理主机名和 LAN IP：

```bash
# S1
CARHER_SERVER=S1
CARHER_LAN_IP=10.68.13.186

# S3
CARHER_SERVER=S3
CARHER_LAN_IP=10.68.13.188
REDIS_URL=redis://10.68.13.186:6379
```

`a2a-gateway` 的 Redis registry 里每个 card 都有 `server`、`endpoints.docker`、`endpoints.lan`。同机 peer 用 Docker DNS，跨机 peer 用 LAN endpoint。生产环境绝对不能让 S1/S3 都注册成 `server=local`；那会让 S1 把 S3 的 Her 当成同机容器，错误调用 `http://carher-75:18800/...`，表现为“S1 的 her 找不到 S3 的 her”。当前代码已加兜底：`server=local` 且 LAN 非 loopback 时优先走 LAN，但正确配置仍是显式 `CARHER_SERVER=S1/S3`。

---

## 操作 Playbook

### 1. 提升为 hub

编辑 `config/u<N>.json5`，加入：

```json5
plugins: {
  entries: {
    "a2a-gateway": { config: { outbound: { enabled: true } } },
  },
}
```

然后 commit + push + 服务器 git pull + `docker compose up -d --force-recreate`。

### 2. 降级为 spoke

从 `config/u<N>.json5` 删除 `outbound` 配置，然后同样 commit + push + git pull + recreate。

### 3. 资源调整（live update，无需重启）

```bash
docker update --cpus=10 --memory=16g --memory-swap=16g carher-N
```

**验证**：`docker inspect <c> --format "{{.HostConfig.NanoCpus}} {{.HostConfig.Memory}}"` 应显示 `10000000000 17179869184`。

---

## 注意事项

1. **`docker update` 是 live 的**：资源调整不需要 restart，当场生效。
2. **hub 切换需要 recreate**：因为 a2a-gateway 插件只在启动时读取 `outbound.enabled`。
3. **CARHER_SERVER 切换需要 recreate**：registry card 在插件启动时注册，改 `.env` 后必须 `docker compose up -d --force-recreate`。
4. **Config 变更走 git**：编辑 `config/u<N>.json5` → commit → push → 服务器 git pull → `docker compose up -d --force-recreate`。

---

## 源码锚点

- 插件代码：`docker/plugins/a2a-gateway/index.ts:262` 读 `config.outbound.enabled`（默认 false）
- 日志行：`docker/plugins/a2a-gateway/index.ts:346` 打印 `a2a-gateway: outbound.enabled=${value}`
- Redis registry 路由：`docker/plugins/a2a-gateway/src/registry.ts`
- per-user config：`config/u<N>.json5` 的 `plugins.entries.a2a-gateway`
