# 首次安装与欢迎流程

daemon 就绪需要两个前提：markitdown 已安装 + _config.json 已创建。

## 步骤

1. 读 `memory/_shadow/_health.json`
   - 文件不存在 → `pgrep -fa shadow_daemon.py` 检查进程
     - 无进程 → 告诉用户 daemon 未运行，排查插件日志
     - 有进程 → 首次启动未跑完 cycle，等 30s 再读
   - `status = "idle_no_markitdown"` → 继续步骤 2
   - `status = "idle_no_config"` → 跳到步骤 5
   - `status = "cycle_complete"` → 已就绪，退出此流程

2. 告诉用户："文档转换工具还没安装,我来装一下?"
   **等用户确认,不要静默安装。**

3. 执行 `pip3 install --user "markitdown[all]" watchdog`
   - Dockerfile 已设 `PYTHONUSERBASE=/data/.openclaw/python` 和
     `PIP_BREAK_SYSTEM_PACKAGES=1`,所以 `--user` 会写入持久卷,
     容器重建/重启后 deps 自动保留,无需重装。
   - 必须带 `[all]`,否则 PDF 失败。
   - watchdog 是 daemon 的事件驱动核心,缺了 daemon 一直 idle_no_watchdog。

4. 验证:`pip show markitdown watchdog | grep Version`
   - 失败 → 贴错误信息给用户
   - 成功 → 告诉用户版本号
   - **关键(v7)**:执行 `kill -USR1 $(pgrep -f shadow_daemon.py)` 通知 daemon 立即重新探测 deps。
     daemon 是 100% 事件驱动的,不会自己轮询发现你装好了。不发信号 daemon 永远 idle。
     发完等 5s,读 _health.json 确认 `markitdown_available=true watchdog_available=true`。

5. 扫描 workspace 目录结构和文档文件分布:
   - 找目录:`find . -maxdepth 3 -type d ! -path '*/.*' ! -path '*/node_modules/*' ! -path '*/memory/*' ! -path '*/state/*'`
   - 找文档:`find . -maxdepth 3 -type f \( -name "*.pdf" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.pptx" \) ! -path '*/.*'`

6. 向用户展示发现结果,格式示例:
   > 我扫描了你的工作空间,发现:
   > 📁 docs/ — 12 个文档(8 PDF, 3 Word, 1 Excel)
   > 📁 contracts/ — 5 个 PDF
   > 根目录散落 3 个文件
   > 建议:监控 docs/ 和 contracts/,根目录的文件建议移到 docs/ 下。
   > 要我这样配置吗?

7. 等用户确认或修改目录选择。

8. 根据确认结果创建 `memory/_shadow/_config.json`(schema 见 [manage-directories.md](manage-directories.md))。
   - **写完 _config.json daemon 会自动通过 meta-watchdog 检测到,无需 SIGUSR1**。
   - 等 3-5s 后读 _health.json,应看到 `status: "watching"`。

9. 告诉用户:"配置完成,daemon 已开始监听并转换。我帮你盯着进度。"
   进入 [manage-directories.md](manage-directories.md) 的进度监控流程。

---

## v7 事件驱动备忘(给 Her 自己看)

daemon 是 dumb engine,所有状态切换由这些事件触发:

| 事件 | 触发条件 | daemon 行为 |
|---|---|---|
| `_config.json` 创建/修改/删除 | Her 写文件 | 自动 reinit,无需信号 |
| PYTHONUSERBASE site-packages 变化 | Her 装/卸 deps | 自动 reinit |
| `SIGUSR1` | Her 想强制 daemon 重探一切 | 立即 reinit |
| `SIGTERM` | 容器停止/supervisor | 优雅退出 |

**关键铁律**:Her 装/卸 markitdown 或 watchdog 之后,**必须**发 SIGUSR1。原因:刚装完
PYTHONUSERBASE 子目录可能还没产生 watchdog 监听的精确路径事件,信号是双保险。
卸的时候同理 — site-packages 删除可能不被 watchdog 完整捕捉,信号最干净。
