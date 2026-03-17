---
name: openclaw-skill-creation
description: 创建和管理 OpenClaw agent skills。Use when adding a new skill, creating SKILL.md, modifying skill loading/filtering, or understanding skill architecture.
---

# Skill 创建与管理

## 两套 skill：bundled vs 全员

| 类型        | 位置                         | 谁管              | 能改吗                |
| ----------- | ---------------------------- | ----------------- | --------------------- |
| **Bundled** | `repo/skills/<name>/`        | OpenClaw upstream | 不改，避免 merge 冲突 |
| **全员**    | `~/.openclaw/skills/<name>/` | 我们自己          | 自由管理，不在 git 里 |

全员层优先级高于 bundled。同名 skill 全员层自动覆盖 bundled 版。

**创建新 skill 时**：如果是 CarHer 企业定制的，放全员层。如果要贡献给 upstream，才放 repo。

## Skill 文件结构

```
<name>/
├── SKILL.md          # 必须，name + description 在 frontmatter
├── references/       # 可选，按需加载的文档
├── scripts/          # 可选，可执行脚本
└── assets/           # 可选，模板/图片等输出资源
```

## SKILL.md 格式

```yaml
---
name: my-skill
description: 做什么 + 什么时候触发。description 是触发机制，写清楚。
---
# 正文（触发后才加载）
```

- `name` + `description`：必填。description 决定是否触发，要写清楚触发条件
- 正文在触发后才加载到 context，平时不占 token
- 正文控制在 500 行以内，超出拆到 references/

## 最新版 skill-creator

Anthropic 官方最新 skill-creator 在 `github.com/anthropics/skills` 仓库。本地全员层 `~/.openclaw/skills/skill-creator/` 是该版本 + CarHer 适配，包含：

- 完整 eval 闭环（with_skill vs without_skill 对比）
- blind A/B comparison（盲测）
- description 触发率优化
- CarHer 三层路径规范
- 定时任务（cron）skill 的执行模型和 payload 设计规范

## 禁止事项

- 不要修改 `repo/skills/` 下的文件（upstream 会冲突）
- 不要在 SKILL.md 里写死绝对路径（`/Users/xxx/` 或 `/data/.openclaw/`）
- 不要在 repo 根目录创建 `.clawhub/` 目录

## Skill 加载机制

```
扫描所有 skill 目录 → 解析 frontmatter → 过滤（enabled/allowBundled/requires/os）
→ 注入 system prompt 的 <available_skills> 列表（只有 name + description）
→ 用户消息匹配 description → 触发 → agent 用 read 工具读取 SKILL.md 正文
```

## 配置

```json
// openclaw.json
{
  "skills": {
    "allowBundled": ["weather", "github"], // 白名单，空=全部启用
    "entries": {
      "my-skill": { "enabled": false } // 单个禁用
    }
  }
}
```
