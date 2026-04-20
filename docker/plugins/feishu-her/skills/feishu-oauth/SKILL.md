---
name: feishu-oauth
description: |
  飞书用户 OAuth 授权流程。当任何飞书工具返回 user_auth_required、用户询问授权状态、或 OAuth token 过期时使用。
metadata: { "openclaw": { "emoji": "🔑" } }
---

# 飞书 OAuth 用户授权

## 哪些工具需要 OAuth

以下工具全部依赖 `user_access_token`，首次调用或 token 过期时会返回授权请求：

- `feishu_minutes` — 会议纪要
- `feishu_search` / `feishu_deep_search` — 文档搜索
- `feishu_drive` — 云盘
- `feishu_doc` — 文档读取
- `feishu_wiki` — 知识库
- `feishu_sheet` — 表格
- `feishu_bitable` — 多维表格
- `feishu_group_history` — 群聊历史

## 授权流程（必须严格遵循）

1. 调用上述任一工具时，如果返回 `user_auth_required` 错误和 `auth_url` 字段
2. **将 `auth_url` 的完整 URL 原样发送给用户**，不得截断、缩写或改写
3. 提示用户在飞书中点击链接完成授权
4. 用户点击链接 → 飞书授权页面 → 确认 → 自动完成
5. 授权成功后 Her 会收到通知消息，此时重新调用之前失败的工具即可

## 绝对禁止

- **禁止截断 `auth_url`**：URL 包含 client_id、redirect_uri、scope、state 等参数，任何截断都会导致授权失败
- **禁止自己编造授权链接**：只使用工具返回的 `auth_url`
- **禁止跳过授权直接回答**：没有 token 就无法访问用户数据，必须先完成授权

## Token 生命周期

- access_token 有效期约 2 小时，自动刷新
- refresh_token 有效期约 30 天，过期后需用户重新授权
- 授权后对所有工具生效，不需要每个工具单独授权
