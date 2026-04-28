# 把工作空间接进 memory_search(首次设置)

> ⚠️ 写之前必读 [her-ux-principles.md](her-ux-principles.md)。

## 用户场景

用户希望以后 @ Her 找文档时能直接 `memory_search` 命中具体内容,不用每次现想。

## 流程(全程对用户可见)

### Step 1 — 看 daemon 是否就绪

读 `memory/_shadow/_health.json`:
- `ready: true` → 已就绪,跳到 [manage-directories.md](manage-directories.md) 的"加目录"流程
- `ready: false` 且 `needs: "tools"`:
  - 且 `progress.indexed_total == 0` → **全新接入**,走 Step 2-8 完整流程
  - 且 `progress.indexed_total > 0` → **工具重装场景**:告诉用户"转换工具掉了要重装,但之前索引的 N 个历史都在,不会丢"。跑 Step 2-3(装工具),自动恢复到 ready。**不要重做 Step 4-6**(config 还在)
- `ready: false` 且 `needs: "config"` → 跳 Step 4(工具齐全,只差选目录)
- `ready: false` 且 `needs: "recovery"` → 告诉用户"我这边有点问题,要我重启自己吗?"。等用户同意,再让用户在容器里 `kill $(pgrep -f shadow_daemon.py)` (supervisor 自动起新的)
- `ready: false` 且 `needs: "restart"` → daemon 已停,supervisor 应自动拉起。等 10s 重读 health

文件不存在 → daemon 还没起来,等 30s 重读。仍没有 → 告诉用户 daemon 没运行,需要排查(不是用户该解决的)。

### Step 2 — 征求安装同意 + 预报时间

```
我看到你工作空间还没接 memory_search。要不要我接上?
我会装一个文档转换工具(markitdown + watchdog,大约 30s),然后开始扫描你的文档。
```

⏸ 等用户确认。

### Step 3 — 装工具 + 报进度

执行:
```bash
pip3 install --user "markitdown[all]" watchdog
```
(daemon 镜像已配好 PIP_BREAK_SYSTEM_PACKAGES 等,Her 不用关心 pip 内部)

**装完后,daemon 会自动检测到 deps 就位 — 不用手动通知**。

进度汇报节奏(必做):
- T+0:"📦 开始装,大约 30s..."
- 装完:`pip show markitdown watchdog` 拿版本号
- T+完成:"✓ 装好(实际耗时 Xs),markitdown <ver> + watchdog <ver>。下一步:扫描你的文档"

失败:贴 pip 错误的最后 1-2 行,问用户要不要重试。

### Step 4 — 扫描 + 给建议(惊喜模式)

Her 自己 `find`,**不问用户目录**。默认 exclude 要严(Her-style workspace 经常全是代码/persona 文件):

```bash
find /data/.openclaw/workspace -maxdepth 3 -type f \
  \( -name '*.pdf' -o -name '*.docx' -o -name '*.xlsx' -o -name '*.pptx' \
     -o -name '*.md' -o -name '*.txt' -o -name '*.html' \) \
  ! -path '*/.*' \
  ! -path '*/node_modules/*' ! -path '*/.git/*' ! -path '*/venv/*' ! -path '*/.venv/*' \
  ! -path '*/memory/*' ! -path '*/state/*' ! -path '*/.state/*' \
  ! -path '*/archive/*' ! -path '*/stress-test/*' ! -path '*/.worktrees/*' ! -path '*/.claude/*' \
  ! -path '*/carher-*/*' ! -path '*/wt-*/*' ! -path '*/__pycache__/*'
```

按目录分组统计。判断:
- 哪些是明显内容目录(docs/ contracts/ projects/ ...)→ 建议监控
- 根目录散落文件 → 建议 mv 到 docs/(惊喜:Her 主动整理)
- 明显垃圾目录(.git/ tmp/ 大量 png 截图)→ 不监控,告诉用户跳过的原因

**识别 Her persona 工作区**:如果根目录有 `SOUL.md`/`MEMORY.md`/`IDENTITY.md`/`USER.md`/`AGENTS.md`/`HEARTBEAT.md` 这几个,或者有 `carher-*/` `wt-*/` 工作树目录 → 这是 Her 自己的 workspace,**默认只推荐 `docs/`**,其他 `wiki/` `research/` `projects/` 类目录**必须让用户逐个确认**(可能混了归档/工程产物)。

**默认 exclude 根目录这几个文件**(bootstrap 已注入 Her context,再索引=双轨重复):
`SOUL.md`、`MEMORY.md`、`IDENTITY.md`、`USER.md`、`AGENTS.md`、`HEARTBEAT.md`、`CLAUDE.md`(如果是 Her 自己的)

**散落文件整理(≥10 条主动建议)**:扫完后如果**根目录有 ≥ 10 个 .md/.txt/.pdf 散落文件(且没被 exclude 规则过滤)**,Her 必须主动建议:
> "你根目录有 12 个散落文档(notes/待办/会议纪要这类),我建议新建 `docs/notes/` 把它们统一放进去 + 监控。这样以后新文档直接扔那就行,不再散在根目录。要这样整理吗?"

用户同意后一气呵成:`mkdir -p docs/notes && mv *.md *.txt docs/notes/`(排除掉 exclude 清单里的 persona 文件)。**不要**把每个散落文件都当目录去索引,根目录本身不是干净的监控区。

### Step 5 — 一句话报告 + 具体建议

```
扫完了:
📁 docs/      — 12 个文档(8 PDF, 3 Word, 1 Excel)
📁 contracts/ — 5 份合同 PDF
根目录散落 3 个 PDF — 看起来该归 docs/ 下

建议:监控 docs/ 和 contracts/,我帮你把根目录 3 个 mv 到 docs/。
这样配吗?
```

⏸ 等用户拍板。用户说"嗯/好/可以" → Step 6 一气呵成。说"自己来" → Step 6 跳过 mv,只写 config。

### Step 6 — 一气呵成执行

```bash
# 先 mv(如果用户同意)
mv /workspace/根目录散落.pdf /workspace/docs/...

# 再写 _config.json
cat > /data/.openclaw/workspace/memory/_shadow/_config.json <<'EOF'
{
  "version": 1,
  "directories": [
    {"path": "docs", "recursive": true},
    {"path": "contracts", "recursive": true}
  ],
  "maxFileMB": 50,
  "maxWorkers": 8
}
EOF
```

**写完 daemon 自动开始转换 — 不用手动通知**。

### Step 7 — 转换中实时报进度

读 `_health.json` 的 `progress`,**必看三个字段**:
- `indexed_now`:当前有 shadow 的源文件数(转一个长一个,删一个减一个)
- `target_count`:监控目录里的源文件总数(用作进度分母)
- `pct`:0-100,daemon 自己算好的

```
📁 配好了,daemon 已开始转换 17 个文档,大约 1 分钟内完成(转换不是实时,reconcile 周期 15s,我每 30s 读一次进度)。
🔄 已索引 5/17 (29%)   ← 读 indexed_now / target_count / pct
🔄 已索引 12/17 (70%)
✓ 17/17 全部完成(实际耗时 73s)。

现在你可以在群里 @我 问"XX 项目设计文档"/"XX 合同条款",我直接给你具体内容片段。
```

**不是实时**:daemon reconcile 周期约 15s + 单文件转换要 50ms-秒级(PDF 可能分钟),所以从你写 config 到第一个 shadow 出现通常 3-30s。告诉用户这个体感。

### Step 8 — 收尾:把维护权交回用户

```
之后:
- 往 docs/ 或 contracts/ 丢新文档,我会自动索引(无需通知)
- 想加新目录监控,告诉我"加 <目录>"
- 想停某个目录,告诉我"别看 <目录>"
- 想知道当前状态,问"daemon 状态"

收工。
```

## 失败兜底

| 现象 | Her 该说 |
|---|---|
| `pip install` 网络失败 | "❌ 装工具失败,网络似乎不通(<错误一行>),要再试吗?或我先放着,你处理网络后跟我说" |
| `pip` 装完了但 5s 后 `ready` 还是 false | "🤔 装好了但 daemon 没识别,我等 30s 再看一次" → 仍 false → "❌ daemon 识别失败,需要我重启 daemon 吗?(有副作用,也可以先放着)" |
| 扫到 0 个文档 | "🤷 你的工作空间没找到 PDF/Word/MD 等文档。要换个目录扫,还是先这样?" |
| 用户拒绝建议 | "OK,告诉我你想监控哪些目录,我直接配" → 这是开放题但用户主动说不,合理 |

## 不要做的事

- ❌ 跟用户说 `idle_no_markitdown` `idle_no_watchdog` `reinit_error` 等内部状态名
- ❌ 跟用户说 `SIGUSR1` `PYTHONUSERBASE` `pgrep -f shadow_daemon` 等内部命令
- ❌ 沉默 30s 不报进度
- ❌ 反问"你想要什么配置?"这种开放题
