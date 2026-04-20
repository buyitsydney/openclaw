# CarHer SDK Drift Fix Patches

跟官方 OpenClaw 升级时,如果 `docker build` 失败(npm install ERESOLVE 或 tsc/jiti 报错)或 `carher-verify.sh` Gate 6 报 plugin contract 错误,说明 upstream 改了 plugin SDK 接口(`src/plugin-sdk/*`),我们的 `docker/plugins/feishu-her` 或 `docker/plugins/a2a-gateway` 跟不上。

此目录放每个受影响 OpenClaw 版本的**已知漂移修复** patch,在 `Dockerfile.carher.v2` build 时自动应用。

## 文件命名

```
<plugin-name>-v<OPENCLAW_TAG>-drift-fix.git.patch
```

示例:

- `feishu-her-v2026.4.15-drift-fix.git.patch`
- `a2a-gateway-v2026.5.0-drift-fix.git.patch`

## Patch 生成流程

1. 升级 docker build 或运行时报错(看 tsc stderr / `carher-verify.sh` Gate 6 输出)
2. 在 plugin 目录直接改代码让错误消失(不要改 OpenClaw SDK 本身)
3. 生成 patch:
   ```bash
   cd docker/plugins/<plugin-name>
   git diff > ../../patches/drift-fix/<plugin-name>-v<TAG>-drift-fix.git.patch
   ```
4. 把改动**还原**(`git checkout .`),只把 patch 文件 commit 进去 —— plugin 源码保持对旧版 SDK 的适配,patch 在新版 build 时才应用

## Patch 应用时机

`Dockerfile.carher.v2` build 时,如果存在当前 `OPENCLAW_TAG` 对应的 drift-fix patch,在 `COPY` plugin 代码之后、`npm install` 之前自动 `git apply`。(此流水线在 Task 16 完成后接入。)

## Patch 生命周期

- **保留**:只要还可能有用户/容器回滚到该 OpenClaw 版本,patch 不删
- **清理**:该版本镜像超过保留期(>90 天)且无任何运行容器时可删
- **不做**:不把 drift fix 直接改到 plugin 源码 —— 那会破坏向旧版 OpenClaw 的兼容

## 为什么不用 peerDependencies 直接拦住

`peerDependencies: ">=2026.1.26 <2026.5.0"` 是**粗粒度**保险:告诉 npm install "这个 plugin 只保证在此范围内工作"。但 patch 版本(2026.4.14 → 2026.4.15)也可能改 SDK,semver 不承诺。

Drift-fix patch 是**细粒度**处理:每个具体版本对应具体 diff,可审计、可回滚、可逐版本管理。

## 已知漂移清单(参考,非详尽)

下面是历史 upstream 版本常见的 drift pattern,供排查参考:

| SDK 符号 | 可能的 drift |
|---|---|
| `ChannelLogSink` | 迁到 core 为 `PluginLogger` |
| `ChannelAccountSnapshot` | 挪到 `plugin-sdk/status-helpers` |
| `resolvePreferredOpenClawTmpDir` | 挪到 `plugin-sdk/temp-path` |
| `handleFeishuTokenError` | 签名 object → positional |
| `AgentTool.label` | 从可选变必填 |

具体哪版炸哪条,以 `carher-preflight.sh` 输出为准,不要预判。
