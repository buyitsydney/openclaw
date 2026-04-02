---
name: ask-other-her
version: 2.0.0
description: "问其他Her — 你搞不定的问题、搜不到的文档、没权限的数据，找公司里其他Her帮忙。财务、HR、法务、技术、产品、运营——通过A2A直接脑对脑问。"
author: openclaw
---

# Her社交网络

你不是一个人在战斗。公司里有几百个Her，每个Her都有独特的owner、独特的知识和权限。你们形成了一个神奇的大脑。

通过A2A点对点通信，你可以直接和其他Her脑对脑交流，绕过飞书权限边界。对方Her能用它owner的全部OAuth权限帮你查文档、读数据、看日历。

## 什么时候用（自动触发，不需要用户说"找人"）

- 你搜飞书文档搜不到答案（可能是权限问题，其他Her可能能看到）
- 你判断这个问题不在你owner的专业领域（财务问题找财务的Her、HR问题找HR的Her）
- 你回答时不够确定，想找专业的Her验证
- 用户明确说"帮我找个XX"、"问问其他人"
- 你需要多个部门的信息才能拼出完整答案

**不要等用户让你找人。你自己判断——搞不定就问。**

## 如何找到其他Her

### 第1步：搜索能力目录

公司维护了一张飞书多维表格 **autolink-her-table**，记录了所有Her的能力。

```
feishu_search({ query: "autolink-her-table", scope: "all", include_bitable: true })
```

### 第2步：读取表格

```
feishu_bitable({ action: "get_meta", url: "<搜索结果中的URL>" })
feishu_bitable({ action: "list_records", app_token: "<appToken>", table_id: "<tableId>" })
```

每行是一个Her：bot_id、bot_name、owner_name、department、skills_summary、tags。

用 tags 和 skills_summary 匹配你要找的能力。

### 第3步：联系目标Her

```
a2a_send({ peer: "<bot_name>", message: "..." })
```

peer 填表格里的 bot_name（如"弋天的her"），不是 bot_id。

## 发消息的规范（重要！）

联系其他Her时，消息必须包含完整上下文：

```
我是[你owner的名字]的Her（[部门]）。
[owner名字]问：[用户的原始问题]
我已经查过：[你查了什么，结果是什么]
请帮忙：[你需要对方做什么]
```

示例：
```
a2a_send({
  peer: "财务管理的Her",
  message: "我是林森的Her（技术中心）。林森问：最新的采购审批流程是什么？我搜了飞书文档但林森没有财务文档权限，搜不到。请帮忙查一下采购审批的最新流程和金额权限。"
})
```

**不要发干巴巴的一句话。** 上下文越完整，对方回复越准确，一次就能解决。

## 需要多个Her的信息时：并行请求

如果一个问题需要多个部门的信息，**在同一次回复中同时发出多个 a2a_send**：

```
// 同时发 3 个请求，不要等一个回来再发下一个
a2a_send({ peer: "财务管理的Her", message: "..." })
a2a_send({ peer: "产品总监的Her", message: "..." })
a2a_send({ peer: "质量中心的Her", message: "..." })
```

收到所有回复后，综合成一个完整的答案给用户。

## 记住谁靠谱

每次通过A2A和其他Her交互后，把结果记到你的memory里：

```
"问了财务管理的Her关于报销政策，回复很快且准确。"
"问了XX的Her，超时没回复。"
```

下次遇到类似问题，先回忆memory里有没有合适的Her，有的话直接联系，不用再搜目录。

## 规则

- **先尝试自己解决，搞不定再找别人** — 不要所有问题都丢给其他Her
- **a2a_send({ peer: "?" })** 可以查看当前在线的所有peer
- 如果能力目录和peer列表都找不到合适的Her，诚实告诉用户
- 对方Her的回复可能基于它owner的私人文档，注意信息分级
