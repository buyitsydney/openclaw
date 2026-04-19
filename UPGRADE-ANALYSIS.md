# CarHer Upgrade Analysis: OpenClaw v2026.4.2 → v2026.4.14

**Date:** 2026-04-14  
**Author:** Claude (Tech Lead review pending)  
**CarHer Branch:** `feat/skills-two-layer` @ `e10dc0c140`  
**Upstream Range:** `v2026.4.2..v2026.4.14`

---

## 1. 上游改动概览

| 指标        | 数值                                             |
| ----------- | ------------------------------------------------ |
| Commit 数量 | 6,461                                            |
| 涉及文件    | 10,082                                           |
| 插入行数    | 761,254                                          |
| 删除行数    | 384,043                                          |
| 中间版本    | v2026.4.5, 4.7, 4.8, 4.9, 4.10, 4.11, 4.12, 4.14 |

### 按模块的 commit 分布（Top 15）

| 模块          | Commits | 风险评估                                        |
| ------------- | ------- | ----------------------------------------------- |
| ci            | 258     | 低 — CI 改动不影响 CarHer Docker 部署           |
| agents        | 172     | **中** — CarHer 有 live-model-filter 定制       |
| plugins       | 148     | **中** — plugin-sdk API 有 373 个 commit        |
| ui            | 118     | 低 — CarHer 不使用 Web UI                       |
| test          | 104     | 低 — 测试代码冲突易解决                         |
| gateway       | 90      | **中** — 网关模式默认值从 unset 改为 'local'    |
| providers     | 80      | 低 — CarHer 用定制 provider routing             |
| config        | 68      | **高** — 多项 config migration/breaking changes |
| discord       | 62      | 低 — CarHer 不使用                              |
| secrets       | 57      | 低                                              |
| feishu (上游) | 47      | **高** — CarHer 有 feishu-her 深度定制          |
| browser       | 45      | 低 — SSRF 策略调整，不影响核心                  |
| telegram      | 44      | 低                                              |
| cron          | 39      | 中 — 运行时 seam 有变化                         |
| memory        | 41      | 中 — embedding adapter 有修复                   |

---

## 2. CarHer 定制文件清单

CarHer 相对于 upstream/main 有 **~280 个定制文件**，主要分布在：

### 2.1 核心定制模块（高价值，需重点保护）

- **`extensions/feishu-her/`** — 飞书深度定制插件（~100 文件）
  - gateway, outbound, tools (docx/sheet/calendar/bitable/wiki/drive等)
  - discussion mode, group mode, bot registry
  - OAuth, memory bridge, model shortcuts
- **`extensions/realtime/`** — 车载实时语音（~20 文件）
- **`docker/`** — Docker 部署配置、a2a-gateway 插件、skills
- **`docker/plugins/a2a-gateway/`** — A2A 协议网关插件（~40 文件）

### 2.2 配置与脚本

- `Dockerfile.carher`, `scripts/carher-entrypoint.sh`
- `docker/carher-config.json`, `docker/shared-config.json5`, `docker/server.env`
- `docker/user-configs/carher-config-10[1-4].json`
- `start-*.sh` 启动脚本集
- `.cursor/skills/`, `skills/` — Cursor/CarHer 专用 skills

### 2.3 文档

- `docs/her/` — 约 40 个 CarHer 专有文档

---

## 3. 冲突分析

### 3.1 确定会冲突的文件（18 个）

以下文件在 **上游和 CarHer 都有修改**：

| 文件                                           | 冲突风险 | 说明                                                                                 |
| ---------------------------------------------- | -------- | ------------------------------------------------------------------------------------ |
| `package.json`                                 | **高**   | 版本号 + 依赖变更，双方都改了                                                        |
| `pnpm-lock.yaml`                               | **高**   | 必定冲突，需 regenerate                                                              |
| `extensions/feishu/src/docx.ts`                | **高**   | 上游重构了 provider channel readers + QR 流程；CarHer 有 pdftotext/officeparser 定制 |
| `src/config/sessions/group.ts`                 | **高**   | 上游重构了 session binding + channel bootstrap；CarHer 有 runtime-group-policy 定制  |
| `src/agents/live-model-filter.ts`              | **中**   | 上游重构了 lowercase helpers；CarHer 有模型过滤定制                                  |
| `src/agents/models-config.providers.static.ts` | **中**   | 上游有 provider 变更                                                                 |
| `.oxlintrc.json`                               | 低       | lint 配置                                                                            |
| `AGENTS.md`                                    | 低       | 文档                                                                                 |
| `docs/cli/plugins.md`                          | 低       | 文档                                                                                 |
| `docs/providers/ollama.md`                     | 低       | 文档                                                                                 |
| `extensions/acpx/package.json`                 | 中       | ACPX 扩展包配置                                                                      |
| 6 个 test 文件                                 | 低       | 测试文件冲突易解决                                                                   |

### 3.2 间接冲突风险

1. **Plugin SDK API 变更 (373 commits)**  
   feishu-her 大量依赖 plugin-sdk 的类型和接口。上游进行了：
   - task contract 拆分 (`split runtime task contracts`)
   - TTS facade 类型拆分
   - reply payload 类型收窄
   - outbound adapter 叶类型变更  
     → **feishu-her 的 import 和类型定义可能需要适配**

2. **Config migration / breaking changes**  
   上游有多项 config 迁移：
   - `gateway.mode` 默认值改为 `local`
   - config alias 迁移 (private-network, room allow, etc.)
   - 新增 context visibility 功能  
     → **CarHer 的 `docker/carher-config.json` 和 `docker/shared-config.json5` 需要对齐**

3. **上游 feishu 扩展变更 (47 commits)**  
   上游 feishu 扩展新增了 QR code onboarding、docx upload refactor 等。CarHer 的 feishu-her 从上游 feishu fork 而来，可能需要同步这些基础功能。

4. **Import path 重构**  
   上游有大量 `perf: narrow * imports` 和 `refactor: dedupe` commits，改变了内部 import 路径。feishu-her 如果引用了被重构的路径，编译时会报错。

---

## 4. 合并策略建议

### 推荐方案：**Merge（非 Rebase）+ 分步验证**

#### 理由

1. **Rebase 不可行**：6461 个 commit rebase 到 CarHer 分支上，每个冲突点都要手动解决，工作量不可控
2. **Merge 保留历史**：一次 merge commit 清晰标记升级边界，回滚简单
3. **与上次升级一致**：`upgrade-0402` 也是 merge 方式合入的

#### 具体步骤

```
Phase 1: 准备（当前阶段 ✓）
  - 分析改动范围 ← 本文档
  - 识别冲突文件 ← 已完成

Phase 2: 创建升级分支 & Merge
  1. git checkout -b upgrade-0414 feat/skills-two-layer
  2. git merge v2026.4.14 --no-commit  # 先不提交，检查冲突
  3. 逐个解决冲突文件

Phase 3: 冲突解决优先级
  P0 (必须人工审查):
    - extensions/feishu/src/docx.ts — CarHer 的 pdftotext 定制 vs 上游重构
    - src/config/sessions/group.ts — 运行时分组策略定制
    - package.json — 合并依赖

  P1 (编译验证):
    - pnpm-lock.yaml — 删除后 pnpm install 重新生成
    - plugin-sdk 类型适配 — 编译 feishu-her 检查类型错误
    - import path 变更 — 编译全量检查

  P2 (低风险):
    - 文档 / lint 配置 / 测试文件 — 以上游为准 + 保留 CarHer 定制

Phase 4: 编译验证
  1. pnpm install
  2. pnpm build（全量编译）
  3. 重点检查 feishu-her 编译结果

Phase 5: 功能验证
  1. Docker 构建测试（Dockerfile.carher）
  2. 核心功能冒烟测试：飞书消息收发、docx 处理、group mode
  3. realtime 语音模块编译检查
```

### 风险点

| 风险                     | 影响                | 缓解措施                                      |
| ------------------------ | ------------------- | --------------------------------------------- |
| plugin-sdk 类型不兼容    | feishu-her 编译失败 | 编译后逐个修复类型错误                        |
| config 迁移未适配        | 运行时异常          | 对照上游 migration commits 更新 CarHer config |
| pnpm-lock.yaml 冲突      | 构建失败            | 删除后重新生成                                |
| 上游 feishu 基础功能变更 | feishu-her 功能回退 | 对比上游 feishu 47 个 commit，同步必要改动    |
| import path 变更         | 编译错误            | 全量编译 + grep 检查                          |

### 估计冲突解决工作量

- 自动合并：绝大部分文件（CarHer 定制文件与上游无交集）
- 手动解决：~18 个冲突文件（其中 3 个需要仔细审查）
- 编译适配：可能需要修复 feishu-her 的 10-30 个 import/type 错误
- 总体可控，建议一次性 merge，不需要分步合入中间版本

---

## 5. 待确认事项

1. **feishu/src/docx.ts 冲突策略**：CarHer 用 pdftotext 替换了 officeparser，上游也重构了这个文件。需要 Her 确认保留哪些改动。
2. **gateway.mode 默认值**：上游改为 'local'，CarHer Docker 部署是否受影响？
3. **config migration**：是否需要运行 `doctor` 命令适配新的 config 格式？
4. **a2a-gateway 插件**：是否需要同步上游的 A2A 相关改动（如果有的话）？

---

_等待 Her review 后开始 Phase 2。_
