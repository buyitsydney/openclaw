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

2. 告诉用户："文档转换工具还没安装，我来装一下？"
   **等用户确认，不要静默安装。**

3. 执行 `pip3 install --break-system-packages "markitdown[all]"`
   必须带 `[all]`，否则 PDF 失败。

4. 验证：`pip show markitdown | grep Version`
   - 失败 → 贴错误信息给用户
   - 成功 → 告诉用户版本号，等 30s 重读 _health.json 确认 `markitdown_available = true`

5. 扫描 workspace 目录结构和文档文件分布：
   - 找目录：`find . -maxdepth 3 -type d ! -path '*/.*' ! -path '*/node_modules/*' ! -path '*/memory/*' ! -path '*/state/*'`
   - 找文档：`find . -maxdepth 3 -type f \( -name "*.pdf" -o -name "*.docx" -o -name "*.xlsx" -o -name "*.pptx" \) ! -path '*/.*'`

6. 向用户展示发现结果，格式示例：
   > 我扫描了你的工作空间，发现：
   > 📁 docs/ — 12 个文档（8 PDF, 3 Word, 1 Excel）
   > 📁 contracts/ — 5 个 PDF
   > 根目录散落 3 个文件
   > 建议：监控 docs/ 和 contracts/，根目录的文件建议移到 docs/ 下。
   > 要我这样配置吗？

7. 等用户确认或修改目录选择。

8. 根据确认结果创建 `memory/_shadow/_config.json`（schema 见 [manage-directories.md](manage-directories.md)）。

9. 告诉用户："配置完成，daemon 将在下个周期开始转换。我帮你盯着进度。"
   进入 [manage-directories.md](manage-directories.md) 的进度监控流程。
