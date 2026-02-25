---
name: feishu
description: Feishu (飞书) comprehensive guide covering messaging, groups, contacts, documents, wiki, bitable, drive, group archives, and voice. Use when interacting with Feishu in any way. Triggers on keywords like 飞书, feishu, 转发, 分享文档, share document, forward, 群, group, 通讯录, contacts, directory, 文档, 知识空间, wiki, 多维表格, bitable, 群聊归档, group archive, 语音, voice, audio.
metadata: { "openclaw": { "emoji": "📨" } }
---

# Feishu Skill — 全功能操作指南

> 最后验证：2026-02-25。所有能力均经过实测（含 @mention + 企业通讯录）。

## 能力总览

| 类别           | 能力                                               | 工具               | 状态             |
| -------------- | -------------------------------------------------- | ------------------ | ---------------- |
| **消息**       | 发送消息（群/个人）                                | `message`          | ✅               |
| **文件发送**   | 发送本地文件到飞书聊天（PPT/PDF/DOCX等，≤30MB）    | `message` + media  | ✅               |
| **群聊**       | 列表、详情、成员                                   | `feishu_chat`      | ✅               |
| **通讯录**     | 用户、部门                                         | `feishu_directory` | ✅ 企业版含姓名  |
| **知识空间**   | 列空间、遍历节点、节点详情                         | `feishu_wiki`      | ✅               |
| **Wiki 管理**  | 创建节点（docx/bitable/sheet）、重命名、移动       | `feishu_wiki`      | ✅               |
| **文档读取**   | 读正文、表格、代码、画板（自动导出 PNG）           | `feishu_doc`       | ✅               |
| **文档写入**   | write（覆盖）、append（追加）、create（新建）      | `feishu_doc`       | ✅               |
| **Block 操作** | list_blocks、get_block、update_block、delete_block | `feishu_doc`       | ✅               |
| **多维表格读** | get_meta、list_fields、list_records、get_record    | `feishu_bitable`   | ✅               |
| **多维表格写** | create_record、update_record                       | `feishu_bitable`   | ✅               |
| **云盘**       | list、info、create_folder、move、delete            | `feishu_drive`     | ✅ Bot 限制见下  |
| **群聊归档**   | 本地 JSONL 归档读取和总结                          | `exec` (jq)        | ✅               |
| **删除**       | —                                                  | —                  | ❌ 无权限（403） |

## ⚠️ 重要限制（必读！）

### 1. 无法删除任何内容

Bot 没有删除权限。Wiki 节点、文档、多维表格记录均无法通过 API 删除。**创建前要确认，创建后无法撤销**（需用户手动删除）。

### 2. 通讯录 API 行为（实测）

- **企业版**：`feishu_directory` 返回完整用户信息（name、department_ids、email、mobile 等）
- **个人版**：只返回 open_id + status，不含姓名。替代方案：用 `feishu_chat(action="members")` 从群成员列表获取姓名
- **`list_users(department_id='0')`（根部门）在多数企业返回空数组** — 用户归属于具体子部门，不在根部门下
- **没有按姓名搜索的 API** — 需通过 `list_departments` + 逐部门 `list_users` 来查找特定用户
- **`feishu_chat(action="members")` 是更快的替代路径** — 如果目标用户在 bot 已加入的群中，1 次调用即可获取 open_id 和姓名

### 3. 云盘 vs 知识空间

- **知识空间（Wiki）**= 用户日常使用的"个人空间"，树状文档结构 → 用 `feishu_wiki`
- **云盘（Drive）**= 独立的文件存储系统，类似百度网盘 → 用 `feishu_drive`
- 它们是**完全独立的系统**。用户说"我的空间"通常指 Wiki，不是云盘
- 云盘 Bot 没有根目录，只能访问被分享的文件夹。`create_folder` 不带 `folder_token` 会 400

### 4. 多维表格字段格式

Bitable 的 Text 字段直接传字符串即可（如 `{"字段名": "值"}`），不需要数组包裹。SingleSelect 也直接传字符串。DateTime 传 unix 毫秒时间戳。

## 🔴 语音消息（CRITICAL）

**绝对不要手动调用 TTS 工具！** 系统配置了 `tts.auto = "inbound"`：

- 用户发语音 → 系统自动 STT 转文字 → 你收到文字 → 你回复文字 → 系统自动 TTS 回语音
- 你只需回复普通文字。手动调 `tts()` 会导致重复语音和投递错误
- 用户发文字 → 你回复文字，不会生成语音

## 📎 发送文件到飞书聊天（PPT/PDF/DOCX 等）

系统已支持将本地生成的文件直接发送到飞书聊天。当用户要求你生成 PPT、PDF、Word 等文件时：

### 流程

1. **用 `exec` 工具生成文件**（例如用 python-pptx 生成 .pptx）
2. **用 `message` 工具发送文件**，将本地文件绝对路径作为 media 参数：

```
message(action="send", channel="feishu", target="<当前聊天>", media="/path/to/generated.pptx")
```

系统会自动上传文件到飞书并发送为文件消息，用户可直接在飞书中下载。

### 限制

- 文件大小上限 **30MB**（飞书 API 限制）。超过 30MB 的文件无法上传，会报错。如果遇到文件过大的错误，**必须告知用户文件超过 30MB 限制**，并建议压缩或使用较小版本。
- 支持的文件类型：PPT/PPTX、DOC/DOCX、XLS/XLSX、PDF、MP4、TXT 等
- 文件路径必须是绝对路径（以 `/` 开头）

### 重要：不要把文件路径当文字发送！

- ✅ 正确：`message(action="send", media="/path/to/file.pptx")`
- ❌ 错误：在文字回复里贴文件路径让用户自己找
- ❌ 错误：用 `https://example.com/...` 占位 URL 当 media

## 文档操作 SOP（必须遵守！）

### 同步本地文件到飞书文档

当用户要求同步本地 markdown 到飞书/Wiki 文档时，必须执行以下步骤：

1. 解析目标 doc_token（Wiki URL → `feishu_wiki get` → 取 `obj_token`）
2. 用 `feishu_doc write` + `source_file`（非 `content`）写入，使用本地文件绝对路径
3. 立即用 `feishu_doc list_blocks` 验证 block/table 结构
4. 报告验证指标：first-level blocks 数量、table 数量、empty cells

硬性规则：

- 超过 ~20 行的内容，必须用 `source_file`（避免 LLM token 膨胀和超时）
- 不要仅用 `read` 验证表格（`rawContent` API 会丢掉表格结构）
- 验证必须在同一个 doc_token 上执行

### Token 提取

- 文档 URL `https://xxx.feishu.cn/docx/ABC123def` → `doc_token` = `ABC123def`
- Wiki URL `https://xxx.feishu.cn/wiki/ABC123def` → 先 `feishu_wiki get` → 取 `obj_token`

### 编辑策略（按优先级）

**Priority 1: find/replace**（最安全，保留格式）

修改特定文字（数字、姓名、日期）：

```json
{
  "action": "update_block",
  "doc_token": "xxx",
  "block_id": "doxcnXXX",
  "find": "2026",
  "replace_with": "2027"
}
```

Workflow: `list_blocks` 找到目标 block → `update_block` + `find/replace_with` 精确替换。

**Priority 2: update_block with content**（单 block 重写）

```json
{ "action": "update_block", "doc_token": "xxx", "block_id": "doxcnXXX", "content": "完全新内容" }
```

会丢失格式（粗体、链接变纯文本），仅在整个 block 需要改变时使用。

**Priority 3: append**（追加到末尾）

```json
{ "action": "append", "doc_token": "xxx", "source_file": "/path/to/content.md" }
```

短内容可用 `content` 参数。

**Priority 4: write**（最后手段，破坏性）

删除全部现有内容后重写。自动备份到 `~/.openclaw/feishu-doc-backups/`。

```json
{ "action": "write", "doc_token": "xxx", "source_file": "/path/to/document.md" }
```

- `$` 后接数字会自动转义防止飞书渲染为 LaTeX
- 图片支持：HTTP URL 和本地路径均可（`![photo](https://example.com/a.jpg)` 或 `![photo](/path/to/a.jpg)`）
- 表格：初始创建限 9x9 但自动扩展，通过 batch_update 填充单元格
- 大文档（12 表格 210 单元格）写入约 18 秒

### 验证写入

`write`/`append` 后必须用 `list_blocks` 验证（不是 `read`）。报告 "0 diff" 前必须：

1. `list_blocks` 检查表格数量和 empty cells
2. 检查主要 heading 顺序
3. 然后报告成功

## @提及用户（@mention）

在飞书消息中 @提及某人，必须使用飞书 `<at>` 标签语法，**不能**只写 `@名字`（纯文本 @ 不会触发飞书通知）。

### 语法格式

```
<at user_id="ou_xxx">姓名</at>
```

- `user_id` 必须是有效的 `open_id`（`ou_` 开头）
- @所有人：`<at user_id="all">所有人</at>`

### 操作流程

1. **获取目标用户的 open_id**：
   - 从群成员获取：`feishu_chat(action="members", chat_id="oc_xxx")` — 返回成员列表含 `member_id`（即 open_id）和 `name`
   - 从通讯录获取：`feishu_directory(action="list_users")` — 返回用户列表含 `open_id` 和 `name`
   - 从通讯录查单人：`feishu_directory(action="get_user", user_id="ou_xxx")`

2. **在消息文本中使用 `<at>` 标签**：

   ```
   message(action="send", channel="feishu", target="oc_xxx",
           message="<at user_id=\"ou_abc123\">张三</at> 请查收这份文档")
   ```

3. **@所有人**：
   ```
   message(action="send", channel="feishu", target="oc_xxx",
           message="<at user_id=\"all\">所有人</at> 请注意以下通知")
   ```

### 注意事项

- **先查 open_id 再 @**：不要凭空编造 open_id，必须先用 `feishu_chat` 或 `feishu_directory` 查到真实 ID
- **可以和 Markdown 混用**：`**重要通知** <at user_id="ou_xxx">张三</at> 请处理` — 系统会正确解析
- **@所有人需要群权限**：群必须开启了"允许 @所有人"功能

## 操作指南

### 发送消息

```
message(action="send", channel="feishu", target="<oc_xxx 或 ou_xxx>", message="内容")
```

- `oc_` 开头：群聊 chat_id
- `ou_` 开头：个人 open_id

### 分享/转发文档

转发文档 = 发送文档链接。飞书会自动将链接渲染为文档卡片预览。

1. 用 `feishu_wiki` 找到文档的 `node_token`
2. 拼接链接：`https://<tenant>.feishu.cn/wiki/<node_token>`
3. 用 `message(action="send", ...)` 发送链接

### 查找群聊和联系人

**群聊：**

- `feishu_chat(action="list")` — 列出 bot 已加入的所有群
- `feishu_chat(action="get", chat_id="oc_xxx")` — 群详情
- `feishu_chat(action="members", chat_id="oc_xxx")` — 群成员（**含姓名**）
- 已归档群消息：查 `~/.openclaw/feishu-groups/index.json`

**联系人（企业通讯录）：**

- `feishu_directory(action="list_departments")` — 部门列表（`department_id='0'` 为根，返回所有一级部门）
- `feishu_directory(action="list_users", department_id="xxx")` — 指定部门的用户列表（注意：`department_id='0'` 通常返回空，用户归属于具体子部门）
- `feishu_directory(action="get_user", user_id="ou_xxx")` — 单个用户详情
- 需要 `contact:user.base:readonly` + `contact:department.base:readonly` 权限，且飞书后台"通讯录权限范围"需设为"全部成员"

### 知识空间（Wiki）

**浏览：**

- `feishu_wiki(action="spaces")` — 列出所有知识空间
- `feishu_wiki(action="nodes", space_id="xxx")` — 顶级节点
- `feishu_wiki(action="nodes", space_id="xxx", parent_node_token="xxx")` — 子节点
- `feishu_wiki(action="get", token="xxx")` — 节点详情（返回 `obj_token` 用于 `feishu_doc`）

**创建（⚠️ 创建后无法通过 API 删除）：**

- `feishu_wiki(action="create", space_id="xxx", title="xxx")` — 创建 docx
- `feishu_wiki(action="create", ..., obj_type="bitable")` — 创建多维表格
- `feishu_wiki(action="create", ..., parent_node_token="xxx")` — 在指定节点下创建

`obj_type`: `docx`(默认), `sheet`, `bitable`, `mindnote`, `file`, `doc`, `slides`

**管理：**

- `feishu_wiki(action="rename", ...)` — 重命名
- `feishu_wiki(action="move", ...)` — 移动

**Wiki-Doc 联动：** Wiki 页面本质是文档。用 `feishu_wiki get` 获取 `obj_token`，然后用 `feishu_doc` 的 `doc_token` 参数传入 `obj_token` 进行读写。

### 文档读写

**读取：**

- `feishu_doc(action="read", doc_token="xxx")` — 读取全文（含画板自动导出 PNG）。检查 `hint` 和 `block_types` 判断是否需要 `list_blocks`
- `feishu_doc(action="list_blocks", doc_token="xxx")` — 完整 block 数据（含表格、图片）
- `feishu_doc(action="get_block", doc_token="xxx", block_id="doxcnXXX")` — 单个 block
- `feishu_doc(action="create", title="xxx")` — 新建文档

> doc_token 来自 `feishu_wiki` 返回的 `obj_token`（不是 node_token）

### 多维表格（Bitable）

**读取：**

- `feishu_bitable(action="get_meta", url="飞书URL")` — 获取 app_token + 表列表
- `feishu_bitable(action="list_fields", app_token="xxx", table_id="xxx")` — 字段定义
- `feishu_bitable(action="list_records", app_token="xxx", table_id="xxx")` — 记录列表
- `feishu_bitable(action="get_record", ..., record_id="xxx")` — 单条记录

**写入：**

- `feishu_bitable(action="create_record", app_token="xxx", table_id="xxx", fields={"字段名": "值"})` — 新建
- `feishu_bitable(action="update_record", ..., record_id="xxx", fields={"字段名": "新值"})` — 更新

> fields 按字段名传值，Text 传字符串，SingleSelect 传字符串，DateTime 传毫秒时间戳

### 云盘（Drive）

- `feishu_drive(action="list")` — 根目录
- `feishu_drive(action="list", folder_token="fldcnXXX")` — 指定文件夹
- `feishu_drive(action="info", file_token="xxx", type="docx")` — 文件信息
- `feishu_drive(action="create_folder", name="xxx", folder_token="fldcnXXX")` — 创建文件夹
- `feishu_drive(action="move", file_token="xxx", type="docx", folder_token="fldcnXXX")` — 移动
- `feishu_drive(action="delete", file_token="xxx", type="docx")` — 删除

## 群聊归档

本地归档的群聊消息，用 jq 查询。

### 文件结构

```
~/.openclaw/feishu-groups/
├── index.json                         # chatId -> { name, lastMessage }
├── <chatId>/
│   └── messages.jsonl                 # 每行一条消息 JSON
```

消息格式：`{ "ts": unix_epoch_seconds, "sender": "名字", "senderId": "ou_xxx", "text": "内容", "msgId": "om_xxx" }`

### 常用查询

```bash
# 列出所有归档群
jq '.' ~/.openclaw/feishu-groups/index.json

# 最近 50 条消息
tail -50 ~/.openclaw/feishu-groups/<chatId>/messages.jsonl | jq -r '"[\(.ts | todate)] \(.sender): \(.text)"'

# 今天的消息
TODAY=$(date +%Y-%m-%d)
jq -r "select((.ts | todate) | startswith(\"$TODAY\")) | \"[\(.ts | todate)] \(.sender): \(.text)\"" ~/.openclaw/feishu-groups/<chatId>/messages.jsonl

# 搜索关键词
jq -r "select(.text | test(\"keyword\"; \"i\")) | \"[\(.ts | todate)] \(.sender): \(.text)\"" ~/.openclaw/feishu-groups/<chatId>/messages.jsonl

# 每人消息数
jq -r '.sender' ~/.openclaw/feishu-groups/<chatId>/messages.jsonl | sort | uniq -c | sort -rn
```

从 `index.json` 匹配用户提到的群名（支持模糊匹配），然后读取对应 `messages.jsonl`。
