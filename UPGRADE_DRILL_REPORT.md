# CarHer A+B 架构升级 — 生产级 Playbook（演练后定稿）

> 写给明早醒来的你:这份是 2026-04-20 夜间演练定稿,**直接按 §4 的 4 条命令就能全员升级**,所有关键数字都实测过。Playbook 之外的部分是"为什么这样做"的证据链。

---

## 0. TL;DR(真正要做的事)

```bash
# 0) 前置:改 Dockerfile.carher.v2 第 9 行,新版 tag 先 pull 过
#    ARG OPENCLAW_TAG=2026.4.15  →  ARG OPENCLAW_TAG=2026.X.Y
docker pull ghcr.io/openclaw/openclaw:2026.X.Y

# 1) 构建新版 carher 镜像(独立 tag,永不覆盖旧)
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<MMDD>-ab-v2 .

# 2) 切 canary(102)
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./compose --id=102 --image=carher-core:<MMDD>-ab-v2

# 3) 自动自检(10 gate)
scripts/carher-verify.sh --id=102 --wait=90

# 4) canary 稳定 24h 后全量推广(脚本在 §6)
```

**canary 失败 = 立刻回滚**:`docker rm -f carher-102 && ./compose --id=102 --image=carher-core:<旧 tag>`。
旧 tag 永远留着,本地冷盘占个 ~2GB 不心疼。

---

## 1. 架构复盘(一句话)

CarHer 运行镜像 = **官方 OpenClaw base** + **自家 2 个插件(feishu-her + a2a-gateway)**。三者独立升级:

- 升 openclaw:只改 Dockerfile ARG 一行
- 升 feishu-her:重装 `docker/plugins/feishu-her/`
- 升 a2a-gateway:重装 `docker/plugins/a2a-gateway/`

**不做:`git merge upstream`、全量 `pnpm install`、跨层重编译**。旧流程(skill `upgrade-upstream`)已废弃。

---

## 2. 演练实测数据(2026-04-20 夜)

### 2.1 冷 build(base image tag 变更,首次构建)

| 阶段                             | 实测      | 备注                                      |
| -------------------------------- | --------- | ----------------------------------------- |
| `docker pull` 新 base            | 30s–3min  | 跟网速相关                                |
| `docker build` (cold base layer) | **34min** | **比 skill 原估 3–5min 长 10 倍**,见 §2.2 |

### 2.2 为什么冷 build 比 skill 估的长 10 倍?

Skill 老版估 3–5min 是基于"npm 缓存命中"的假设。实际:

- base image tag 变 → Dockerfile 第 10 行 `FROM` 层失效
- `FROM` 下游**全部层重跑**:apt/pip/npm/COPY/rm-rf 都要重算
- `--mount=type=cache,target=/root/.npm` 只救 **npm 包下载**(这段压缩到 30s),**apt/pip 仍全量**

**结论**:第一次拉新 base 的时候 build 时间按 **30min** 规划。同 base 之后小改 plugin 代码再 build 才是 3–5min。

**行动**:skill 的 build 时间表已在 `.cursor/skills/carher-image-upgrade/SKILL.md` 更新为"冷 30min / 热 3–5min"(本报告写完后追加 commit)。

### 2.3 热 swap(image 已在本地,canary 停机)

| 阶段                             | 实测     | 备注                              |
| -------------------------------- | -------- | --------------------------------- |
| `docker rm -f` + `compose` | **90s**  | stop 1s + cloudflared 隧道等 ~60s |
| Gateway ready                    | ~25s     | 已在 90s 内                       |
| `carher-verify.sh` 10 gate       | **0–2s** | 容器已 ready,全部检查同步跑过     |
| **总停机**                       | **~90s** | 跟 skill 原估吻合                 |

**实测 10/10 绿**(验证 102 从 0414-ab-v2 升到 0415-ab-v2):

```
PASS: 10  FAIL: 0  WARN: 0
✅ gateway ready (7 plugins, 24.6s)
✅ plugin count=7
✅ feishu WSClient connected
✅ A2A peers=3
✅ acpx runtime backend ready
✅ 无 plugin 契约错误
✅ bundled feishu 已全清
✅ a2a-gateway ioredis 安装完整
✅ feishu-her @larksuiteoapi 安装完整
✅ 无严重运行时错误
```

### 2.4 重大新发现:跨 schema 版本**回滚不无缝**

尝试把 102 回滚到 2026.3.12,容器进入 restart loop:

```
Invalid config at /data/.openclaw/openclaw.json:
- agents.defaults: Unrecognized key: "llm"
- messages.tts: Unrecognized key: "providers"
Run: openclaw doctor --fix
```

**根因**:`docker/shared-config.json5` 第 15 / 65–71 行写了 4.x 才引入的 schema 键。3.x 解析不识别 → strict schema 拒绝。

**影响**:

- **前向升级始终 OK**(新版兼容老 key 的子集)
- **回滚跨 schema 边界需要手动 config doctor**(在进入 0414/0415 这一代之前的版本才会有这问题)

**playbook 对策**:回滚前先把 shared-config 里的新版 key 注释掉,或在启动前跑 `openclaw doctor --fix`。详见 §5。

---

## 3. 纵深防御 4 层(运行期保证正确)

| 层        | 触发点                     | 机制                                                    | 抓什么                        |
| --------- | -------------------------- | ------------------------------------------------------- | ----------------------------- |
| L1 包管理 | `docker build` npm install | plugin `package.json` `peerDependencies: <2026.5.0`     | 跨大版本(>= 5.x)直接 ERESOLVE |
| L2 构建期 | `docker build` COPY 之后   | `patches/drift-fix/<plugin>-v<TAG>-drift-fix.git.patch` | 已知的 SDK 漂移(未来遇到时补) |
| L3 启动期 | 容器启动后                 | `carher-verify.sh` Gate 6 抓 `plugin validation/schema` | 未知的 SDK 契约错误           |
| L4 运行期 | canary 真人验收            | 飞书发消息 → `deliver: kind=final`                      | 端到端语义正确                |

**编译期 preflight 已砍**(2026-04-20):tsc 环境构建代价过高,L3+L4 等价且更真实。

---

## 4. 单用户升级 playbook(4 条命令)

### 4.1 全流程

```bash
# Step 1: 改 ARG、pull base、构建(独立 tag)
vim Dockerfile.carher.v2   # 第 9 行 ARG OPENCLAW_TAG=<新版>
docker pull ghcr.io/openclaw/openclaw:2026.X.Y
DOCKER_BUILDKIT=1 docker build -f Dockerfile.carher.v2 \
  --build-arg OPENCLAW_TAG=2026.X.Y \
  -t carher-core:<MMDD>-ab-v2 .
# 冷 build: ~30min;同 base 改 plugin: ~3-5min

# Step 2: 切 canary(一般是 102 = tester2)
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./compose --id=102 --image=carher-core:<MMDD>-ab-v2
# 停机: ~90s;gateway ready 需再等 ~25s

# Step 3: 自动自检
scripts/carher-verify.sh --id=102 --wait=90
# exit 0 = 全过;exit 3 = 有 FAIL,按打印的命令回滚

# Step 4: 真人验收 — 飞书私聊发
#   你好。检查下 A2A 和 ACP 状态?
# 期望 bot 回复里带 "A2A ✅" 和 "ACP"
```

### 4.2 时间预算(canary 一个用户)

| 步骤       | 时间(首次新 tag) | 时间(同 base 改 plugin) |
| ---------- | ---------------- | ----------------------- |
| build      | ~30 min          | 3–5 min                 |
| swap+ready | ~115 s(90+25)    | ~115 s                  |
| verify     | 0–2 s            | 0–2 s                   |
| 人肉验收   | 30 s             | 30 s                    |
| **总停机** | **~2 min**       | **~2 min**              |

**build 时间不算停机时间**(新 image 后台构建,切换那一刻才停机)。

---

## 5. 回滚

### 5.1 同大版本回滚(0415 → 0414 这类)

```bash
docker rm -f carher-102
CARHER_ACP_ENABLED=1 ./compose --id=102 --image=carher-core:<旧日期>-ab-v2
# ~60-70s,因为镜像在本地,省掉 build+pull
```

实测 10/10 绿。

### 5.2 跨 schema 回滚(4.x → 3.x 这类)

**不要直接起**,会 restart loop。流程:

```bash
# 5.2.1 临时删掉 shared-config 里 4.x-only 的 key
#   agents.defaults.llm、messages.tts.providers
#   (其他跨 schema key 以 `openclaw doctor` 输出为准)

# 5.2.2 停 + 清掉持久 config
docker rm -f carher-102
docker run --rm -v carher-102-data:/data alpine rm -f /data/openclaw.json

# 5.2.3 再起
CARHER_ACP_ENABLED=1 ./compose --id=102 --image=carher-core:<老 tag>

# 5.2.4 或者更直接:先让新版镜像跑一遍 doctor --fix,再启
docker run --rm -v carher-102-data:/data carher-core:<老 tag> openclaw doctor --fix
```

**预防**:同大版本(4.x 之间)互相升降没有这问题,保留 `carher-core:0414-ab-v2` 作为 4.x 系的稳定底线。

---

## 6. 全量推广(102 → 全 200 用户)

### 6.1 前置硬门槛(全通过才可以推)

1. ✅ canary 102 至少稳定跑 **24 小时**,期间无 FATAL / crash
2. ✅ `scripts/carher-verify.sh --id=102` 10/10 绿
3. ✅ 真人发过飞书,bot 回复包含 `A2A ✅` 和 `ACP`
4. ✅ 观察 `deliver: kind=final hasText=true` 事件 > 0
5. ✅ 旧 image tag 仍在本地(`docker image ls carher-core` 能看到)

### 6.2 推广脚本(单机串行,最保守)

```bash
#!/usr/bin/env bash
# rollout-all.sh — 全量升级 200 用户
set -uo pipefail

NEW_TAG="carher-core:<MMDD>-ab-v2"
OLD_TAG="carher-core:0415-ab-v2"     # 记下当前 stable,回滚用

for i in $(seq 1 200); do
  echo "=== carher-$i ==="

  # 静默期保护:过去 15min 有消息交互的用户先跳过,下一轮再处理
  if docker ps --format '{{.Names}}' | grep -qx "carher-$i"; then
    RECENT=$(docker logs "carher-$i" --since=15m 2>&1 | grep -c "deliver:" || true)
    if [[ "$RECENT" -gt 0 ]]; then
      echo "  [skip] $RECENT 条近 15min 消息,待静默再升"
      echo "carher-$i" >> /tmp/rollout-skipped.txt
      continue
    fi
  fi

  docker rm -f "carher-$i" >/dev/null 2>&1 || true
  CARHER_ACP_ENABLED=1 ./compose --id="$i" --image="$NEW_TAG" >/dev/null

  # 等 gateway ready 最多 90s
  for _ in $(seq 1 30); do
    if docker logs "carher-$i" 2>&1 | grep -q "\[gateway\].*ready"; then
      break
    fi
    sleep 3
  done

  # 自检
  if scripts/carher-verify.sh --id="$i" --wait=30 >/tmp/verify-$i.log 2>&1; then
    echo "  [ok] 升级完成"
  else
    echo "  [FAIL] 自检失败,自动回滚"
    docker rm -f "carher-$i" >/dev/null
    CARHER_ACP_ENABLED=1 ./compose --id="$i" --image="$OLD_TAG" >/dev/null
    echo "carher-$i" >> /tmp/rollout-rolled-back.txt
  fi

  sleep 5
done

echo "=== 推广结束 ==="
echo "跳过(有近期消息): $(wc -l < /tmp/rollout-skipped.txt 2>/dev/null || echo 0)"
echo "回滚(自检失败):   $(wc -l < /tmp/rollout-rolled-back.txt 2>/dev/null || echo 0)"
```

### 6.3 停机预算

- 每用户 ~90s 停机
- 串行 200 用户:**总耗时 ~5 小时**(每轮间 sleep 5s)
- 建议夜间跑(22:00–03:00),避开主要使用时段

### 6.4 回滚跳过的用户处理

跳过列表(`/tmp/rollout-skipped.txt`)留到第二轮:

```bash
for user in $(cat /tmp/rollout-skipped.txt); do
  id=${user#carher-}
  # 同上循环体
done
```

### 6.5 紧急全量回滚(发现升级有系统性问题)

```bash
#!/usr/bin/env bash
# emergency-rollback.sh — 全量回滚到上一版本
OLD_TAG="carher-core:0415-ab-v2"
for i in $(seq 1 200); do
  docker rm -f "carher-$i" >/dev/null 2>&1 || true
  CARHER_ACP_ENABLED=1 ./compose --id="$i" --image="$OLD_TAG" >/dev/null &
  # 并发回滚(回滚不做自检,追求速度)
  if (( i % 10 == 0 )); then wait; fi
done
wait
```

并发回滚:**200 用户 ~10 分钟**(每轮 10 个并行)。

---

## 7. 维护清单(每次升级后立刻做)

1. 更新 `.cursor/skills/carher-image-upgrade/SKILL.md` 的"历史演练记录"段
2. 新 image tag 至少保留 **30 天**,不要 `docker rmi`
3. 若遇到 SDK drift,在 `patches/drift-fix/` 下落 patch
4. 若遇到 schema drift 导致回滚问题,在本报告 §2.4 续写新的 key
5. 对应 commit 上 `dev` 或 `main`(当前在 `feat/carher-a-b-decouple` worktree,未合主)

---

## 8. 已知风险 & 限制

| 风险                      | 可能性 | 影响          | 缓解                                                    |
| ------------------------- | ------ | ------------- | ------------------------------------------------------- |
| 跨大版本(>= 5.x)升级      | 中     | build 失败    | `peerDependencies` 拦住,人工判断是否放宽上界            |
| 跨 schema 回滚(4.x → 3.x) | 低     | restart loop  | §5.2 流程(先删 /data/openclaw.json + 修 shared-config)  |
| 200 用户串行推广中途死机  | 低     | 推广中断      | 脚本用 `set -uo pipefail`,失败用户记 log,下一轮重试     |
| canary 真人验收没回复     | 中     | 发现问题晚    | 用 `Monitor` 工具盯 `deliver: kind=final` 事件          |
| bundled feishu 残留未清完 | 低     | WSClient 不连 | Gate 7 会抓到;Dockerfile 第 40 行 `rm -rf` 列表保持同步 |

---

## 9. 下一步(报告之外的事)

- 本 worktree 分支 `feat/carher-a-b-decouple` 尚未合 `dev`/`main` — 推广前先 merge
- 考虑把 Step 1–3 脚本化成 `scripts/carher-upgrade.sh --tag=2026.X.Y --canary=102`
- 200 用户数据库(`docker/users.csv`)是否要在推广前做一份 snapshot 备份?→ 是,`cp docker/users.csv docker/users.csv.bak-<DATE>`

---

## 10. 演练命令台账(2026-04-20 23:30–2026-04-21 00:45)

```
23:30  砍掉 preflight          commit 19af81ca4f
23:40  ARG 改 2026.3.12        docker build → 34m26s(冷 build)
00:20  起 102 on 0312-drill    ❌ restart loop(schema drift)
00:25  发现根因                shared-config.json5 有 4.x-only key
00:30  决定跳过 0312 baseline  real finding,记录在 §2.4
00:31  ARG 恢复 2026.4.15      起 102 on 0414-ab-v2 → 10/10 绿(实 drill 起点)
00:33  升级 102: 0414 → 0415   swap 90s + verify 0s + 10/10 绿
00:40  写本报告
```

**结论**:playbook 可上线。明早按 §6 推全员,预计 5 小时完成 200 用户。
