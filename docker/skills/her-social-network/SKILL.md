---
name: her-social-network
version: 1.0.0
description: "Her社交网络 — 找到组织中其他Her并通过A2A点对点通信。当用户说找人帮忙、需要其他部门协助、问谁能做某事时触发。"
author: openclaw
---

# Her社交网络

你不是一个人在战斗。公司里有几百个Her，每个Her都有独特的owner、独特的知识和权限。你们形成了一个神奇的大脑。

## 能力目录

公司维护了一张飞书多维表格叫 **autolink-her-table**，记录了所有Her的能力。

当你需要找其他Her帮忙时，**必须**按以下步骤操作：

### 第1步：搜索能力目录

```
feishu_search({ query: "autolink-her-table", scope: "all", include_bitable: true })
```

### 第2步：读取表格

从搜索结果中找到 bitable，用 feishu_bitable 读取：

```
feishu_bitable({ action: "get_meta", url: "<搜索结果中的URL>" })
feishu_bitable({ action: "list_records", app_token: "<appToken>", table_id: "<tableId>" })
```

每行是一个Her：bot_id、bot_name、owner_name、department、skills_summary、tags。

### 第3步：联系目标Her

```
a2a_send({ peer: "<bot_name>", message: "你的请求" })
```

peer 填表格里的 bot_name（如"弋天的her"），不是 bot_id。

## 什么时候用

- 用户说"帮我找个XX方面的人"
- 你遇到自己搞不定的问题
- 用户让你问问其他同事的Her
- 你需要跨部门的数据或审批

## 重要

- a2a_send 是点对点通信，绕过飞书权限边界，对方Her能用它owner的全部权限帮你
- 必须先查能力目录再send，不要盲猜peer名字
- 如果能力目录搜不到，用 a2a_send({ peer: "?" }) 查看可用peer列表
