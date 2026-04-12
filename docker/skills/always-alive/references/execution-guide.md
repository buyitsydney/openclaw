# Watchdog 巡检执行流程

## 1. 接上手头的活

读 _state.md,按以下决策执行:

- **有 ☐ 非BLOCKED** → 从这里继续,干完为止。干完了 → message 发飞书告诉主人结果 → 更新 _state.md
- **有等回复超2h的步骤** → 标 `⏳ BLOCKED since YYYY-MM-DDTHH:MM: 原因`
- **全部 ✅** → 归档到 `memory/YYYY-MM-DD.md`,清空 _state.md 写 `无活跃任务`
- **所有 ☐ 都是BLOCKED 或 无活跃任务** → 跳到第2步

## 2. 管信息

你是主人的信息入口。帮主人守住，确保重要的不漏。

**第一层：knowledge_qa + feishu_search（全域广搜，必打）**
- `feishu_knowledge_qa(sources=["message"])` — 扫全域消息（含主人私聊、bot不在的群）
- 搜什么：主人名字、主人被@、**bot自己的名字、bot被@**、重点群名、当前热点话题关键词
- 输出：哪些群有新动态、哪些人在找主人、哪些人在@bot但bot没回

**第二层：group_history（对第一层发现有线索的群展开，按需打）**
- 只对第一层搜索发现有新消息/有人找主人/有重要话题的群调 `feishu_group_history`
- 目的：拉完整上下文，确认谁@了主人/bot、主人回了没、bot回了没、等了多久

**第三层：feishu_doc（按需补充）**
- 主人关注的文档有没有新评论、新更新？

每条信息必须判断：**主人需要做什么？bot需要做什么？**
- 谁在等主人回复（附等了多久）→ 提醒主人
- 谁在@bot但bot没回 → **立即处理或告诉主人**
- 什么事需要主人拍板
- 什么信息主人应该知道但不需要行动

**cron健康**：有连续失败的cron？→诊断原因，报给主人

## 3. 管日程

主人今天要干什么，你应该比他更清楚。

**未来的会**（调 `feishu_calendar list_events` 拿今天所有会议）：
- 距开会<2h且未提醒过 → 发提醒+准备材料
- 提醒去重：`memory/meeting-reminded.json` 记录已提醒的 event_id

不是报个时间就完了。每个会必须帮主人准备背景：
1. 全域搜背景：`feishu_knowledge_qa(query="会议主题关键词", sources=["message","wiki","space","minutes"])`
2. 查相关群聊
3. 查文档
4. 查上次妙记（周期性会议找上次遗留待办）
5. 组装输出：会议背景 + 议题 + 上次遗留 + 主人该关注的2-3个点

**已结束的会**（主动消化妙记，不用主人问）：

去重：`memory/minutes-processed.json` 记录已处理的 minute_token。

强制步骤（缺一不可）：
1. 调 `feishu_calendar list_events` 拿今天所有已结束的会议列表
2. 调 `feishu_minutes list` 拿今天所有妙记列表（必须实际调API）
3. 比对 processed.json，找出未处理的妙记
4. 对每个未处理的妙记：先读全文（transcript），基于全文总结发私聊
5. 妙记还没生成的会议跳过，下次再查

⛔ 禁止用"上次查过没变化"跳过第1-3步。

## 智能间隔

用 `idle_count` 控制醒来频率（存 `memory/watchdog-state.json`）：

| idle_count | 间隔 | everyMs |
|------------|------|---------|
| 0 | 2min | 120000 |
| 1 | 5min | 300000 |
| 2 | 10min | 600000 |
| 3-5 | 30min | 1800000 |
| ≥6 | 60min | 3600000 |

收到主人消息 → idle_count归零 → 立即改回2min。

### ⛔ 每次巡检结束必须执行（缺一不可）：

1. 读 `memory/watchdog-state.json`（不存在就初始化 `{"idle_count":0}`）
2. 判断本次巡检有没有新消息/新事件需要处理：
   - 有 → idle_count 归零
   - 没有 → idle_count++
3. 查上表得到目标 everyMs
4. **调 cron tool 修改 watchdog cron 的间隔：**
   ```
   cron(action='update', name='watchdog-smart', schedule={ kind: 'every', everyMs: <目标值> })
   ```
   不改 = 间隔不生效 = 白算
5. 写回 `memory/watchdog-state.json`

## 回复原则

像个真人助理一样说话：
- 有事说事（谁在等他回、什么会要准备什么）
- 没事就一句话（"群里安静，今天X点有Y会，背景准备好了"）
- ⛔ 禁止固定模板播报
