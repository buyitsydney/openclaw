#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RESULTS_DIR="$HOME/.openclaw/workspace/ground-truth"

AGENT="main"
MAX_RESULTS=8
MIN_SCORE=0.25
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
OUTPUT_JSON="$RESULTS_DIR/cli_bench_${TIMESTAMP}.json"
OUTPUT_MD="$RESULTS_DIR/cli_bench_${TIMESTAMP}.md"

declare -a QUESTIONS=(
  "Q01|之前配置新LLM失败，正确方法是什么？"
  "Q02|上次把生产环境搞崩了是怎么回事？"
  "Q03|cron 提醒设置踩过哪些坑？"
  "Q04|memory search 之前测试过，结论是什么？"
  "Q05|飞书文档写入出过什么 bug？"
  "Q06|杨哥是谁，跟天哥什么关系？"
  "Q07|旭东和天哥最后一次见面是什么情况？"
  "Q08|小刘是谁，什么时候见过？"
  "Q09|老王是谁，约过什么事？"
  "Q10|天哥的核心团队有哪些人？"
  "Q11|Mac Mini 什么时候买的，什么时候到货？"
  "Q12|天哥什么时候从 Momenta 离职的？"
  "Q13|Autolink 是怎么决定加入的？"
  "Q14|飞书连接出过什么故障，怎么解决的？"
  "Q15|最近两周做了哪些重要的技术决策？"
  "Q16|browser 自动化用哪个 profile？"
  "Q17|怎么查看 gateway 运行日志？"
  "Q18|Docker 容器分别是干什么用的？"
  "Q19|TTS 语音应该怎么用，之前犯过什么错？"
  "Q20|怎么读取天哥的 Apple Notes？"
  "Q21|高老庄饭店是哪次去的，在哪？"
  "Q22|天哥家在哪个小区？"
  "Q23|和旭东道别是在哪里？"
  "Q24|为什么选 Opus 不用便宜模型？"
  "Q25|Gemini 模型测试过吗，表现怎么样？"
  "Q26|为什么 session transcript 也纳入搜索索引？"
  "Q27|这两周所有提到过的人名列表？"
  "Q28|所有出过的技术故障/bug 汇总？"
  "Q29|天哥的健康相关记录有哪些？"
  "Q30|天哥新买的那台电脑"
  "Q31|语音助手出了什么问题"
  "Q32|上次吃饭去了哪家店"
  "Q33|那个搞崩了的配置问题"
  "Q34|董事长什么时候见过"
  "Q35|天哥最近在忙什么"
)

echo "======================================"
echo " Memory Search CLI Benchmark"
echo " Agent: $AGENT"
echo " maxResults: $MAX_RESULTS  minScore: $MIN_SCORE"
echo " Time: $(date)"
echo "======================================"
echo ""

JSON_RESULTS="["
MD_TABLE="| Q | 查询 | 结果数 | 最高分 | 最低分 | snippet前80字 |\n|---|------|--------|--------|--------|---------------|\n"

hit=0; partial=0; miss=0; total=0

for entry in "${QUESTIONS[@]}"; do
  qid="${entry%%|*}"
  query="${entry#*|}"
  total=$((total + 1))

  raw=$(cd "$REPO_DIR" && npx openclaw memory search "$query" --json --agent "$AGENT" --max-results "$MAX_RESULTS" --min-score "$MIN_SCORE" 2>/dev/null || echo '{"results":[]}')

  count=$(echo "$raw" | python3 -c "import sys,json; d=json.load(sys.stdin); print(len(d.get('results',[])))" 2>/dev/null || echo 0)
  max_score=$(echo "$raw" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(f'{max(x[\"score\"] for x in r):.4f}' if r else '—')" 2>/dev/null || echo "—")
  min_score_val=$(echo "$raw" | python3 -c "import sys,json; d=json.load(sys.stdin); r=d.get('results',[]); print(f'{min(x[\"score\"] for x in r):.4f}' if r else '—')" 2>/dev/null || echo "—")
  snippet=$(echo "$raw" | python3 -c "
import sys,json
d=json.load(sys.stdin)
r=d.get('results',[])
if r:
    s=r[0]['snippet'][:80].replace('\n',' ').replace('|',' ')
    print(s)
else:
    print('(无结果)')
" 2>/dev/null || echo "(error)")

  printf "  %-4s  count=%-2s  max=%-6s  %s\n" "$qid" "$count" "$max_score" "${query:0:30}"

  sep=""
  [ "$total" -gt 1 ] && sep=","
  JSON_RESULTS="${JSON_RESULTS}${sep}{\"q\":\"$qid\",\"query\":$(python3 -c "import json; print(json.dumps('$query'))"),\"count\":$count,\"max_score\":\"$max_score\",\"min_score\":\"$min_score_val\",\"raw\":$(echo "$raw" | python3 -c "import sys,json; print(json.dumps(json.load(sys.stdin)))")}"

  MD_TABLE="${MD_TABLE}| $qid | ${query:0:25} | $count | $max_score | $min_score_val | ${snippet:0:60} |\n"
done

JSON_RESULTS="${JSON_RESULTS}]"

echo "$JSON_RESULTS" | python3 -m json.tool > "$OUTPUT_JSON"

{
  echo "# CLI Bench — $TIMESTAMP"
  echo ""
  echo "**配置**: agent=$AGENT, maxResults=$MAX_RESULTS, minScore=$MIN_SCORE"
  echo "**hybrid**: vectorWeight=0.7, textWeight=0.3, MMR λ=0.4"
  echo "**索引**: $(sqlite3 ~/.openclaw/memory/main.sqlite 'SELECT COUNT(*) FROM chunks;') chunks"
  echo ""
  echo -e "$MD_TABLE"
  echo ""
  echo "---"
  echo "脚本自动生成，无 session 污染"
} > "$OUTPUT_MD"

echo ""
echo "======================================"
echo " Done! $total questions tested"
echo " JSON: $OUTPUT_JSON"
echo " MD:   $OUTPUT_MD"
echo "======================================"
