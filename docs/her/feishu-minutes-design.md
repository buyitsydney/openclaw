# 飞书妙记/会议纪要 — 架构设计

> 状态：**Phase 1&2 已实现，基本生产就绪** | 优先级：P1
> 创建：2026-03-04 | 最后更新：2026-03-05
> Docker 部署：carher-1 (Mac 测试) 已验证通过 | 压测 26 项，25 PASS

---

## 背景

Her 需要**全自动**获取用户每天所有的飞书会议纪要和妙记（Minutes），无需用户手动复制链接。

飞书"妙记"是 AI 生成的会议录音转写 + 智能摘要。飞书 Open API 提供了 `minutes-v1` 系列接口可以读取妙记内容，但有两个核心挑战：

1. **需要 `user_access_token`**（用户身份）：应用身份（`tenant_access_token`）无法访问 minutes API，必须以用户身份调用
2. **无"列出所有妙记"API**：飞书没有 `minutes.list` 接口，必须通过 Drive 搜索间接发现

---

## 已验证的 API 路径

> 以下路径已在 carher-1 容器中通过实际 API 调用验证

### 妙记发现（全自动）

```
用户日历 ──→ 列出视频会议事件
                │
Drive 搜索 ──→ 搜索"智能纪要"docx ──→ 扫描 blocks ──→ 提取 /minutes/obcnXXXX
                                                              │
                                                    minutes-v1 API ──→ 妙记内容
```

具体步骤：

| #   | API                               | Token 类型 | 作用                                               |
| --- | --------------------------------- | ---------- | -------------------------------------------------- |
| 1   | `calendar.v4.calendar.list`       | user       | 获取用户主日历                                     |
| 2   | `calendar.v4.calendarEvent.list`  | user       | 列出带视频会议的日程                               |
| 3   | `suite/docs-api/search/object`    | user       | 搜索"智能纪要"文档                                 |
| 4   | `docx.v1.documentBlock.list`      | tenant     | 扫描智能纪要 docx blocks，提取 `/minutes/obcnXXXX` |
| 5   | `minutes.v1.minute.get`           | user       | 获取妙记元数据（标题、时长、URL）                  |
| 6   | `minutes.v1.minuteTranscript.get` | user       | 获取逐字记录                                       |
| 7   | `docx.v1.document.rawContent`     | tenant     | 读取 AI 智能纪要全文（摘要、结论、行动项）         |

### 验证结果

- 自动发现 **4 个妙记**（包括一个用户未主动搜索的"AI账号采购及落地节奏讨论"会议）
- 全部成功读取标题、时长、逐字记录、AI 摘要

---

## 所需 OAuth Scope

| Scope                               | 用途                                          | 必须 |
| ----------------------------------- | --------------------------------------------- | ---- |
| `minutes:minutes`                   | 读写妙记                                      | ✅   |
| `minutes:minutes:readonly`          | 只读妙记                                      | ✅   |
| `minutes:minutes.basic:read`        | 妙记基本信息                                  | ✅   |
| `minutes:minutes.transcript:export` | 导出逐字记录                                  | ✅   |
| `minutes:minutes.media:export`      | 导出媒体                                      | 可选 |
| `calendar:calendar`                 | 日历读写（meetingMinute.create 需要）         | ✅   |
| `calendar:calendar:readonly`        | 日历只读                                      | ✅   |
| `drive:drive:readonly`              | 搜索用户文档                                  | ✅   |
| `docx:document:readonly`            | 读取智能纪要 docx blocks（提取 minute_token） | ✅   |
| `vc:meeting:readonly`               | 视频会议信息（备用）                          | 可选 |
| `vc:record:readonly`                | 录制信息（备用）                              | 可选 |

> **关键发现**：OAuth authorize URL **必须**在 `scope` 参数中显式声明所需权限。即使应用后台已配置并发布版本，如果 authorize URL 不带 scope 参数，token 不会携带相应权限。

---

## 授权体验设计

### 设计原则

- 用户在**飞书手机/桌面 App 内**完成授权，1-2 次点击
- 不需要用户去创建 webhook、填写 URL、复制 code
- 授权结果有确定性反馈（成功/失败）

### 方案：飞书 Bot 内发起授权

```
用户 ──(飞书对话)──→ Her: "读我的妙记"
                          │
                     Her 检查是否有有效 user_access_token
                          │
                   ┌──────┴──────┐
                   │ 有 token    │ 无 token / 过期
                   │ 直接读取    │     │
                   └─────────────┘     ▼
                              Her 发送飞书消息卡片：
                              ┌─────────────────────┐
                              │ 需要你的授权才能     │
                              │ 读取会议纪要         │
                              │                     │
                              │  [ 点击授权 ]        │
                              └─────────────────────┘
                                       │
                              用户点击（飞书内打开）
                                       │
                              飞书 OAuth 授权页面
                              （显示权限列表，用户确认）
                                       │
                              redirect → Her 的 callback
                                       │
                              Her 自动完成 code→token
                                       │
                              Her 回复飞书消息：
                              "授权成功！正在读取你的妙记..."
```

### callback 端点实现（已实现）

feishu-her 使用 WebSocket 接收消息，没有自己的 HTTP 服务。Gateway HTTP 服务绑定在 loopback（127.0.0.1），Docker 中的 Cloudflare tunnel 无法访问。

**最终方案：独立 OAuth HTTP 服务器**

在 feishu-her 插件中启动独立 HTTP 服务器（`oauth.ts` → `startOAuthServer`），绑定 `0.0.0.0:18891`，仅处理 `/feishu/oauth/callback` 路由。

- 优点：不依赖 Gateway 的 bind mode，Docker tunnel 可直接访问
- Cloudflare tunnel 新增 `auth.carher.net → localhost:18891`
- 端口可通过 `channels.feishu.minutes.oauthPort` 配置，默认 18891

> **曾尝试的方案 A（弃用）**：`api.registerHttpRoute` 注册在 Gateway 的 18789 端口上，但该端口仅绑定 loopback，Docker tunnel 通过 `host.docker.internal` 无法访问。

### redirect_uri 配置

飞书开发者后台 → 安全设置 → 重定向 URL，配置为：

```
https://auth.carher.net/feishu/oauth/callback
```

其中 `auth.carher.net` 通过 Cloudflare tunnel 指向 `localhost:18891`（独立 OAuth 服务器）。

> Docker 容器部署场景：容器内 Gateway 绑定 `0.0.0.0`，可直接使用 `registerHttpRoute`，无需独立服务器。配置 `channels.feishu.minutes.oauthRedirectUri` 为对应域名。

---

## Token 存储与刷新

### 存储位置

```
~/.openclaw/feishu-user-tokens/<open_id>.json
```

```json
{
  "open_id": "ou_a7afacbb81237891a181832ac7a76294",
  "name": "卜弋天",
  "access_token": "u-xxxxx",
  "refresh_token": "ur-xxxxx",
  "access_token_expires_at": 1772620000000,
  "refresh_token_expires_at": 1775200000000,
  "scopes": ["minutes:minutes", "calendar:calendar", "drive:drive:readonly"],
  "created_at": 1772613000000,
  "updated_at": 1772613000000
}
```

### 刷新策略

- `access_token` 有效期 ~2h，过期前 10min 自动刷新
- `refresh_token` 有效期 ~30 天，过期需用户重新授权
- 刷新调用 `authen.v1.refreshAccessToken.create`
- 刷新失败时 bot 主动通知用户重新授权

### Token 生命周期

```
首次授权 ──→ code ──→ access_token + refresh_token
                              │
                    每 ~2h 自动 refresh
                              │
                    refresh_token 30 天后过期
                              │
                    bot 通知用户重新点击授权
```

---

## 工具设计

### 新增工具：`feishu_minutes`

注册在 `extensions/feishu-her/src/tools/minutes.ts`

```typescript
// Schema
{
  action: "list" | "get" | "transcript" | "search",
  // list: 列出用户最近的妙记（通过 drive 搜索 + calendar 事件关联）
  // get: 获取指定妙记的基本信息
  // transcript: 获取指定妙记的逐字记录
  // search: 按关键词搜索妙记
  minute_token?: string,   // get/transcript 需要
  query?: string,          // search 需要
  days?: number,           // list 的时间范围，默认 7
}
```

### action 说明

| action       | 功能                                | 实现路径                                                                |
| ------------ | ----------------------------------- | ----------------------------------------------------------------------- |
| `list`       | 列出最近 N 天的所有妙记             | Drive 搜索"智能纪要" → 提取 minute_token → minute.get                   |
| `get`        | 获取妙记详情（标题、时长、AI 摘要） | minute.get + rawContent 读取智能纪要 docx                               |
| `transcript` | 获取逐字记录                        | minuteTranscript.get                                                    |
| `search`     | 按关键词搜索妙记                    | Drive 搜索 → 匹配"智能纪要"+"文字记录" → 提取 minute_token → minute.get |

### Token 降级策略

```
检查 user_access_token
    │
  有效 ──→ 使用 user token 调用 minutes API
    │
  无效/过期 ──→ 尝试 refresh
                    │
                成功 ──→ 使用新 token
                    │
                失败 ──→ 回复用户：
                        "我需要你的授权才能读取妙记，请点击下方按钮授权"
                        [发送授权卡片]
```

### Skill 更新

在 `extensions/feishu-her/skills/feishu/SKILL.md` 中新增妙记章节：

```markdown
## 妙记/会议纪要

### 能力

- `feishu_minutes list` — 列出最近 N 天所有妙记
- `feishu_minutes get` — 获取妙记详情（标题、时长、AI 摘要、参会人）
- `feishu_minutes transcript` — 获取完整逐字记录
- `feishu_minutes search` — 按关键词搜索妙记

### 前置条件

- 需要用户 OAuth 授权（首次使用时自动引导）
- 授权有效期 30 天，过期后需重新授权

### 限制

- 只能读取用户有权限访问的妙记
- 无法读取未生成 AI 智能纪要的会议
- 逐字记录为纯文本，无法获取音频
```

---

## 实现路径

### Phase 1：OAuth 基础设施

1. **feishu-her OAuth callback 端点**：复用 Cloudflare tunnel，注册 `/feishu/oauth/callback` 路由
2. **Token 存储**：实现 `~/.openclaw/feishu-user-tokens/<open_id>.json` 读写
3. **Token 刷新**：后台定时器，access_token 过期前 10min 刷新
4. **授权卡片**：飞书消息卡片模板，包含授权按钮（URL 跳转到 OAuth authorize）
5. **飞书后台配置**：安全设置中配置 redirect_uri

### Phase 2：feishu_minutes 工具

1. **minutes.ts**：实现 `registerFeishuMinutesTools(api)`
2. **list action**：Drive 搜索 + calendar 事件 + minute.get
3. **get action**：minute.get + 智能纪要 docx rawContent
4. **transcript action**：minuteTranscript.get
5. **search action**：Drive 搜索
6. **注册到 tools/index.ts**

### Phase 3：用户体验优化

1. **自动触发**：用户说"帮我看看今天的会议纪要" → Her 自动调用 `feishu_minutes list`
2. **授权引导**：未授权时自动发送授权卡片，授权后自动继续执行
3. **结果展示**：结构化展示妙记列表（标题、时长、关键词、链接）
4. **定时摘要**：每天定时推送当日会议纪要摘要（可选功能）

---

## 配置

### openclaw.json 新增配置

```json
{
  "channels": {
    "feishu": {
      "minutes": {
        "enabled": true,
        "oauthRedirectUri": "https://auth.carher.net/feishu/oauth/callback",
        "oauthPort": 18891,
        "autoDiscoveryDays": 7,
        "dailySummary": false
      }
    }
  }
}
```

> `oauthRedirectUri` 和 `oauthPort` 均有默认值，个人 Her 无需在配置文件中显式设置。

### 飞书应用后台配置

1. **权限配置**：勾选所有 `minutes:*`、`calendar:*`、`drive:drive:readonly`、`docx:document:readonly` 权限（应用身份 + 用户身份都要勾）
2. **安全设置**：重定向 URL 需要配置所有部署实例的 callback URL：
   - 个人 Her：`https://auth.carher.net/feishu/oauth/callback`
   - Docker user 1：`https://u1-auth.carher.net/feishu/oauth/callback`
   - Docker user 2：`https://vendor-auth.carher.net/feishu/oauth/callback`
   - 其他用户：`https://uN-auth.carher.net/feishu/oauth/callback`
3. **发布版本**：每次修改权限后需创建新版本并发布

### Docker 容器部署（2026-03-05 已实现）

每个 Docker 容器有独立的 OAuth 回调域名和端口：

| 组件         | 端口偏移   | 容器端口  | 宿主机端口示例 (user 1) |
| ------------ | ---------- | --------- | ----------------------- |
| Gateway      | base+1     | 18789     | 29001                   |
| RT WebSocket | base+2     | (内部)    | -                       |
| Frontend     | base+3     | 8000      | 29003                   |
| WS Proxy     | base+4     | 8080      | 29004                   |
| **OAuth**    | **base+5** | **18891** | **29005**               |

`start-user.sh` 自动注入 `channels.feishu.minutes.oauthRedirectUri`。
`generate-tunnel-config.sh` 自动生成 `uN-auth.carher.net` tunnel 入口规则。

---

## 关键发现与踩坑记录

### 1. OAuth scope 必须在 authorize URL 中显式声明

飞书 OAuth 机制：即使应用后台配好了权限并发布版本，如果 `authorize` URL 里不写 `scope` 参数，发放的 `user_access_token` **不携带**对应权限。

```
# 错误（不带 scope）
https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=xxx&redirect_uri=xxx

# 正确（显式声明 scope）
https://accounts.feishu.cn/open-apis/authen/v1/authorize?client_id=xxx&redirect_uri=xxx&scope=minutes:minutes%20calendar:calendar%20drive:drive:readonly
```

### 2. 飞书没有"列出所有妙记" API

`minutes-v1` 只有 get/statistics/transcript/media 四个接口，没有 list。必须通过 Drive 搜索 `suite/docs-api/search/object` 间接发现"智能纪要"文档，再从文档 blocks 中提取 `/minutes/obcnXXXX` 链接。

### 3. 飞书为每个会议自动生成三种文档

| 文档         | 来源                                | 标题示例                              | 包含妙记链接               | 内容             |
| ------------ | ----------------------------------- | ------------------------------------- | -------------------------- | ---------------- |
| 模板纪要     | `calendarEventMeetingMinute.create` | "2026年3月4日 测试飞书纪要会议纪要"   | ❌                         | 模板结构         |
| 智能纪要     | AI 自动生成                         | "智能纪要：测试飞书纪要 2026年3月4日" | ✅ `/minutes/obcnXXXX`     | AI 摘要          |
| **文字记录** | AI 自动生成                         | "文字记录：测试飞书纪要 2026年3月4日" | ❌（有指向智能纪要的链接） | **完整转写全文** |

**关键发现（2026-03-05 验证）**：

- "文字记录" docx 包含会议的**完整逐字转写**（发言人 + 时间戳 + 文字）
- Drive search API 是**全文搜索**，能搜到文字记录中的任意词汇
- "文字记录" blocks 中包含指向对应"智能纪要"的 docx URL，形成 1:1 映射
- 只有"智能纪要"docx 包含 minute_token 链接

### 4. VC Meeting API 不可靠

`vc.v1.meeting.listByNo` 对所有测试会议号返回 0 结果，原因不明。不应依赖此 API 做妙记发现。

### 5. tenant_access_token 无法调用 minutes API

minutes-v1 API 要求 `user_access_token`。用 `tenant_access_token` 调用会返回 `2091005 permission deny`。但智能纪要 docx 本身可以用 `tenant_access_token` 读取（包含了 AI 摘要、逐字记录链接等完整内容）。

### 6. meetingMinute.create 需要日历写权限

`calendarEventMeetingMinute.create` 需要 `calendar:calendar`（写权限），`calendar:calendar:readonly` 不够。

### 7. Drive 搜索 API 不返回 create_time

`suite/docs-api/search/object` 返回的字段只有 `docs_token`、`docs_type`、`owner_id`、`title`，不包含 `create_time`、`update_time` 等时间字段。时间过滤需要从标题中解析日期（"智能纪要：XXX 2026年3月4日"）。

### 8. Gateway loopback 与 Docker tunnel 不兼容

个人 Her 的 Gateway 默认绑定 loopback（`127.0.0.1:18789`），Docker 中的 Cloudflare tunnel 通过 `host.docker.internal`（映射到 `192.168.65.254`）无法访问 loopback 端口。OAuth callback 必须使用绑定 `0.0.0.0` 的独立 HTTP 服务器。

---

## 压测结果（2026-03-05，docker1 carher-1）

26 项测试，25 PASS，1 小问题。4 个 action 全部功能正常，OAuth 流程完整。

### 已知问题（低优先级）

| #   | 问题                                                                              | 严重度 | 状态                            |
| --- | --------------------------------------------------------------------------------- | ------ | ------------------------------- |
| 1   | transcript 传无效 token 返回假正常而非 error                                      | 低     | TODO                            |
| 2   | search 产生大量 404 warning（非 docx 文档被 Drive search 返回后扫描 blocks 失败） | 低     | TODO                            |
| 3   | **search 只搜标题/AI摘要，不搜转写全文**                                          | **高** | **TODO — 需搜索"文字记录"docx** |

### Issue 3 分析（search 全文搜索）

**现状**：`searchMinutes()` 用用户关键词调 Drive search，但只匹配 "智能纪要" docx（AI 摘要）。如果关键词仅出现在转写全文中（如 "cursor"、"一蹴而就"），搜不到。

**根因**：飞书 Drive search 是全文搜索（已验证），但搜到 "文字记录" docx 后，当前代码用 `extractMinuteTokensFromDoc()` 尝试从中提取 `/minutes/` 链接 → 文字记录中没有 minutes 链接 → 404 或空结果。

**验证数据（docker1）**：

| 搜索词     | 智能纪要匹配 | 文字记录匹配 | 当前 search 能找到？   |
| ---------- | ------------ | ------------ | ---------------------- |
| "KPI"      | ✅           | ✅           | ✅（恰好在 AI 摘要中） |
| "西川"     | ✅           | ✅           | ✅                     |
| "cursor"   | ❌           | ✅           | ❌                     |
| "一蹴而就" | ❌           | ✅           | ❌                     |

**修复方案**：搜索结果如果是 "文字记录" docx → 从 blocks 提取链接的 "智能纪要" docx token → 再从 "智能纪要" 提取 minutes token。

关联链：`用户搜索 → 文字记录 docx → blocks 中的智能纪要 URL → 智能纪要 docx → /minutes/obcnXXXX`

---

## TODO

- [x] Phase 1：OAuth 基础设施
  - [x] 独立 OAuth HTTP 服务器 `startOAuthServer`（`0.0.0.0:18891`）
  - [x] OAuth callback handler（code → token 交换）— `oauth.ts`
  - [x] Token 持久化存储 — `~/.openclaw/feishu-user-tokens/<open_id>.json`
  - [x] Token 自动刷新（refresh_token → new access_token）
  - [x] OAuth state 管理（CSRF 防护）
  - [x] Cloudflare tunnel 配置 `auth.carher.net → localhost:18891`
  - [x] 飞书应用后台配置 redirect_uri
- [x] Phase 2：feishu_minutes 工具
  - [x] 新建 `extensions/feishu-her/src/tools/minutes.ts`
  - [x] list action（Drive 搜索"智能纪要" + 标题日期过滤 + extractMinuteTokens + minute.get）
  - [x] get action（minute.get + 智能纪要 docx rawContent）
  - [x] transcript action（minuteTranscript.get）
  - [x] search action（Drive 搜索 + minute.get）
  - [x] 注册到 `tools/index.ts`
  - [x] 更新 `skills/feishu/SKILL.md`
- [x] Phase 2.5：Docker 容器部署
  - [x] `start-user.sh` 新增 PORT_OAUTH 计算 + docker run -p 映射
  - [x] `start-user.sh` Python 配置注入 `oauthRedirectUri`
  - [x] `generate-tunnel-config.sh` 新增 `uN-auth.carher.net` 隧道入口
  - [x] carher-1 (Mac 测试) 端到端验证通过
- [ ] Phase 3：search 全文搜索升级
  - [ ] search 结果中识别 "文字记录" docx
  - [ ] 从 "文字记录" blocks 提取链接的 "智能纪要" docx token
  - [ ] 通过 "智能纪要" 间接获取 minute_token
  - [ ] 过滤非 docx 文档避免无效 404 warning
- [ ] Phase 4：体验优化
  - [ ] transcript 无效 token 返回 error 而非静默
  - [ ] 授权后自动继续执行用户请求
  - [ ] 结构化展示妙记列表
  - [ ] refresh_token 过期提前通知
  - [ ] 每日会议纪要自动摘要（可选）
