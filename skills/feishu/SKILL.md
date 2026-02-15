---
name: feishu
description: Feishu (飞书) messaging, groups, contacts, documents, wiki, bitable, and sharing. Use when the user asks to send messages, list groups, look up contacts, share/forward documents, create/edit documents, manage wiki spaces, or interact with Feishu. Triggers on keywords like 飞书, feishu, 转发, 分享文档, share document, forward, 群, group, 通讯录, contacts, directory, 文档, 知识空间, wiki, 多维表格, bitable.
metadata: { "openclaw": { "emoji": "📨" } }
---

# Feishu Skill — 能力全景与使用指南

> 最后验证：2026-02-15。所有能力均经过实测。

## 能力总览

| 类别 | 能力 | 工具 | 状态 |
|------|------|------|------|
| **消息** | 发送消息（群/个人） | `message` | ✅ |
| **群聊** | 列表、详情、成员 | `feishu_chat` | ✅ |
| **通讯录** | 用户、部门 | `feishu_directory` | ✅ 个人版无姓名 |
| **知识空间** | 列空间、遍历节点、节点详情 | `feishu_wiki` | ✅ |
| **Wiki 管理** | 创建节点（docx/bitable/sheet）、重命名、移动 | `feishu_wiki` | ✅ |
| **文档读取** | 读正文、表格、代码、画板（自动导出 PNG） | `feishu_doc` | ✅ |
| **文档写入** | write（覆盖）、append（追加）、create（新建） | `feishu_doc` | ✅ |
| **Block 操作** | list_blocks、get_block、update_block、delete_block | `feishu_doc` | ✅ |
| **多维表格读** | get_meta、list_fields、list_records、get_record | `feishu_bitable` | ✅ |
| **多维表格写** | create_record、update_record | `feishu_bitable` | ✅ |
| **云盘** | list | `feishu_drive` | ✅ |
| **删除** | — | — | ❌ 无权限（403） |

## ⚠️ 重要限制（必读！）

### 1. 无法删除任何内容
Bot 没有删除权限。Wiki 节点、文档、多维表格记录均无法通过 API 删除。**创建前要确认，创建后无法撤销**（需用户手动删除）。

### 2. 通讯录个人版限制
飞书个人版通讯录 API 不返回用户姓名，只有 open_id + status。**获取用户姓名的替代方案**：用 `feishu_chat(action="members")` 从群成员列表获取——群成员接口会返回姓名。

### 3. 云盘 vs 知识空间
- **知识空间（Wiki）**= 用户日常使用的"个人空间"，树状文档结构 → 用 `feishu_wiki`
- **云盘（Drive）**= 独立的文件存储系统，类似百度网盘 → 用 `feishu_drive`
- 它们是**完全独立的系统**。用户说"我的空间"通常指 Wiki，不是云盘
- 云盘写入功能（create_folder/move）目前不可用（400 错误）

### 4. 多维表格字段格式
Bitable 的 Text 字段直接传字符串即可（如 `{"字段名": "值"}`），不需要数组包裹。SingleSelect 也直接传字符串。DateTime 传 unix 毫秒时间戳。

## 操作指南

### 发送消息

```
message(action="send", channel="feishu", target="<oc_xxx 或 ou_xxx>", message="内容")
```

- `oc_` 开头：群聊 chat_id
- `ou_` 开头：个人 open_id

### 分享/转发文档

**转发文档 = 发送文档链接。** 飞书会自动将链接渲染为文档卡片预览。

1. 用 `feishu_wiki` 找到文档的 `node_token`
2. 拼接链接：`https://<tenant>.feishu.cn/wiki/<node_token>`
3. 用 `message(action="send", ...)` 发送链接

### 查找群聊和联系人

**群聊：**
- `feishu_chat(action="list")` — 列出 bot 已加入的所有群
- `feishu_chat(action="get", chat_id="oc_xxx")` — 群详情
- `feishu_chat(action="members", chat_id="oc_xxx")` — 群成员（**含姓名**）
- 已归档群消息：查 `~/.openclaw/feishu-groups/index.json`

**联系人：**
- `feishu_directory(action="list_users")` — 用户列表
- `feishu_directory(action="get_user", user_id="ou_xxx")` — 用户详情
- `feishu_directory(action="list_departments")` — 部门列表

### 知识空间（Wiki）操作

**浏览：**
- `feishu_wiki(action="spaces")` — 列出所有知识空间
- `feishu_wiki(action="nodes", space_id="xxx")` — 顶级节点
- `feishu_wiki(action="nodes", space_id="xxx", parent_node_token="xxx")` — 子节点
- `feishu_wiki(action="get", token="xxx")` — 节点详情

**创建（⚠️ 创建后无法通过 API 删除）：**
- `feishu_wiki(action="create", space_id="xxx", title="xxx")` — 创建 docx
- `feishu_wiki(action="create", ..., obj_type="bitable")` — 创建多维表格
- `feishu_wiki(action="create", ..., parent_node_token="xxx")` — 在指定节点下创建

**管理：**
- `feishu_wiki(action="rename", space_id="xxx", node_token="xxx", title="新名")` — 重命名
- `feishu_wiki(action="move", space_id="xxx", node_token="xxx", target_parent_token="xxx", target_space_id="xxx")` — 移动

### 文档读写

**读取：**
- `feishu_doc(action="read", doc_token="xxx")` — 读取文档全文（含画板自动导出 PNG）
- `feishu_doc(action="list_blocks", doc_token="xxx")` — 列出所有 block 结构

**写入（⚠️ write 会覆盖整个文档内容）：**
- `feishu_doc(action="write", doc_token="xxx", content="markdown内容")` — 覆盖写入
- `feishu_doc(action="append", doc_token="xxx", content="markdown内容")` — 追加内容

> doc_token 来自 `feishu_wiki` 返回的 `obj_token`（不是 node_token）

### 多维表格（Bitable）

**读取：**
- `feishu_bitable(action="get_meta", url="飞书URL")` — 获取 app_token + 表列表
- `feishu_bitable(action="list_fields", app_token="xxx", table_id="xxx")` — 字段定义
- `feishu_bitable(action="list_records", app_token="xxx", table_id="xxx")` — 记录列表
- `feishu_bitable(action="get_record", ..., record_id="xxx")` — 单条记录

**写入：**
- `feishu_bitable(action="create_record", app_token="xxx", table_id="xxx", fields={"字段名": "值"})` — 新建记录
- `feishu_bitable(action="update_record", ..., record_id="xxx", fields={"字段名": "新值"})` — 更新记录

> fields 按字段名传值，Text 传字符串，SingleSelect 传字符串，DateTime 传毫秒时间戳
