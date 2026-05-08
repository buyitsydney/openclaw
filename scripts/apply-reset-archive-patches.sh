#!/bin/bash
# No-op stub.
#
# 2026-05-08:P7 patch set (对应 PR #76666 "eagerly preload session transcript
# listeners at gateway startup") 已**撤回**,原因:
#
# P7-inner 让 builtin backend cold start 时触发 ensureSessionListener() init,
# 这个 init 同步扫 files 表 × stat 磁盘 × 算 hash 对 diff,**同步阻塞 Node
# event loop**。在 carher 真实数据体量下测试:
#
#   - carher-200 (376 files / 13,911 chunks):stall 3 分 49 秒
#   - carher-13  (1,203 files / 62,831 chunks):stall 22+ 秒,飞书消息无响应
#
# upstream PR #76666 body 引用的 benchmark 是小数据 (+41 chunks),没测过
# carher fleet 这种体量。在 chunks 持续累积的情况下,每次 cold start stall
# 时间只会越来越长,不会减少(增量 hash 对比本身也要 IO + CPU)。
#
# 替代方案 — cron 兜底(fleet 侧做):
#   定期跑 `openclaw memory index --force` 补 race window 漏的 archive
#   race 的实际影响:`/reset` 后 first `memory_search` 前的窗口 archive emit
#   被 dropped,cron 每天补一次 → 最坏延迟 24h 可查到新 archive。
#
# 本 script 保留文件(Dockerfile 依赖 COPY + RUN),内容变 no-op。等 upstream
# 合并 PR #76666 的正式实现(大概率会做 async chunking 不阻塞主循环),再
# 决定是否重新 patch。
#
# 已合并的老 patches(不需要本地再打):
#   patch4 (memory-core archiveMarker passthrough) ✅ upstream 通过
#       session-transcript-hit-*.js 原生 support 归档文件 stem 解析

echo "apply-reset-archive-patches.sh: no-op (P7 撤回,详见文件内注释)"
exit 0
