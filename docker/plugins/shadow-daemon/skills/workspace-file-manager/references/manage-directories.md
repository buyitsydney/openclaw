# 目录管理与状态监控

## _config.json schema

位置：`memory/_shadow/_config.json`，daemon 每个 cycle 热加载。

```json
{
  "version": 1,
  "directories": [
    { "path": "docs", "recursive": true }
  ],
  "intervalSec": 30,
  "maxFileMB": 50,
  "extractTimeoutSec": 180,
  "scanBudgetSec": 240
}
```

| 字段 | 说明 | 默认 |
|------|------|------|
| directories[].path | 相对 workspace 路径 | 必填 |
| directories[].recursive | 递归子目录 | true |
| intervalSec | 扫描间隔秒 | 300 |
| maxFileMB | 文件大小上限 MB | 50 |
| extractTimeoutSec | 单文件超时秒 | 180 |
| scanBudgetSec | 单次扫描总时间上限秒 | 240 |

添加目录前必须 `ls` 确认目录存在。

## 进度监控

添加目录或大量新文件后执行。

1. 读 `_health.json`，看 originals 和 converted
2. originals ≤ 5 → "几个文件，很快就好"，等一个 cycle 后报结果
3. originals > 5 → "发现 N 个文件需要转换，预计需要几个周期"
   - 每隔一个 intervalSec 重读 _health.json
   - 全部完成 → "所有文件转换完毕，共 N 个文档可搜索"
   - 有 errors → 报告失败文件，建议排查

## markitdown 升级

用户说"升级工具"、或 errors 异常多时：

1. `pip show markitdown | grep Version` 看当前版本
2. `pip3 install --user --upgrade "markitdown[all]"`
3. 验证新版本号，告诉用户
