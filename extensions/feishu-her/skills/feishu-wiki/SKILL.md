---
name: feishu-wiki
description: |
  飞书知识空间导航和 Wiki 节点管理。当用户问知识空间、Wiki 页面、节点树、移动/重命名页面、解析 Wiki 链接、或浏览个人/知识空间结构时使用。
metadata: { "openclaw": { "emoji": "📚" } }
---

# 飞书 Wiki 操作

用于知识空间/节点导航和 Wiki 页面管理。编辑页面正文内容时用 `feishu-doc`。

## 心智模型

- Wiki 是树状知识空间
- 云盘是文件存储
- 用户说"知识空间"、"wiki"、或通常说"个人空间"时，优先假设 Wiki

## 核心操作

- `feishu_wiki(action="spaces")` -> 列出空间
- `feishu_wiki(action="nodes")` -> 列出顶级或子节点
- `feishu_wiki(action="get")` -> 查看单个节点
- `feishu_wiki(action="create")` -> 创建节点
- `feishu_wiki(action="rename")` -> 重命名节点
- `feishu_wiki(action="move")` -> 移动节点
- `feishu_wiki(action="resolve_url")` -> 获取真实可访问链接

## 节点 vs 文档

- `node_token` 标识 Wiki 节点
- `obj_token` 标识底层文档对象
- 要读取或编辑页面内容，先调用 `feishu_wiki(action="get")`，再把 `obj_token` 传给 `feishu_doc`

不要把 `node_token` 和 `doc_token` 搞混。

## 创建规则

- 页面类型有要求时传明确的 `obj_type`
- 常见类型：`docx`、`sheet`、`bitable`
- 用户关心位置时传 `parent_node_token`
- Wiki 创建不是安全回滚路径，不要承诺创建后可以 API 删除

## 移动和重命名

- 只改标题用 `rename`
- 改父节点或空间用 `move`
- `space_id` / `target_space_id` / `target_parent_token` 必须精确，不要猜

## 分享链接

- 用户要分享 Wiki 链接时必须用 `feishu_wiki(action="resolve_url")`
- 不要手工拼 Wiki URL
- 用户要改页面内容而非分享链接时，切到 `feishu-doc`

## 输出规则

- 说明你是导航了空间、查看了节点、移动了节点、重命名了节点、还是解析了 URL
- 如果正文编辑任务交给了 `feishu-doc`，明确说明
