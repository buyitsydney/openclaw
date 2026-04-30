---
name: feishu-oauth
description: |
  飞书用户 OAuth 授权流程。当任何飞书工具返回 auth_link_sent 或 user_auth_required 时使用。
metadata: { "openclaw": { "emoji": "🔑" } }
---

# 飞书 OAuth 用户授权

## 哪些工具需要 OAuth

以下工具全部依赖 `user_access_token`，首次调用或 token 过期时会触发授权：

- `feishu_calendar` — 日历
- `feishu_minutes` — 会议纪要
- `feishu_search` / `feishu_deep_search` — 文档搜索
- `feishu_drive` — 云盘
- `feishu_doc` — 文档读取
- `feishu_wiki` — 知识库
- `feishu_sheet` — 表格
- `feishu_bitable` — 多维表格
- `feishu_group_history` — 群聊历史
- `feishu_directory` — 通讯录
- `feishu_message_search` — 消息搜索
- `feishu_doc_comments` — 文档评论
- `feishu_knowledge_qa` — 知识库问答

## 授权流程（Direct Send 架构）

工具内部通过飞书卡片 API 直接向用户发送授权链接，**不经过模型文本生成**，防止 URL 被截断或篡改。

1. 调用上述工具时，如果 token 不存在或过期
2. 工具自动通过 `sendFeishuRichText` 向用户私聊/群聊直接发送包含授权链接的卡片消息
3. 工具返回 `{"status": "auth_link_sent"}`
4. 用户在飞书中点击卡片里的链接完成授权
5. 授权成功后重新调用之前失败的工具即可

## 绝对禁止

- **禁止自己编造授权链接**：不要生成任何 `accounts.feishu.cn` 的 URL
- **禁止自己输出 auth_url**：授权链接已由工具直接发送，不要在回复中重复输出
- **禁止跳过授权直接回答**：没有 token 就无法访问用户数据，必须先完成授权
- **禁止混淆 lark-cli 授权和 feishu-her 授权**：这是两套独立的 OAuth 系统

## 收到 auth_link_sent 后的标准回复

当工具返回 `auth_link_sent` 时，回复类似：

> 已发送授权链接，请在飞书中点击完成授权，完成后我会继续处理你的请求。

不要在回复里包含任何 URL。

## Token 生命周期

- access_token 有效期约 2 小时，自动刷新
- refresh_token 有效期约 30 天，过期后需用户重新授权
- 授权后对所有工具生效，不需要每个工具单独授权

## Scope 管理

- 代码中 `OAUTH_SCOPES`（57 个）定义了需要申请的权限列表
- `resolveEffectiveOAuthScopes` 在运行时调飞书 API 取后端实际开通的 scope，取交集
- 后端未开通的 scope 自动过滤，日志中会打印 `filtered N scope(s) not in backend`
