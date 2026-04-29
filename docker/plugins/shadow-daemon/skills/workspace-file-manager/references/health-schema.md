# `_health.json` 权威 Schema(Her 专用)

daemon 写,Her 读。唯一契约面。任何别的 reference 引用的字段都必须在这里列出。

## 产品层字段(Her 对用户说话时用这些)

| 字段 | 类型 | 说明 | 什么时候读 |
|------|------|------|------|
| `ready` | bool | 一切就绪可索引? | 任何时候判断 daemon 能不能干活 |
| `needs` | `"tools"` / `"config"` / `"recovery"` / `"restart"` / `null` | `ready=false` 时缺什么 | 决定下一步 |
| `progress.indexed_now` | int | 当前活的 shadow .md 数 | **给用户报"已索引 N 个文档"用这个** |
| `progress.indexed_total` | int | 累计转换过多少次(只增不减) | **不给用户看**,内部统计 |
| `progress.target_count` | int | daemon 监听范围里的源文件数(最近一次 sync) | 算进度分母 |
| `progress.pct` | float | 0-100,`100*cumulative_converted/target_count` | 给用户报百分比 |
| `progress.errors_recent` | int | `recent_errors` 长度 | 快速判断有没有问题 |
| `watching_dirs` | `[str]` | 当前监控的目录相对路径列表 | 给用户看"我在盯什么" |
| `last_event` | str / null | 人话 "convert_ok docs/foo.pdf" | 给用户最新动作 |
| `recent_events` | `[{path,kind,ts}]` | 最多 50 条 convert_ok 事件 | **验证"这个文件索引了吗"** |
| `recent_skips` | `[{path,reason,ts}]` | 最多 50 条跳过(超大/空/隐藏/symlink/source_gone 等) | 翻译 reason → 人话 |
| `recent_errors` | `[{path,kind,ts}]` | 最多 50 条错误(encoding_error/mime_mismatch/failed/oom/timeout 等) | 翻译 kind → 人话 |
| `limits.max_file_mb` | int | 单文件大小上限(MB) | 告诉用户"太大" |
| `limits.max_output_mb` | int | 单 shadow md 输出上限 | 告诉用户"摘要化" |
| `limits.archive_max_files` | int | zip 最大条目 | 告诉用户"压缩包太满" |
| `limits.extract_timeout_sec` | int | 单文件转换超时 | 告诉用户"太大太复杂" |

## 状态 → Her 行动 映射

| `ready` | `needs` | `progress.indexed_total` | Her 该做 |
|---|---|---|---|
| `true` | `null` | 任意 | 正常,给用户"监控 N 目录,当前有 M 个索引" |
| `false` | `"tools"` | `== 0` | 全新接入,走 [setup.md](setup.md) 整流程 |
| `false` | `"tools"` | `> 0` | **工具重装场景**:告诉用户"转换工具掉了要重装,但之前索引的 N 个历史都在,不会丢"。安装完继续,无需重新扫描 |
| `false` | `"config"` | 任意 | 工具齐,缺目录 config,走 setup.md Step 4-6 |
| `false` | `"recovery"` | 任意 | daemon 陷 reinit_error,告诉用户"我现在不太对,要我重启自己吗?"(docker kill PID)|
| `false` | `"restart"` | 任意 | daemon 已 stopped,supervisor 应自动重启。等 10s 复查 |

## 自动"整理错误/跳过"规则

- **源文件删除后**,daemon 会把该文件在 `recent_skips`/`recent_errors`/`recent_events` 里的条目**自动清掉**,所以 Her 看到的永远是"当前仍然存在的问题"。不用自己过滤时间戳
- **tombstone shadow**:失败的文件(encoding_error/mime_mismatch 等)会**也生成 shadow.md**,里面是空 body + `status: <kind>`,这样 daemon 下轮 reconcile 不会重试 + memory_search 不会召回内容。Her 给用户报失败时用 `recent_errors`,**不用读 shadow 文件本身**

## 内部字段(**Her 永远不给用户看**)

v8.4 起全部结构性隔离到 `_internal:{}` 子对象。Her **永远不读 `_internal` 任何字段**给用户。只有运维/工程 debug 时才看:

```json
"_internal": {
  "status": "watching" | "idle_no_*" | "reinit_error" | "stopped",
  "markitdown_available": bool,
  "markitdown_version": "0.1.5",
  "watchdog_available": bool,
  "watchdog_version": "6.0.0",
  "last_run": "2026-04-28T...",
  "cumulative_converted": int,    // lifetime 累计,只增不减
  "cumulative_skipped": int,
  "cumulative_errors": int,
  "config_dirs": ["docs/"],
  "watching": bool,
  "max_workers": 8,
  "debounce_ms": 500
}
```

`config_dirs` 跟顶层的 `watching_dirs` 看起来像,但它是**调试快照**,Her 用 `watching_dirs`(产品层,永远保证可用)。

## 两态对照(`ready=false` vs `ready=true` 字段实际值)

| 字段 | `ready=false needs=tools` | `ready=false needs=config` | `ready=true`(正常工作) |
|------|---|---|---|
| `ready` | `false` | `false` | `true` |
| `needs` | `"tools"` | `"config"` | `null` |
| `progress.indexed_now` | 0 (或遗留 shadow) | 0 (或遗留) | 实时 |
| `progress.target_count` | 0 | 0 | 最近 sync 源数 |
| `progress.pct` | 100 (边界) | 100 (边界) | 0-100 |
| `progress.indexed_total` | 累计(历史重装前的量) | 累计 | 累计 |
| `progress.errors_recent` | 0 (首次) 或 历史 | 0 | 0-50 |
| `watching_dirs` | `[]` | `[]` | `["docs/", ...]` |
| `last_event` | null (未开工) / 历史 | null / 历史 | 最新 "convert_ok ..." |
| `last_event_at` | null / 历史 | null / 历史 | 最新 ISO 时间戳 |
| `recent_events` | `[]` (首次) / 历史 | `[]` / 历史 | 最多 50 条 |
| `recent_skips/errors` | `[]` / 历史 | `[]` / 历史 | rolling 50 条 |
| `limits` | 完整 (Her 仍可读限制) | 完整 | 完整 |
| `_internal.status` | `idle_no_watchdog` / `idle_no_markitdown` | `idle_no_config` / `idle_no_valid_dirs` | `watching` |
| `_internal.watchdog_available` | false 或 true(只缺 markitdown 时) | true | true |
| `_internal.cumulative_*` | ≥0 (重装场景可能非 0) | ≥0 | ≥0 |

**Her 判断流程**:看 `ready` + `needs` 拿 2 分支决策。`progress.indexed_total > 0` 是区分"全新接入"vs"工具重装"的关键。

## 反模式(Her 做了就是错)

- ❌ 给用户说"cumulative_converted = 150"(语义错,用户以为现在有 150 个)
- ❌ 读 `recent_events` 判断是不是 ready(读 `ready` 布尔就行)
- ❌ 读 `status` 字符串决策(用 `ready`+`needs` 产品语义决策)
- ❌ 给用户报进度用 `indexed_total`,应该用 `indexed_now` 或 `pct`
- ❌ 硬编码"20 个 zip 上限 / 5MB 输出上限",应该读 `limits.archive_max_files` / `limits.max_output_mb`
