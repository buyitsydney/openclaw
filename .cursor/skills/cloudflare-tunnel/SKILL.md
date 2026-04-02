---
name: cloudflare-tunnel
description: Manage the Cloudflare tunnel (cloudflared) used for exposing local services (voice/realtime). Use when the user mentions /voice broken, tunnel down, cloudflared, start-tunnel.sh, or asks about Cloudflare tunnel status.
---

# Cloudflare Tunnel Management

## Architecture

```
飞书用户 → Cloudflare Edge → cloudflared Docker 容器 → host.docker.internal:端口 → 本地 gateway
```

- 隧道名: `carher`
- 容器名: `cloudflared`
- 配置源: `~/.cloudflared/config.yml`（ingress 规则定义域名 → 端口映射）
- 凭证: `~/.cloudflared/<uuid>.json`

## 管理脚本

**唯一正确的管理方式**是 `start-tunnel.sh`（repo 根目录）：

| 命令                          | 作用                     |
| ----------------------------- | ------------------------ |
| `./start-tunnel.sh`           | 启动（已运行则显示状态） |
| `./start-tunnel.sh --restart` | 重启（删容器 + 重建）    |
| `./start-tunnel.sh --down`    | 停止                     |
| `./start-tunnel.sh --logs`    | 查看日志                 |
| `./start-tunnel.sh --status`  | 查看状态                 |

## 关键陷阱：不能用 docker restart

`docker restart cloudflared` **大概率会失败**，因为：

1. 脚本启动时会生成 `/tmp/cloudflared-docker-config.yml`（将 `localhost` 替换为 `host.docker.internal`）
2. macOS 会定期清理 `/tmp`，该文件丢失后容器挂载失败
3. 报错: `error mounting ... not a directory`

**必须用 `./start-tunnel.sh --restart`**，它会重新生成临时配置文件再创建容器。

如果 `--restart` 也报 `/tmp/cloudflared-docker-config.yml: Is a directory`，先清理再重启：

```bash
rm -rf /tmp/cloudflared-docker-config.yml
./start-tunnel.sh --restart
```

## 诊断步骤

1. **检查容器状态**: `docker ps -a --filter name=cloudflared`
2. **查看日志**: `docker logs cloudflared --tail 30`
3. **健康标志**: 日志中出现 `INF Registered tunnel connection` = 正常
4. **故障标志**: 日志中反复出现 `ERR Failed to dial a quic connection` / `timeout: no recent network activity` = 网络不通

## 常见故障

| 现象                                    | 原因                               | 解决                                                                       |
| --------------------------------------- | ---------------------------------- | -------------------------------------------------------------------------- |
| QUIC timeout 反复重试                   | VPN 切换/网络变化导致 UDP 连接断开 | `./start-tunnel.sh --restart`                                              |
| `/tmp` 文件丢失导致 docker restart 失败 | macOS 清理了临时配置               | `rm -rf /tmp/cloudflared-docker-config.yml && ./start-tunnel.sh --restart` |
| `/voice` 链接打不开                     | 隧道未连接到 Cloudflare Edge       | 先看日志确认，再 `--restart`                                               |
| 容器 Up 但实际断连                      | 容器进程在但 QUIC 连接全部失败     | `--restart` 重建容器                                                       |

## 注意事项

- 容器使用 `--restart unless-stopped`，Docker 重启后会自动恢复（但 `/tmp` 文件可能丢失）
- VPN 切换后建议主动 `./start-tunnel.sh --restart`
- `config size exceeds the allowed maximum of 51200 bytes` 警告可忽略，不影响隧道功能
