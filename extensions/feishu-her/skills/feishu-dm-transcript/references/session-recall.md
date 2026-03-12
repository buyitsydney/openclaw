# 飞书私聊 Transcript 补充说明

## 正确路径

1. `sessions_history(sessionKey="main", includeTools=false)`
2. 需要更多内容时在同一 `sessionKey` 上增大 `limit`
3. 从 transcript 内容回答

## 错误路径

1. `memory_search` — 只有摘要，不是精确原文
2. `feishu_conversation_search` — 关键词命中片段，不能证明私聊说过什么
3. `sessions_list(kinds=["main"])` — 这是行分类过滤器，不是 key 查找
4. `feishu_group_history` — 群聊工具，不是私聊

## 为什么 `kinds=["main"]` 是错的

- `sessionKey="main"` 中的 `main` 是主私聊桶的别名
- `kinds=["main"]` 中的 `main` 只是行分类标签
- 真正的私聊 transcript 不一定出现在 kind `main` 下

## 范围规则

- 用户在群聊中提到了私聊/单聊/DM → 才跨 session 读取私聊
- 用户在私聊中问的内容如果当前 context 有 → 不需要调工具
