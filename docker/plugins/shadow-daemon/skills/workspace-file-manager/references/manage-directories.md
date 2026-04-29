# 目录管理 + 状态监控

> ⚠️ 写之前必读 [her-ux-principles.md](her-ux-principles.md)。

## 用户场景

工作空间已接入(`ready: true`)。用户想:
- 加新目录索引("把 ~/projects/2026 也加进去")
- 停某个目录("别看 contracts/ 了")
- 看当前状态("daemon 现在咋样")
- 升级工具(error 多了 / 用户说"换个版本")

## 加目录("加 <目录>")

### Step 1 — 确认目录存在 + 看一眼内容(惊喜模式)

```bash
ls /data/.openclaw/workspace/<path>
find /data/.openclaw/workspace/<path> -maxdepth 2 -type f \
  \( -name '*.pdf' -o -name '*.docx' -o ... \) | wc -l
```

不存在 → "你说的 `<path>` 我没找到,是不是 `<相似路径>`?要我用那个吗?"

### Step 2 — 给具体数字 + 估时

```
找到 `projects/2026/` — 里面有 23 个文档(15 PDF, 6 Word, 2 Excel)。
加进去后 daemon 大约 2 分钟转完。开始?
```

⏸ 等同意。

### Step 3 — 改 _config.json + 一气呵成

读现有 config,append 新目录,原子写入:

```python
import json
p = "/data/.openclaw/workspace/memory/_shadow/_config.json"
cfg = json.load(open(p))
cfg["directories"].append({"path": "projects/2026", "recursive": True})
open(p+".tmp","w").write(json.dumps(cfg,indent=2))
import os; os.replace(p+".tmp", p)
```

(写完 daemon 自动检测 — 无需手动通知)

### Step 4 — 实时报进度

每 30s 或每 25%(以最快者为准)读 `_health.json` 的 `progress`,用 **`indexed_now`** 作分子、**`target_count`** 作分母、**`pct`** 作百分比:

```
🔄 加好了,正在转 23 个新文档...(indexed_now=N / target_count=23)
🔄 已索引 8/23 (35%)
🔄 已索引 16/23 (70%)
✓ 23/23 全部完成(实际耗时 1m48s)。memory_search 现在能搜到这批了。
```

**不要用 `indexed_total`**!那是 daemon 一生累计转换次数,单调递增,给用户会误导("这里才 20 个文档,为啥你说 150?")。


## 停目录("别看 <目录>" / "去掉 <目录>")

### Step 1 — 确认是这个目录

```
你说的是停止索引 `contracts/` 吗?
注:已经索引的 5 份合同会被删除(memory_search 不再返回它们)。
确认?
```

⏸ 等。

### Step 2 — 改 config + 报结果

```python
cfg["directories"] = [d for d in cfg["directories"] if d["path"] != "contracts"]
# 原子写
```

```
✓ contracts/ 不再监控。daemon 在清理旧 shadow,大约 5s。
```

读 `_health.json` 看 `progress` 中是否清完(converted 减少到稳定值)。

## 看状态("daemon 状态" / "/status")

读 `_health.json` 一次,翻译成产品语言:

```
📊 当前状态
  · 可以工作: ✓ (ready=true)
  · 监控目录: docs/, contracts/, projects/2026/    (watching_dirs)
  · 已索引: 47 个文档                                (indexed_now)
  · 进度: 47/50 (94%)                                (indexed_now/target_count — 有 3 个还在队列)
  · 最近错误: 0                                     (progress.errors_recent)
  · 最近一次活动: 2 分钟前(convert_ok projects/2026/Q4-plan.pdf)   (last_event + 算 ts 差)
```

如果 `ready: false`,告诉用户具体是哪一步缺(产品语言):
- `needs: "tools"` → "文档转换工具还没装,要装吗?"
- `needs: "config"` → "还没选要监控的目录,要扫一遍给你看吗?"

## 升级工具("升级 markitdown" / 错误率高时主动建议)

### 主动建议时机

- 最近 24h `errors > 5%` 且 大多是 "convert_failed" → 可能是 markitdown 版本兼容性
- 用户主动要求

### 流程

```bash
pip show markitdown 2>&1 | grep Version  # 当前版本
pip3 install --user --upgrade "markitdown[all]"  # 升级
pip show markitdown 2>&1 | grep Version  # 新版本
```

进度:"📦 升级 markitdown 大约 30s..." → 升级完毕 → "✓ 升到 X.Y.Z(从 A.B.C)。daemon 自动用新版本,旧文档无需重转"

(daemon 重新 import 自动用新版,Her 不需要发任何信号)

## 不要做的事

- ❌ 跟用户说 "intervalSec" "scanBudgetSec" "shadow file" 等内部字段
- ❌ 把 `_health.json` 原文倒给用户看(它是给 Her 读的接口,不是 UI)
- ❌ "originals=N submitted=M deleted=K" 这种工程数据 — 要翻译成"已索引 47 个,最近错误 0"
- ❌ 沉默等 daemon 跑完(必须周期报进度)
