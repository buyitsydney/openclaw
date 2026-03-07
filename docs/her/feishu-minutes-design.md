# 飞书妙记/会议纪要 — 架构设计

> 状态：**Phase 7 最终结论 — 飞书平台 API 限制确认** | Phase 1-6 已实现 | 优先级：P1
> 创建：2026-03-04 | 最后更新：2026-03-07
>
> ### Phase 7 — 飞书平台 API 限制最终确认（2026-03-07）
>
> **结论：飞书开放平台不存在任何 API 能 100% 自动发现用户的所有智能纪要。这是平台能力缺失，不是权限或代码问题。**
>
> #### 已验证并排除的全部路径（10 条）
>
> | #   | 路径                                 | 结果                       | 根因                                                   |
> | --- | ------------------------------------ | -------------------------- | ------------------------------------------------------ |
> | 1   | `minutes/v1/minutes/list`            | 不存在                     | 飞书没有提供列表 API                                   |
> | 2   | IM 读智能纪要助手消息 (user_token)   | 230001 / 231204            | user_access_token 不支持读取系统 bot 消息              |
> | 3   | IM 读智能纪要助手消息 (tenant_token) | 230002                     | Bot 不在智能纪要助手 P2P 聊天中                        |
> | 4   | 转发智能纪要助手消息                 | 99991668 / 230002          | forward API 不支持 user_token，tenant_token 不在源聊天 |
> | 5   | Drive Search                         | 只返回用户在 UI 中打开过的 | 飞书索引机制限制（API 读取不触发索引）                 |
> | 6   | 会议结束事件 → doc_token             | 无映射                     | meeting_id 无法转换为 doc_token，无此 API              |
> | 7   | 飞书 Flow / Aily 自动化转发          | 不支持                     | 无 "P2P bot 消息" 触发器                               |
> | 8   | 飞书多维表格自动化                   | 不支持                     | bot 消息不触发 receive 事件                            |
> | 9   | VC 录制 → minute_token               | 不可靠                     | 不开录制也有纪要（飞书官方确认）                       |
> | 10  | drive 共享/最近文件/list API         | 不存在                     | 飞书没有 "shared with me" 列表 API                     |
>
> #### 关键发现：智能纪要助手消息是 100% 可靠的信号源
>
> 用户截图确认：**每篇智能纪要生成后，"智能纪要助手"机器人都会发送消息卡片**（含 docx 链接）。
> `search/v2/message` 能搜到 20+ 条此类消息 ID，但受两道 API 限制无法读取内容：
>
> - `im/v1/messages/{id}` GET → 230001 "this operation to bots is currently not supported"
> - `im/v1/messages` LIST → 231204 "b2c/b2b app not support"（即使是企业自建应用）
>
> #### 录制与智能纪要的关系（官方确认）
>
> **不开录制也能生成智能纪要**。飞书通过实时语音转文字生成妙记和智能纪要，录制是可选的。
> 因此 `vc/v1/meetings/{id}/recording` API 根本不适合做智能纪要发现。
>
> #### 当前最优方案
>
> 1. **Drive Search** 是唯一可用的发现路径。用户在飞书 UI 中打开过的纪要 100% 可被发现和读取。
> 2. **bug 修复**（Phase 6.1）：修复了 `extractMinuteTokensFromDoc` 异常导致文档丢失的两个 bug，确保所有已索引文档不会被静默丢弃。
> 3. **docker13 实测 10/10**：用户点开所有纪要后，Drive Search 返回全部 10 篇智能纪要。
>
> #### 如需未来实现 100% 自动发现
>
> 需等待飞书开放以下任一能力（不在我们控制范围内）：
>
> - `minutes/v1/minutes/list` 列出用户所有妙记的 API
> - IM API 支持读取系统 bot（智能纪要助手）的 P2P 消息
> - 全局事件 "智能纪要已生成" 推送（含 doc_token）
>
> ### Phase 6 — Drive Search 索引根因确认（2026-03-07）
>
> **确定性规律（已实验验证，非推测）：**
>
> 1. **Drive Search 只索引用户在飞书 UI 中"打开过"的智能纪要 docx**。即使用户作为参与者有权限，未访问过的 docx 不会出现在 Drive Search 结果中。
> 2. **通过 API（rawContent）读取 docx 不触发索引**。实验：用 API 读取 2 篇未访问 docx 后等 30 秒，Drive Search 仍为 0。
> 3. **用户在飞书浏览器中点开 docx 后，Drive Search 立即可搜到**。实验：cursor+figma 点开前搜不到，点开后立刻搜到。
> 4. **内容始终可读**：只要知道 doc_token，`docx.rawContent` 可以读取任何用户有参与者权限的 docx，不受索引限制。
> 5. **问题本质是 discovery（发现 doc_token），不是 access（读取内容）**。
>
> **docker13 实测时间线：**
>
> - 用户点击前：Drive path found **6** minutes
> - 用户在飞书 App 点击几篇后：Drive path found **8** minutes（+2）
> - 用户点击全部后：Drive path found **10** minutes = **100%**
> - Calendar path 始终贡献 0（recording API 对所有会议返回 121005/121004）
>
> ### 飞书三层对象模型（官方文档确认）
>
> | 层级        | 对象           | URL 格式           | 标识符                     | 说明                                    |
> | ----------- | -------------- | ------------------ | -------------------------- | --------------------------------------- |
> | 1. VC 会议  | 视频会议实例   | 无固定页面         | `meeting_id`, `meeting_no` | 实际的视频通话                          |
> | 2. 妙记     | 录音/录像+转写 | `/minutes/obcnXXX` | `minute_token` (24字符)    | 音视频播放+逐字转写（不需录制也可生成） |
> | 3. 智能纪要 | AI 生成的 docx | `/docx/XXX`        | `doc_token`                | 结构化 AI 总结文档                      |
>
> 关系：会议结束 → 飞书自动生成"妙记"（实时转写，无需录制）→"智能纪要助手"自动生成 docx 存入**组织者 Drive 空间**，
> 并把"会议参与者"加为 docx 协作者。minute_token 和 doc_token 是**不同标识符**，无公开 API 互转。

---

## 背景

Her 需要**全自动**获取用户每天所有的飞书会议纪要和妙记（Minutes），无需用户手动复制链接。

飞书"妙记"是 AI 生成的会议录音转写 + 智能摘要。飞书 Open API 提供了 `minutes-v1` 系列接口可以读取妙记内容，但有三个核心挑战：

1. **需要 `user_access_token`**（用户身份）：应用身份（`tenant_access_token`）无法访问 minutes API，必须以用户身份调用
2. **无"列出所有妙记"API**：飞书没有 `minutes.list` 接口，必须通过 Drive 搜索或 VC API 间接发现
3. **Drive Search 覆盖不全**：只能找到用户云空间中的文档，别人组织的会议纪要可能不在用户 Drive 中（但在"妙记"产品中可见）

---

## Phase 6 诊断结果（2026-03-07 docker13 实测，确定性结论）

### 根因：Drive Search 索引 = 用户 UI 访问记录

| 问题                  | 根因                                                                              | 状态        |
| --------------------- | --------------------------------------------------------------------------------- | ----------- |
| Drive Search 覆盖不全 | **Drive Search 只对"用户在飞书 UI 中打开过"的 docx 建索引**。API 读取不触发索引。 | ✅ 根因确认 |
| Calendar 路径 0 贡献  | VC recording API 对所有会议返回 121005(no permission) 或 121004(data not exist)   | 已知限制    |
| 内容可读但不可发现    | `docx.rawContent` 可以读取任何有参与者权限的 docx，不受索引限制                   | ✅ 已验证   |

### 实验证据

| 实验                         | 操作                       | 结果                                                           |
| ---------------------------- | -------------------------- | -------------------------------------------------------------- |
| cursor+figma                 | 用户在飞书 App 点开        | Drive Search **立刻搜到** (token=BMqTdWH8Mo8RykxW0EOcrxBOn8c)  |
| 新产品试点推广               | 仅通过 API rawContent 读取 | Drive Search **仍然搜不到** (等 30 秒后验证)                   |
| 系统权限架构分工             | 仅通过 API rawContent 读取 | Drive Search **仍然搜不到** (等 30 秒后验证)                   |
| 网宿科技交流 vs cursor+figma | 同为史晓杰创建             | 权限对比：网宿有"弋天的her [应用] - 可阅读"，cursor+figma 没有 |

### 权限对比铁证（截图确认）

| 权限项               | cursor+figma（搜不到） | 网宿科技交流（搜到） |
| -------------------- | ---------------------- | -------------------- |
| 所有者               | 史晓杰                 | 史晓杰               |
| 参与者权限           | 可编辑                 | 可编辑               |
| **弋天的her [应用]** | **没有**               | **可阅读**           |

### 全量实测数据（docker13, user=卜弋天, 2026-03-07）

| 会议                     | 飞书 UI 可见 | Drive Search | rawContent | doc_token                   | 发现途径     |
| ------------------------ | ------------ | ------------ | ---------- | --------------------------- | ------------ |
| NIO AI合作分工讨论 3/7   | ✅           | 待验证       | 待验证     | 待获取                      | 今天新会议   |
| Her 供应商切换测试 3/6   | ✅           | ✅           | ✅         | C1SOdl81VoB7lsxXgQjctzT9noh | Drive        |
| cursor+figma+MCP 3/4     | ✅           | ✅ (点开后)  | ✅ 970字   | BMqTdWH8Mo8RykxW0EOcrxBOn8c | 用户 UI 点开 |
| 新产品试点推广 3/4       | ✅           | **❌**       | ✅ 1198字  | MHVPdb7Ujos7Xbx4az7chr1dnWd | 需用户点开   |
| her接入aily 3/1          | ✅           | ✅           | ✅ 1949字  | HW6BdfX0poo338xJrhncejdHnnh | Drive        |
| 系统权限架构分工 3/1     | ✅           | **❌**       | ✅ 3423字  | Tamxd7X7aolgOfxX3MycqgX7nFb | 需用户点开   |
| AI项目合作及后续工作 3/1 | ✅           | ✅           | ✅         | U4hpdcYYvo19ZtxkjvbcjdS3nhf | Drive        |
| 网宿科技交流 2/28        | ✅           | ✅           | ✅ 4532字  | U8nAdaxWTovqUux1d63cO2Q2nP6 | Drive        |
| 年会报告预演彩排 2/28    | ✅           | ✅           | ✅ 13087字 | LEImd7i5Lo8aRwx6fABc419Zn6b | Drive        |
| AI立项材料预评审 2/27    | ✅           | ✅           | ✅ 1574字  | WWo4dXBKIoSSIrxMrkKcKBtfnRc | Drive        |

**2026-03-07 最终验证：用户在飞书 App 点开所有纪要后，Drive Search 10/10 = 100% 覆盖。**

当前代码可实现 100% 发现，前提是用户在飞书 UI 中"打开过"每篇纪要。

**Phase 6.1 Bug 修复**（2026-03-07）：

- `listMinutes` 中 `extractMinuteTokensFromDoc` 异常时文档被静默丢弃 → 修复为添加 `docxFallbackInfo`
- `searchMinutes` 中 `extractMinuteTokensFromDoc` 无 try-catch → 修复为捕获异常继续执行
- 修复后 Her 报告 10/10（修复前为 8/10，2 篇被 403/404 异常丢弃）

**Phase 7 结论**（2026-03-07）：
飞书开放平台 API 无法 100% 自动发现所有智能纪要（详见上方 Phase 7 最终结论）。
`drive.file.permission_member_added_v1` 事件订阅已排除——仅限单文件订阅且需预知 file_token，无法全局监听。

---

## 已验证的 API 路径

> 以下路径已在 carher-1 容器中通过实际 API 调用验证

### 妙记发现（当前：Drive Search 路径）

```
Drive 搜索 ──→ 搜索"智能纪要"docx ──→ docx.rawContent ──→ AI 摘要全文
                                    ├──→ 扫描 blocks ──→ 提取 obcn（可选，部分 docx 没有）
                                    │                         │
                                    │               minutes-v1 API ──→ 元数据/逐字记录（可选）
```

### 妙记发现（目标：VC 会议路径，需要 vc:\* 权限）

```
VC export meeting_list ──→ 发现所有参与的会议
                               │
VC meetings/{id}/recording ──→ 录制 URL (https://.../minutes/obcnXXXX)
                                     │
                           minutes-v1 API ──→ 元数据 + 逐字记录
```

### API 步骤

| #   | API                               | Token 类型 | 作用                                          | 需要的 scope                                       |
| --- | --------------------------------- | ---------- | --------------------------------------------- | -------------------------------------------------- |
| 1   | `suite/docs-api/search/object`    | user       | 搜索"智能纪要"/"文字记录"文档                 | `drive:drive.search:readonly` + `search:docs:read` |
| 2   | `docx.v1.document.rawContent`     | user       | **直接读取 AI 摘要全文**（核心路径）          | `docx:document:readonly`                           |
| 3   | `docx.v1.documentBlock.list`      | user       | 扫描 blocks 提取 obcn 链接（可选）            | `docx:document:readonly`                           |
| 4   | `minutes.v1.minute.get`           | user       | 获取元数据：标题、时长、URL（可选，可能 403） | `minutes:minutes:readonly`                         |
| 5   | `minutes.v1.minuteTranscript.get` | user       | 获取逐字记录                                  | `minutes:minutes.transcript:export`                |
| 6   | `vc/v1/exports/meeting_list`      | user       | **导出用户参与的所有会议**（Phase 5 目标）    | `vc:export`                                        |
| 7   | `vc/v1/meetings/{id}/recording`   | user       | 获取录制 URL → 提取 minute_token              | `vc:meeting:readonly`                              |

### 所需 OAuth Scope（完整列表，17 个）

```
minutes:minutes, minutes:minutes:readonly, minutes:minutes.basic:read, minutes:minutes.transcript:export,
calendar:calendar, calendar:calendar:readonly,
drive:drive:readonly, drive:drive.search:readonly, docx:document:readonly,
search:docs:read, search:message,
vc:meeting:readonly, vc:record:readonly, vc:export, vc:room:readonly
```

### 飞书 App 后台权限配置（用户身份 + 应用身份都要勾）

| 权限名称                  | scope 标识                          | Phase 1-3 有? | Phase 4 新增?  |
| ------------------------- | ----------------------------------- | ------------- | -------------- |
| 读取妙记                  | `minutes:minutes`                   | ✅            |                |
| 只读妙记                  | `minutes:minutes:readonly`          | ✅            |                |
| 读取妙记基本信息          | `minutes:minutes.basic:read`        | ✅            |                |
| 导出妙记逐字记录          | `minutes:minutes.transcript:export` | ✅            |                |
| 日历读写                  | `calendar:calendar`                 | ✅            |                |
| 日历只读                  | `calendar:calendar:readonly`        | ✅            |                |
| 读取云空间                | `drive:drive:readonly`              | ✅            |                |
| **搜索云文档**            | `drive:drive.search:readonly`       | **❌**        | **✅ 新增**    |
| 读取文档                  | `docx:document:readonly`            | ✅            |                |
| **搜索云文档(Wiki+文档)** | `search:docs:read`                  | **❌**        | **✅ 新增**    |
| **搜索消息**              | `search:message`                    | **❌**        | **✅ 新增**    |
| **视频会议只读**          | `vc:meeting:readonly`               | **❌**        | **✅ Phase 4** |
| **录制信息只读**          | `vc:record:readonly`                | **❌**        | **✅ Phase 5** |
| **导出会议数据**          | `vc:export`                         | **❌**        | **✅ Phase 4** |
| **会议室信息**            | `vc:room:readonly`                  | **❌**        | **✅ Phase 4** |

### 验证结果

- Phase 1-3: 自动发现 **4 个妙记**（carher-1 实测）
- Phase 4 代码修复后: Drive Search 找到的 **4/4 个妙记全部可读取 AI 摘要**
- 待 VC 权限验证: 目标覆盖飞书 App "我参与的"列表中的全部会议

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
| `vc:meeting:readonly`               | 通过会议号查 meeting_id                       | ✅   |
| `vc:record:readonly`                | 读取录制 URL（含 minute_token）               | ✅   |

> **关键发现**：OAuth authorize URL **必须**在 `scope` 参数中显式声明所需权限。即使应用后台已配置并发布版本，如果 authorize URL 不带 scope 参数，token 不会携带相应权限。
>
> 2026-03-06 docker1 实测：以上 user scope 已足够打通 `search -> 文字记录 -> 智能纪要 -> minute -> transcript` 全链路，**无需新增额外 user scope**。

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

| action       | 功能                                | 实现路径                                                                              |
| ------------ | ----------------------------------- | ------------------------------------------------------------------------------------- |
| `list`       | 列出最近 N 天的所有妙记             | Drive 搜索"智能纪要" → 提取 minute_token → minute.get                                 |
| `get`        | 获取妙记详情（标题、时长、AI 摘要） | minute.get + rawContent 读取智能纪要 docx                                             |
| `transcript` | 获取逐字记录                        | minuteTranscript.get                                                                  |
| `search`     | 按关键词搜索妙记（含内容）          | Drive 全文搜索 → 匹配"智能纪要"+"文字记录" → 提取 minute_token → minute.get + AI 总结 |

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

### 7. 飞书没有"搜索妙记内容"的一体化 API（2026-03-05 调查确认）

飞书所有搜索 API 都**只返回元数据，不返回内容片段**：

| API                                                 | 返回字段                                       | 返回内容/snippet？ |
| --------------------------------------------------- | ---------------------------------------------- | ------------------ |
| `suite/docs-api/search/object`（老版 Drive Search） | `docs_token`, `docs_type`, `title`, `owner_id` | ❌                 |
| `wiki/v1/nodes/search`（Wiki Search）               | `node_id`, `title`, `url`, `icon`              | ❌                 |
| `search-v2/message/create`（消息搜索）              | `items` (message_id[])                         | ❌                 |
| `search-v2/doc_wiki/search`（新版文档搜索）         | SDK 不包含此资源，文档页面也未见 snippet 字段  | ❌                 |

**结论**：飞书 Drive search 是服务端全文搜索（能匹配文档正文内容），但只告诉"哪些文档匹配了"，不告诉"匹配了什么内容"。如需获取内容，必须额外调用 `docx.rawContent` 或 `minuteTranscript.get`。

2026-03-06 官方/API 实测补充：

- 飞书 App 搜索 `cursor`（云文档）和公开 API `search/object` 都能命中同一条"文字记录" docx，说明两者共享同类全文索引能力
- 但公开 API 不返回 snippet/highlight，也不保证与飞书 App 相同排序
- `docs_types: [22]` 仍可能返回 `bitable`，不能信任服务端过滤，必须本地再过滤 `docs_type` 和标题前缀
- `minuteTranscript.get` 只有 `need_speaker`、`need_timestamp`、`file_format` 三个参数，返回二进制流，不支持按时间/字数范围读取

这意味着 `feishu_minutes search` 要想既"找得到"又"解释得清"，必须主动拉取 AI 总结，并在命中"文字记录"时从该 docx 原文中切出 transcript snippet。

### 8. Drive 搜索 API 不返回 create_time

`suite/docs-api/search/object` 返回的字段只有 `docs_token`、`docs_type`、`owner_id`、`title`，不包含 `create_time`、`update_time` 等时间字段。时间过滤需要从标题中解析日期（"智能纪要：XXX 2026年3月4日"）。

### 9. Gateway loopback 与 Docker tunnel 不兼容

个人 Her 的 Gateway 默认绑定 loopback（`127.0.0.1:18789`），Docker 中的 Cloudflare tunnel 通过 `host.docker.internal`（映射到 `192.168.65.254`）无法访问 loopback 端口。OAuth callback 必须使用绑定 `0.0.0.0` 的独立 HTTP 服务器。

---

## 压测结果（2026-03-05，docker1 carher-1）

Docker1 工具层全量回归：4 action × 全场景 + search 11 场景 = **100% PASS**（仅工具层，不含最新自然语言路由回归）。

### Phase 3 search 全文搜索（已实现）

飞书为每个会议生成 "文字记录" docx（完整转写全文），Drive search 是全文搜索。
搜索结果如果是 "文字记录" docx → 从 blocks 提取链接的 "智能纪要" docx token → 再从 "智能纪要" 提取 minutes token。

| 搜索词     | 之前 | 现在 | 路径                          |
| ---------- | ---- | ---- | ----------------------------- |
| "KPI"      | ✅   | ✅   | 智能纪要直接匹配              |
| "cursor"   | ❌   | ✅   | 文字记录 → 智能纪要 → minutes |
| "一蹴而就" | ❌   | ✅   | 文字记录 → 智能纪要 → minutes |

同时修复：非 docx 文档过滤（消除 404 warning）、transcript 无效 token 返回 error。

---

## Phase 3.5：Search 可解释性重构（已实现，2026-03-06 docker1 实测通过）

### 实现结果

- `searchMinutes` 已改为分页扫描 `offset=0/50/100/150`，最多收集 20 个候选，增强 top 5 结果。
- docker1 Her 实测 `cursor`：只调用 1 次 `feishu_minutes search`，返回 `match_sources=["transcript"]`、`why_matched="关键词命中文字记录原文"`，并给出带 `speaker` / `timestamp` 的 snippet；Her 未再升级 `transcript`。
- docker1 Her 实测 `KPI`：只调用 1 次 `feishu_minutes search`，因为 `ai_summary` 已足够解释命中，所以不返回 `transcript_snippets`，Her 直接基于摘要回答。

### 先从 Her 视角定义问题

这次重构的目标不是"再做一个更复杂的 search tool"，而是让 **Her 这样的强模型** 在真实会议任务里更轻松地完成工作。

对 Her 来说，skill 的价值不是详细 SOP，而是：

- 正确的**会议世界模型**
- 每个 tool 的**认知语义**
- 清晰的**成本/升级边界**
- 不同用户任务的**成功标准**

因此，Phase 3.5 必须先回答："Her 在面对会议相关请求时，脑中应该如何建模这个系统？"

### Her 的会议世界模型

一场飞书会议在本系统里通常有三个对象：

| 对象            | 作用                                             | 最适合回答什么问题                                 |
| --------------- | ------------------------------------------------ | -------------------------------------------------- |
| `智能纪要 docx` | AI summary、结论、行动项                         | 这场会大意讲了什么？                               |
| `文字记录 docx` | 全量听写文本的 docx 视图                         | 某个关键词为什么命中？原文证据在哪里？             |
| `minute`        | 妙记正式对象，含 metadata 和 transcript 导出能力 | 这场会的标题/时长/链接是什么？完整逐字记录是什么？ |

关键认知：

- 飞书公开搜索索引的是**文档**，不是 `minute`
- `智能纪要` 适合快速理解会议
- `文字记录` 适合做全文命中和 snippet 提取
- `minuteTranscript.get` 是高成本全文层，不该作为默认阅读层

### 真实用户任务类型

从 Her 视角，会议相关请求可以归纳为 5 类主任务：

| 任务类型    | 用户怎么说                           | Her 真正要完成什么                 |
| ----------- | ------------------------------------ | ---------------------------------- |
| `overview`  | “今天都开了哪些会？”                 | 在时间范围内发现会议，并做高层摘要 |
| `lookup`    | “上次谁提了 cursor？”                | 找到相关会议，并解释为什么命中     |
| `deep-dive` | “这场会详细讲了什么？”               | 展开单场会议内容                   |
| `evidence`  | “原话是什么？谁说的？”               | 提供原文证据而不是摘要             |
| `synthesis` | “整理最近两周关于 AI 采购的所有讨论” | 跨多场会议汇总形成新结论           |

### Her 真正需要从 skill 看见什么

一个适合强模型的 skill，应该最少提供以下信息：

1. **对象模型**：`智能纪要`、`文字记录`、`minute` 分别代表什么
2. **工具语义**：`list/search/get/transcript` 各自解决哪类认知问题
3. **升级边界**：什么时候停在 summary 层，什么时候必须升级到 transcript 层
4. **答案形态**：概览型、检索型、证据型、综合型答案分别应该长什么样
5. **失败模型**：权限、授权、搜索为空、tunnel/callback 故障分别意味着什么

### 当前 tools 语义 vs 目标 tools 语义

| Tool         | 当前语义                | 目标语义                                                          |
| ------------ | ----------------------- | ----------------------------------------------------------------- |
| `list`       | 时间范围内召回会议列表  | 保持不变，服务 `overview` / `synthesis`                           |
| `search`     | 返回候选会议元数据      | 升级为 **answer-ready evidence layer**，让 Her 能直接解释命中原因 |
| `get`        | 展开单场会议 AI summary | 保持不变，服务 `deep-dive` / `synthesis`                          |
| `transcript` | 导出完整逐字记录        | 保持不变，但明确为高成本证据层                                    |

### 设计目标

- `search` 结果要让 Her 直接知道"为什么这场会议匹配"
- 大多数 `lookup` / `evidence` / `synthesis` 查询只需要 **1 次** `search` tool call 即可形成第一版答案
- 控制 context window，不把整份 transcript 直接塞进搜索结果
- 在用户有海量普通文档时，尽量避免 minutes 结果被普通文档淹没

### 非目标

- 不追求和飞书 App 搜索 **100% 一样** 的排序和高亮展示；公开 API 不提供这部分能力
- `search` 不直接返回完整 transcript；完整原文继续由 `transcript` action 承担
- 不依赖 undocumented 的 query 拼词技巧（例如 `"智能纪要 " + query`）作为主方案

### 新架构（从 Her 任务反推）

1. **候选收集层**
   - 调用 `suite/docs-api/search/object`
   - 不只看第一页 50 条，而是分页扫描 `offset=0/50/100/150`
   - 直到收集到足够的 minutes 候选（例如 20 条）或耗尽官方 200 条上限
   - 本地只保留标题前缀为 `"智能纪要"` / `"文字记录"` 且 `docs_type === "docx"` 的结果

2. **会议归一化层**
   - `"智能纪要"` 命中：直接作为 `summary` source 候选
   - `"文字记录"` 命中：通过 `documentBlock.list` 找到链接的 `"智能纪要"` docx，标记为 `transcript` source
   - 以智能纪要 docx / `minute_token` 去重合并，保留 `match_sources`

3. **内容增强层**
   - 对排序靠前的 top 5 结果，固定拉取：
     - `minutes.v1.minute.get`（元数据）
     - `docx.v1.document.rawContent`（智能纪要 AI summary，**返回全文**）
   - 如果该结果包含 `transcript` source，则额外拉取对应"文字记录" docx 的 `rawContent`
   - 在本地从"文字记录"原文中切出 **1 段** `transcript_snippets`
   - snippet 规则：以第一次命中 query 的位置为中心，截取前后各约 120 个中文字符
   - 只有当 query 无法被 `ai_summary` 直接解释、但能在 `文字记录` 中解释时，才返回 `transcript_snippets`
   - **不**在 `search` 中调用 `minuteTranscript.get`；该接口仍保留给显式 `transcript` action

4. **结果输出层**
   - 返回 metadata + `ai_summary` + `transcript_snippets` + `match_sources`
   - 让 LLM 一次 tool call 就能回答"命中了哪场会、为什么命中、对应内容是什么"

### 实际返回结构（当前实现）

```json
{
  "query": "cursor",
  "results": [
    {
      "minute_token": "obcn...",
      "title": "AI账号采购及落地节奏讨论",
      "url": "https://.../minutes/obcn...",
      "duration": "3m21s",
      "match_sources": ["transcript"],
      "ai_summary": "本次会议围绕 AI 账号采购、效果闭环及落地节奏展开讨论...",
      "transcript_snippets": [
        {
          "speaker": "说话人 1",
          "timestamp": "00:00:40",
          "snippet": "我觉得这个 AI 版本对，切换到 cursor 这个是至关重要..."
        }
      ],
      "why_matched": "关键词命中文字记录原文"
    }
  ],
  "scan_stats": {
    "pages_scanned": 2,
    "docs_scanned": 73,
    "minute_candidates": 6,
    "results_enriched": 3
  }
}
```

### Her 的多轮工作模式

| 任务类型    | Her 的首选思路                              | 默认停止层        | 何时升级                                          |
| ----------- | ------------------------------------------- | ----------------- | ------------------------------------------------- |
| `overview`  | `list(days=N)` → `get` top N                | `ai_summary`      | 用户明确要原话/争议点时升级 transcript            |
| `lookup`    | `search(query)`                             | `search` 结果     | 只有 `search` 仍解释不清时才 `get` / `transcript` |
| `deep-dive` | 先定位会议，再 `get`                        | `get`             | 用户继续追问原话时升级 transcript                 |
| `evidence`  | `search(query)` 优先看 snippet              | `search` 结果     | snippet 不足以支持回答时升级 transcript           |
| `synthesis` | `search` / `list` 收集候选 → `get` 多场会议 | `ai_summary` 集合 | 某个关键结论存在冲突或证据不足时升级 transcript   |

### 资源预算

- Drive Search 最多扫描 4 页（官方上限 200 条）
- 最多保留 20 个 minutes 候选
- 最多增强 top 5 结果
- 每个结果最多返回 1 个 transcript snippet
- 每个 snippet 控制在 query 前后各约 120 个中文字符
- `ai_summary` 返回全文
- 目标：单次 `search` 返回内容控制在约 `2k-4k tokens`

### 三个维度的取舍

| 维度           | 当前 Phase 3                                                                   | 新架构                                                                   |
| -------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| Context window | `search` 本身很小，但 AI 常常还要继续调 `get` / `transcript`，整体上下文不可控 | `search` 直接返回 compact `ai_summary` + `transcript_snippets`，预算可控 |
| Latency        | 飞书 API 少，但 LLM 常需 2-3 次额外 tool round-trip                            | 飞书 API 略多，但大多数问题只需 1 次 `search` tool call                  |
| 质量           | 知道"哪场会匹配"，不知道"为什么匹配"                                           | 同时知道会议、命中来源和对应内容                                         |

### 全场景对比

| 场景                     | 当前 Phase 3                                                           | 新架构                                  | 结果                                    |
| ------------------------ | ---------------------------------------------------------------------- | --------------------------------------- | --------------------------------------- |
| 关键词在 AI summary 中   | `search` 只能返回会议元数据，AI 还要再调 `get`                         | `search` 直接返回 `ai_summary`          | 延迟下降，质量上升                      |
| 关键词只在 transcript 中 | `search` 只能返回会议元数据，AI 还要再调 `transcript` 才知道为什么命中 | `search` 直接返回 `transcript_snippets` | 解释力显著提升                          |
| 用户有海量普通文档       | 只看第一页 50 条，minutes 可能被淹没                                   | 分页扫描到 200 条或直到收集到足够候选   | 召回显著提升，但仍受官方 200 条上限约束 |
| 用户要完整原文           | 继续使用 `transcript` action                                           | 继续使用 `transcript` action            | 语义清晰，不混淆搜索和全文导出          |

### 与飞书 App 搜索的关系

- **底层能力**：接近。公开 API 和飞书 App 都能命中"文字记录"正文里的关键词
- **展示能力**：不同。公开 API 没有 snippet/highlight，也不保证相同排序
- **产品目标**：Her 的目标不是复制飞书 App UI，而是把搜索结果变成"可供 AI 直接回答"的结构化输入

---

## 实现计划（Her 视角）

### Step 1：先让 skill 对强模型友好

修改 `extensions/feishu-her/skills/feishu/SKILL.md` 的 Minutes 段落：

- 不再把 Minutes 写成 action 目录 + rigid SOP
- 改成 Her 的**对象模型 + 任务类型 + 工具语义 + 升级边界**
- 明确 `search/get/transcript` 分别处于哪一层
- 明确 transcript 是高成本证据层，不是默认阅读层

### Step 2：把 `search` 从“候选列表”升级为“可回答证据层”

修改 `extensions/feishu-her/src/tools/minutes.ts`：

- `searchMinutes` 改为分页扫描（最多 4 页，最多收集 20 个候选）
- 本地严格过滤 `docx + 标题前缀`
- 按 meeting 归一化并保留 `match_sources`
- 对 top 5 结果补齐：
  - metadata
  - `ai_summary`（全文）
  - `transcript_snippets`（最多 1 段，前后各 120 字）
  - `why_matched`
  - `scan_stats`

### Step 3：不改变 `get` / `transcript` 的角色

- `get` 继续作为单会展开层
- `transcript` 继续作为完整原文层
- 不让 `search` 直接承担全文导出职责

### Step 4：按真实用户任务验证，而不是只测 action

至少验证以下 5 类场景：

1. `overview`：今天/本周会议概览
2. `lookup`：关键词只在 AI summary 中
3. `lookup`：关键词只在 transcript 中
4. `evidence`：用户要求原话/谁说的
5. `synthesis`：跨多场会议输出结论/分歧/行动项

### Step 5：用 Her 的效果而不是 tool 输出判断成败

成功标准不是“API 返回字段更多了”，而是：

- Her 是否更少调用多轮 tool
- Her 是否能直接解释"为什么命中"
- Her 是否在大多数查询里避免读取完整 transcript
- Her 是否能稳定完成跨会综合任务

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
- [x] Phase 3：search 全文搜索升级
  - [x] search 结果中识别 "文字记录" docx
  - [x] 从 "文字记录" blocks 提取链接的 "智能纪要" docx token（`extractLinkedSmartMinutesDocToken`）
  - [x] 通过 "智能纪要" 间接获取 minute_token
  - [x] 过滤非 docx 文档避免无效 404 warning（`docs_type !== "docx"` check）
  - [x] transcript 无效 token 返回 error 而非静默
  - [x] docker1 全量回归 11 个 search 场景 100% PASS
- [x] Phase 3.5：search 可解释性重构
  - [x] 更新 `extensions/feishu-her/skills/feishu/SKILL.md`：Minutes 改写为对象模型/任务类型/升级边界
  - [x] `searchMinutes` 分页扫描 `offset=0/50/100/150`，直到收集足够的 minutes 候选
  - [x] 本地严格过滤 `docs_type === "docx"` 且标题前缀为 `"智能纪要"` / `"文字记录"`
  - [x] 返回结果中直接包含 `match_sources`
  - [x] 对 top 5 结果拉取智能纪要 `rawContent`，返回全文 `ai_summary`
  - [x] 对 transcript-source 结果拉取"文字记录" `rawContent`，按首个命中点切出 1 段 `transcript_snippets`
  - [x] 仅在 `ai_summary` 无法解释命中时返回 `transcript_snippets`
  - [x] 返回 `why_matched`
  - [x] 返回 `scan_stats`，便于调试召回范围和成本
  - [x] 严格限制 search 返回内容预算，避免 transcript 撑爆 context window
  - [ ] 以 `overview/lookup/deep-dive/evidence/synthesis` 五类任务做 docker1 实测验证（当前已完成 `lookup(summary)` + `lookup/evidence(transcript)`）
- [ ] Phase 4：体验优化
  - [ ] 授权后自动继续执行用户请求
  - [ ] 结构化展示妙记列表
  - [ ] refresh_token 过期提前通知
  - [ ] 每日会议纪要自动摘要（可选）
