---
name: twitter-monitor
description: 抓取 Twitter/X 推文日报并推送到飞书/Telegram。用于监控指定账号（如 Musk）的最新推文。当用户提到推文、twitter、X、musk推文、推文日报、推文监控时触发。也用于 cron 定时推文抓取任务。
---

# Twitter Monitor Skill

抓取指定 Twitter/X 账号的最新推文，整理成智能摘要后推送。

## 执行步骤

1. **读取数据源配置**: `read {baseDir}/references/sources.md` 获取当前可用数据源
2. **抓取推文**: 用 `web_fetch` 获取 HTML，用 `exec` + python3 解析
3. **解析要点**:
   - Timeline 包含四种类型，**全部要展示**：📌 Pinned / 🔁 Retweet / 💬 Quote / ✍️ Original
   - 提取：发布时间(CST)、完整内容、引用原文、转赞评统计、浏览量、图片URL
   - 用 `timeline-item` 分块解析 HTML
4. **日期过滤（关键！）**:
   - 解析每条推文的时间戳，转换为 CST (UTC+8)
   - **只保留今天（CST日期）发布的推文**
   - 如果今天没有任何新推文 → 发送简短通知："📭 {账号名} 今日无新推文（最近一条发布于 {日期}）"，不要把历史推文包装成日报
   - 对于跨时区的边界情况（如 UTC 前一天晚上 = CST 当天凌晨），以 CST 为准
5. **智能总结**: 不要照搬原文，用你的理解做中文摘要，保留关键信息：
   - 核心观点/事件是什么
   - 重要数据和数字
   - 互动量特别大的标注 🔥
   - 保留原文中的关键英文术语
   - 对用户有价值的洞察（技术、商业、政治动向）
6. **下载图片**: 从 pbs.twimg.com 下载到 workspace，用 message 工具 filePath 发送
7. **推送**: 用 message 工具发送到指定 channel

## 容错策略

- 如果首选数据源失败 → 读取 `{baseDir}/references/sources.md` 尝试备选
- 如果所有已知源都失败 → 用 web_search 搜索 "nitter instances" 或 "nitter alternative" 寻找新镜像
- 任何新发现（成功或失败）→ **更新 `{baseDir}/references/sources.md`**，为下次执行积累经验

## 输出格式

- 标题行：🐦 {账号名} 推文日报 | {日期}
- 每条推文：序号 + 类型标签 + 时间 + 智能摘要 + 统计数据
- 底部：数据源 + 抓取时间 + 推文数量统计

## 监控账号配置

见 `{baseDir}/references/accounts.md`
