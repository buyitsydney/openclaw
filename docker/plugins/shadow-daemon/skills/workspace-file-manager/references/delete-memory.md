# 删除某个文档的记忆

> ⚠️ 写之前必读 [her-ux-principles.md](her-ux-principles.md)。

## 用户场景

用户说"删掉这个记忆"/"不要记这个文件了"/"忘掉 XX 文档"。

## Step 1 — 自动定位 + 给具体清单(能扫的不问)

按用户描述检索:
1. 用户给了精确文件名 → `find . -iname '<filename>'`
2. 用户给了关键词 → `memory_search` 先找一遍,看哪个文档命中
3. 用户说"最新那个"/"昨天那份"等模糊语 → `find ... -mtime -1`

**找到后报具体清单**:
```
我找到了:
  📄 docs/Q4-plan.pdf  — 8035 字符,2026-04-25 索引
  
要删它?
```

找到多个 → 列出让用户选哪个。找到 0 个 → "我没找到 `<keyword>`,你说的是不是 `<相似>`?"

## Step 2 — 给两种删除选项,默认建议保守的

```
两个选择:
  A) 只删记忆,原文件 docs/Q4-plan.pdf 留在工作空间 — 我建议这个(改主意了能再加回来)
  B) 连原文件一起删 — 不可逆

要 A 还是 B?
```

⏸ 等用户拍板。

## Step 3 — 执行 + 报结果

### 选 A(只删记忆)

如果原文件仍在监控目录里,只删 shadow 没用 — daemon 下次活动会重新索引。
所以"只删记忆"实际操作是:**把原文件 mv 出监控目录**(或删它)。

Shadow 文件顶部是 YAML front-matter(不是单行 `source:` 冒号后接值,而是 YAML 块,
键名 `source:` 开头,后跟绝对路径),所以解析要用严格的 YAML 前缀匹配:

```bash
# 找到原文件路径(精确匹配 "source: " 开头的那一行,避免误匹 "generated_at:" 等)
SHADOW=$(ls /data/.openclaw/workspace/memory/_shadow/*__*Q4-plan.pdf.md 2>/dev/null | head -1)
if [ -z "$SHADOW" ]; then echo "shadow not found"; exit 1; fi
SRC=$(awk '/^---$/{ if(in_fm) exit; in_fm=1; next } in_fm && /^source:/{ sub(/^source:[[:space:]]*/,""); print; exit }' "$SHADOW")
# 确认 SRC 是真实存在的文件
[ -f "$SRC" ] || { echo "source no longer exists"; exit 1; }
# mv 到工作空间根的 _archive/(daemon 不监控)
mkdir -p /data/.openclaw/workspace/_archive
mv "$SRC" /data/.openclaw/workspace/_archive/
```

(daemon 看到 source 消失,自动 GC 删 shadow,Her 不用手动)

报告:"✓ 我把 `Q4-plan.pdf` 移到 `_archive/` 了,memory_search 不再返回它。改主意了告诉我移回 docs/ 即可。"

### 选 B(彻底删)

```bash
rm -f "$SRC"
```

(daemon 看到删除事件,自动 GC shadow)

报告:"✓ `Q4-plan.pdf` 已彻底删除。"

## Step 4 — 验证

3-5s 后用 `memory_search` 同关键词复查 → 应该不再命中。命中了 → 等 daemon GC,通常 < 10s。

## 不要做的事

- ❌ 让用户手动删 shadow .md 文件(daemon 自己 GC)
- ❌ 让用户操作 `_config.json` 来"忘掉"单个文件(_config.json 是目录级,文件级用 mv/rm)
- ❌ 沉默等 GC
