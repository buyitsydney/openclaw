#!/usr/bin/env bash
# carher-preflight.sh — CarHer A+B 架构升级预飞检查
#
# 在 docker build 之前,对目标 OpenClaw 版本镜像里跑 tsc --noEmit,
# 编译期抓 plugin SDK drift。任何一个 plugin 失败就退出非零,阻止 build。
#
# 用法:
#   scripts/carher-preflight.sh --tag=2026.4.15
#
# Exit codes:
#   0  所有 plugin 编译通过
#   1  参数错误
#   2  base image 拉不到
#   3  某个 plugin tsc 失败(见日志)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TAG=""
PLUGINS=(feishu-her a2a-gateway)

usage() {
    cat <<EOF
用法: $0 --tag=<OPENCLAW_TAG> [--plugins=feishu-her,a2a-gateway]

示例:
    $0 --tag=2026.4.15
    $0 --tag=2026.4.15 --plugins=feishu-her

参数:
    --tag=TAG        目标 OpenClaw 版本(必填),例如 2026.4.15
    --plugins=LIST   要检查的插件(可选,逗号分隔),默认全部
EOF
    exit 1
}

for arg in "$@"; do
    case "$arg" in
        --tag=*) TAG="${arg#*=}" ;;
        --plugins=*) IFS=',' read -ra PLUGINS <<< "${arg#*=}" ;;
        -h|--help) usage ;;
        *) echo "[preflight] 未知参数: $arg" >&2; usage ;;
    esac
done

if [[ -z "$TAG" ]]; then
    echo "[preflight] 缺 --tag 参数" >&2
    usage
fi

IMAGE="ghcr.io/openclaw/openclaw:${TAG}"

echo "[preflight] === CarHer 升级预飞检查 ==="
echo "[preflight] 目标 base: $IMAGE"
echo "[preflight] 检查插件: ${PLUGINS[*]}"
echo ""

# Step 1: 拉 base image(如果本地没有)
echo "[preflight] Step 1/3  拉取 base image..."
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
    if ! docker pull "$IMAGE"; then
        echo "[preflight] ❌ docker pull 失败 — tag 不存在或网络问题" >&2
        exit 2
    fi
fi
echo "[preflight] ✅ base image 就绪"
echo ""

# Step 2: 对每个 plugin 跑 tsc --noEmit
echo "[preflight] Step 2/3  对每个 plugin 跑 tsc --noEmit..."
FAILED=()
for plugin in "${PLUGINS[@]}"; do
    plugin_dir="$REPO_ROOT/docker/plugins/$plugin"
    if [[ ! -d "$plugin_dir" ]]; then
        echo "[preflight] ⚠️  跳过 $plugin — 目录不存在"
        continue
    fi

    echo "[preflight] --- $plugin ---"

    # 在 base image 里运行 tsc,挂载 plugin 源码(ro)+ node_modules(rw 临时卷)
    # 先 npm install(在容器里,用 base image 自带的 openclaw 类型)
    # 再 npx --no tsc --noEmit
    #
    # 注意:base image 里 /app/node_modules 包含 openclaw 的类型导出。
    # plugin 的 devDependencies.openclaw 其实是占位,运行时/编译时都解析到 base 里的。
    if docker run --rm \
        -v "$plugin_dir:/plugin:ro" \
        -w /tmp/plugin-check \
        --entrypoint /bin/bash \
        "$IMAGE" \
        -c "
            set -e
            cp -r /plugin/* .
            cp /plugin/package.json .
            [[ -f /plugin/tsconfig.json ]] && cp /plugin/tsconfig.json . || echo '{\"compilerOptions\":{\"noEmit\":true,\"target\":\"ES2022\",\"module\":\"ESNext\",\"moduleResolution\":\"bundler\",\"strict\":true,\"esModuleInterop\":true,\"skipLibCheck\":true,\"paths\":{\"openclaw\":[\"/app/node_modules/openclaw\"],\"openclaw/*\":[\"/app/node_modules/openclaw/*\"]}}}' > tsconfig.json
            npm install --omit=optional --ignore-scripts --no-audit --no-fund 2>&1 | tail -5
            npx --no tsc --noEmit -p tsconfig.json
        " 2>&1 | sed "s/^/[preflight:$plugin] /"; then
        echo "[preflight] ✅ $plugin 编译通过"
    else
        echo "[preflight] ❌ $plugin 编译失败"
        FAILED+=("$plugin")
    fi
    echo ""
done

# Step 3: 汇总
echo "[preflight] Step 3/3  结果汇总"
if [[ ${#FAILED[@]} -eq 0 ]]; then
    echo "[preflight] ✅ 全部通过 — 可以 docker build"
    exit 0
else
    echo "[preflight] ❌ 失败插件: ${FAILED[*]}"
    echo "[preflight]"
    echo "[preflight] 下一步建议:"
    echo "[preflight]   1. 看上面的 TypeScript 错误,定位漂移的 SDK 符号"
    echo "[preflight]   2. 按 patches/drift-fix/README.md 流程生成 patch"
    echo "[preflight]   3. 放到 patches/drift-fix/<plugin>-v${TAG}-drift-fix.git.patch"
    echo "[preflight]   4. 重新跑 $0 --tag=${TAG}"
    exit 3
fi
