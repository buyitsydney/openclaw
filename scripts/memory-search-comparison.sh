#!/bin/bash
# 记忆搜索对比测试：向量 vs FTS5 vs grep
# 用法: bash scripts/memory-search-comparison.sh "搜索词"
#
# 三种搜索完全独立运行，结果可直接对比

set -euo pipefail

DB=~/.openclaw/memory/main.sqlite
WORKSPACE=~/.openclaw/workspace
QUERY="${1:-}"

if [ -z "$QUERY" ]; then
  echo "用法: $0 \"搜索词\""
  echo ""
  echo "预置测试用例（直接复制运行）："
  echo "  bash $0 \"Mac Mini\"                # 精确关键词（grep/FTS5 强项）"
  echo "  bash $0 \"买了什么电脑\"            # 语义改写（向量强项）"
  echo "  bash $0 \"高老庄\"                  # 精确地名"
  echo "  bash $0 \"想去哪里吃饭\"            # 语义意图"
  echo "  bash $0 \"M4 Pro\"                  # 型号代码"
  echo "  bash $0 \"独立服务器的用途\"        # 抽象概念"
  echo "  bash $0 \"Jellyfin\"                # 英文产品名"
  echo "  bash $0 \"看电影的软件\"            # 语义等价"
  echo "  bash $0 \"杨哥\"                    # 人名（session 中才有）"
  exit 0
fi

echo "═══════════════════════════════════════════════════════════════"
echo "  搜索词: \"$QUERY\""
echo "═══════════════════════════════════════════════════════════════"
echo ""

# ──────────────────────────────────────────────────────
# 1. grep — 逐行精确匹配
# ──────────────────────────────────────────────────────
echo "━━━ [1/3] grep（精确文本匹配）━━━"
echo "搜索范围: $WORKSPACE/MEMORY.md + $WORKSPACE/memory/*.md"
echo ""
GREP_RESULT=$(grep -rn --include="*.md" "$QUERY" "$WORKSPACE/MEMORY.md" "$WORKSPACE/memory/" 2>/dev/null || true)
if [ -n "$GREP_RESULT" ]; then
  GREP_COUNT=$(echo "$GREP_RESULT" | wc -l | tr -d ' ')
  echo "命中 $GREP_COUNT 行:"
  echo "$GREP_RESULT" | head -20
  [ "$GREP_COUNT" -gt 20 ] && echo "... (截断，共 $GREP_COUNT 行)"
else
  echo "❌ 无结果"
fi
echo ""

# ──────────────────────────────────────────────────────
# 2. FTS5 BM25 — 全文索引关键词排序搜索
# ──────────────────────────────────────────────────────
echo "━━━ [2/3] FTS5 BM25（关键词排序搜索）━━━"
echo "搜索范围: SQLite chunks_fts 表 (已索引的 memory chunk)"
echo ""

# 构建 FTS5 查询：每个词加引号用 AND 连接
FTS_TOKENS=$(echo "$QUERY" | sed 's/[[:space:]]\+/ /g' | tr ' ' '\n' | sed 's/.*/"&"/' | tr '\n' ' ' | sed 's/ *$//' | sed 's/ / AND /g')
echo "FTS5 查询: $FTS_TOKENS"
echo ""

FTS_RESULT=$(sqlite3 "$DB" "
  SELECT path, start_line, end_line,
         bm25(chunks_fts) as rank,
         substr(text, 1, 120) as preview
  FROM chunks_fts
  WHERE chunks_fts MATCH '$FTS_TOKENS'
  ORDER BY rank ASC
  LIMIT 10;
" 2>/dev/null || true)

if [ -n "$FTS_RESULT" ]; then
  echo "路径 | 行范围 | BM25 rank | 预览"
  echo "─────────────────────────────────────"
  echo "$FTS_RESULT" | while IFS='|' read -r path sl el rank preview; do
    score=$(echo "1 / (1 + $rank)" | bc -l 2>/dev/null | head -c 6 || echo "?")
    echo "  $path L$sl-$el  rank=$rank  score≈$score"
    echo "    → ${preview:0:100}..."
    echo ""
  done
else
  echo "❌ 无结果（FTS5 只能匹配精确 token，语义改写查不到）"
fi
echo ""

# ──────────────────────────────────────────────────────
# 3. 向量余弦相似度 — 语义搜索
# ──────────────────────────────────────────────────────
echo "━━━ [3/3] 向量语义搜索（需要 embedding API）━━━"
echo "搜索范围: SQLite chunks_vec 表 (已索引的 memory chunk)"
echo ""

# 向量搜索无法在纯 shell 中执行（需要调 embedding API 获取 query 向量）
# 用 openclaw CLI 代替
if command -v pnpm &>/dev/null; then
  echo "调用 openclaw memory search..."
  echo "(这会同时触发向量 + FTS5 混合搜索，但结果主要反映向量语义匹配)"
  echo ""
  pnpm openclaw memory search "$QUERY" 2>/dev/null || echo "❌ CLI 搜索失败（gateway 未运行？）"
else
  echo "⚠️  pnpm 不可用，无法调用 openclaw CLI"
  echo "请在飞书对话中让 AI 调用 memory_search(\"$QUERY\") 测试"
fi

echo ""
echo "═══════════════════════════════════════════════════════════════"
echo "  对比总结"
echo "═══════════════════════════════════════════════════════════════"
echo ""
echo "  grep:  精确文本匹配，无排序，搜原始文件"
echo "  FTS5:  精确 token 匹配 + BM25 相关性排序，搜索已索引 chunk"
echo "  向量:  语义相似度匹配，措辞不同也能找到，搜索已索引 chunk"
echo ""
echo "  关键差异: grep 搜任何文件；FTS5/向量只搜已索引到 SQLite 的内容"
echo "  当前索引: $(sqlite3 "$DB" 'SELECT COUNT(*) FROM chunks;' 2>/dev/null || echo '?') 个 chunk, $(sqlite3 "$DB" 'SELECT COUNT(DISTINCT path) FROM chunks;' 2>/dev/null || echo '?') 个文件"
echo ""
