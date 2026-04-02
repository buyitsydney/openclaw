# Her 账号系统

本文档说明 Her 系统如何管理 AI 模型认证，以及如何在 Claude Max（setup-token）和 OpenRouter 之间切换。

---

## 核心机制

Her 系统支持两种 AI 认证方式：

| 方式                          | 适用场景                                 | 费用                          |
| ----------------------------- | ---------------------------------------- | ----------------------------- |
| **Claude Max（setup-token）** | 个人 Mac 开发/使用，拥有 Claude Max 订阅 | $200/月 订阅，无额外 token 费 |
| **OpenRouter**                | 企业服务器部署，或按量计费               | 按 token 计费                 |

**切换方式 = 只改 `~/.openclaw/openclaw.json` 中的 `model.primary` 一个字段。**

两个 token（`ANTHROPIC_OAUTH_TOKEN` 和 `OPENROUTER_API_KEY`）始终预填在 `env.vars` 里，不需要来回增删。

---

## 认证解析规则

OpenClaw 根据 `model.primary` 的 provider 前缀自动选择认证来源：

- `anthropic/...` 前缀 → 本地 Her 走 `auth-profiles.json` 中的 setup-token；Docker 容器走 `ANTHROPIC_OAUTH_TOKEN` 环境变量
- `openrouter/...` 前缀 → 使用 `OPENROUTER_API_KEY` 环境变量

`start-user.sh` 从 `docker/users.csv` 的 `provider` 列读取每用户的 provider（`anthropic` 或 `openrouter`，留空默认 `openrouter`），Docker 容器的模型短名（`opus`、`sonnet`）随之解析到正确的 provider 路径。

---

## 文件存储位置

| 文件                  | 位置                                               | 入库 | 说明                                                             |
| --------------------- | -------------------------------------------------- | ---- | ---------------------------------------------------------------- |
| `openclaw.json`       | `~/.openclaw/openclaw.json`                        | 否   | 本机主配置，含模型、env.vars、**anthropic provider 显示名**      |
| `auth-profiles.json`  | `~/.openclaw/agents/main/agent/auth-profiles.json` | 否   | 本地 Her 的 setup-token 存储（不在 git，不需要手动管理）         |
| `carher-config.json`  | `docker/carher-config.json`                        | 是   | Docker 容器基础配置，含 openrouter/**anthropic provider 显示名** |
| `users.csv`           | `docker/users.csv`                                 | 否   | Docker 容器用户表（含模型、provider、飞书凭证）                  |
| `shared-config.json5` | `docker/shared-config.json5`                       | 是   | 所有环境共享的功能配置（**不放 provider 定义**）                 |

> **注意**：`models.providers.anthropic` 显示名需在两处各写一份——`~/.openclaw/openclaw.json`（本地 Her）和 `docker/carher-config.json`（Docker 容器）。`$include` 的 merge 不支持跨文件深度合并 `models.providers`，放在 `shared-config.json5` 会被本地 overlay 覆盖导致丢失。

---

## 切换方式

编辑 `~/.openclaw/openclaw.json` 的 `agents.defaults.model.primary`：

```json5
// Claude Max（setup-token）
"model": { "primary": "anthropic/claude-opus-4-6" }

// OpenRouter
"model": { "primary": "openrouter/anthropic/claude-opus-4.6" }
```

重启本地 gateway（OpenClaw 菜单栏 → Restart），然后重启需要切换的 Docker 容器：

```bash
./start-user.sh --id=1 --down && ./start-user.sh --id=1
```

---

## `~/.openclaw/openclaw.json` env.vars 说明

```json5
{
  env: {
    vars: {
      // 切换 provider 时改 model.primary，两个 token 始终保留，不需要删
      OPENROUTER_API_KEY: "sk-or-...",
      GROQ_API_KEY: "gsk_...",
      ANTHROPIC_OAUTH_TOKEN: "sk-ant-oat01-...", // Claude Max setup-token
    },
  },
}
```

- `OPENROUTER_API_KEY` 和 `ANTHROPIC_OAUTH_TOKEN` 同时存在没有冲突，OpenClaw 根据 `model.primary` 的前缀决定用哪个
- `start-user.sh` 会把 `env.vars` 里的所有 key 自动注入 Docker 容器

---

## 模型短名解析规则

`start-user.sh` 从 `docker/users.csv` 的 `provider` 列读取 provider，短名解析规则如下：

| 短名                    | `anthropic` provider          | `openrouter` provider（默认）            |
| ----------------------- | ----------------------------- | ---------------------------------------- |
| `opus` / `opus-4.6`     | `anthropic/claude-opus-4-6`   | `openrouter/anthropic/claude-opus-4.6`   |
| `sonnet` / `sonnet-4.6` | `anthropic/claude-sonnet-4-6` | `openrouter/anthropic/claude-sonnet-4.6` |
| `haiku` / `haiku-3.5`   | `openrouter/...`（始终）      | `openrouter/...`（始终）                 |
| `gemini-*` / `gpt-*`    | `openrouter/...`（始终）      | `openrouter/...`（始终）                 |
| 完整路径                | 原样透传                      | 原样透传                                 |

每个 Docker 容器的白名单同时包含两个 provider 的模型，支持 `/model` 动态切换：

| 别名        | 含义                      |
| ----------- | ------------------------- |
| `opus`      | 默认 provider 的 Opus     |
| `sonnet`    | 默认 provider 的 Sonnet   |
| `or-opus`   | 另一个 provider 的 Opus   |
| `or-sonnet` | 另一个 provider 的 Sonnet |

---

## 初始化 setup-token（首次配置）

### 1. 获取 setup-token

```bash
claude setup-token
```

### 2. 写入 auth-profiles（本地 Her 专用，做一次就够）

```bash
pnpm openclaw models auth paste-token --provider anthropic
```

验证：

```bash
pnpm openclaw models status
# 应看到：anthropic:manual=token:sk-ant-o...  static
```

### 3. 将 token 加入 `openclaw.json` 的 `env.vars`

把 `claude setup-token` 输出的 token 填入 `ANTHROPIC_OAUTH_TOKEN`。Docker 容器通过此 env var 使用 Claude Max，无需 `auth-profiles.json`。

---

## 企业服务器部署

企业服务器通过 git clone 部署，`~/.openclaw/openclaw.json` 在服务器本地创建（不入库），只写 OpenRouter：

```json5
{
  $include: "docker/shared-config.json5",
  env: {
    vars: {
      OPENROUTER_API_KEY: "sk-or-...",
      GROQ_API_KEY: "gsk_...",
      // 不需要 ANTHROPIC_OAUTH_TOKEN
    },
  },
  agents: {
    defaults: {
      model: { primary: "openrouter/anthropic/claude-opus-4.6" },
    },
  },
  // ... feishu、gateway 等其他配置
}
```

`model.primary` 为 `openrouter/` 前缀 → 所有 Docker 容器自动走 OpenRouter，与 Mac 本地配置完全隔离。

---

## 故障排查

**setup-token 过期（`OAuth token refresh failed`）**

```bash
claude setup-token          # 重新生成
pnpm openclaw models auth paste-token --provider anthropic
```

同时更新 `openclaw.json` 中的 `ANTHROPIC_OAUTH_TOKEN` 字段，重启 Docker 容器使新 token 生效。

**确认当前使用的认证**

```bash
pnpm openclaw models status
# anthropic 模式：anthropic:manual=token:sk-ant-o...  static
# openrouter 模式：openrouter effective=env:sk-or-v1...
```
