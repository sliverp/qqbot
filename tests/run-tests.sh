#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# QQBot Plugin — Multi-Version E2E Test Runner
#
# 用法 / Usage:
#   ./tests/run-tests.sh                    # 使用 .env 中的 OPENCLAW_VERSIONS
#   ./tests/run-tests.sh latest 1.20.0      # 手动指定版本
#
# 前提 / Prerequisites:
#   1. 已安装 Docker & Docker Compose
#   2. 已配置 tests/.env（参考 tests/.env.example）
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$SCRIPT_DIR/.env"
REPORT_DIR="$SCRIPT_DIR/reports"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

mkdir -p "$REPORT_DIR"

# ── 加载 .env ────────────────────────────────────────────────────────
if [ ! -f "$ENV_FILE" ]; then
  echo -e "${RED}错误 / Error: tests/.env not found${RESET}"
  echo "请先配置 / Please configure first:"
  echo "  cp tests/.env.example tests/.env"
  echo "  # 然后填写你的 Bot 配置 / Then fill in your bot config"
  exit 1
fi

# shellcheck disable=SC1090
source "$ENV_FILE"

# ── 解析版本列表 ─────────────────────────────────────────────────────
if [ $# -gt 0 ]; then
  # 从命令行参数获取
  VERSIONS=("$@")
else
  # 从 .env 的 OPENCLAW_VERSIONS 获取（逗号分隔）
  IFS=',' read -ra VERSIONS <<< "${OPENCLAW_VERSIONS:-latest}"
fi

echo -e "${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     QQBot Multi-Version E2E Test Runner          ║${RESET}"
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
echo -e "║ Versions to test: ${VERSIONS[*]}"
echo -e "║ Report dir      : ${REPORT_DIR}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"
echo ""

OVERALL_EXIT=0
SUMMARY_LINES=()

for VERSION in "${VERSIONS[@]}"; do
  VERSION=$(echo "$VERSION" | xargs)  # trim spaces
  [ -z "$VERSION" ] && continue

  CONTAINER_NAME="qqbot-e2e-${VERSION//[^a-zA-Z0-9_.-]/-}"

  echo -e "\n${BOLD}┌──────────────────────────────────────────────────┐${RESET}"
  echo -e "${BOLD}│  Testing OpenClaw ${VERSION}${RESET}"
  echo -e "${BOLD}└──────────────────────────────────────────────────┘${RESET}"

  # 构建镜像
  echo -e "${CYAN}[build]${RESET} Building Docker image for OpenClaw ${VERSION} ..."
  docker build \
    --build-arg "OPENCLAW_VERSION=${VERSION}" \
    -t "qqbot-e2e:${VERSION}" \
    -f "$SCRIPT_DIR/Dockerfile" \
    "$PROJECT_ROOT"

  # 运行测试
  echo -e "${CYAN}[run]${RESET} Running E2E tests ..."
  EXIT_CODE=0
  docker run --rm \
    --name "$CONTAINER_NAME" \
    --env-file "$ENV_FILE" \
    -e "OPENCLAW_VERSION=${VERSION}" \
    -v "$REPORT_DIR:/workspace/qqbot/tests/reports" \
    "qqbot-e2e:${VERSION}" \
    || EXIT_CODE=$?

  # 清理容器（--rm 已处理正常退出，这里兜底异常情况）
  docker rm -f "$CONTAINER_NAME" 2>/dev/null || true

  if [ $EXIT_CODE -eq 0 ]; then
    SUMMARY_LINES+=("${GREEN}✓${RESET} OpenClaw ${VERSION} — ALL PASSED")
  else
    SUMMARY_LINES+=("${RED}✗${RESET} OpenClaw ${VERSION} — SOME FAILED (exit ${EXIT_CODE})")
    OVERALL_EXIT=1
  fi
done

# ── 清理 Docker 资源 ──────────────────────────────────────────────────
echo ""
echo -e "${CYAN}[cleanup]${RESET} Removing test Docker images ..."
for VERSION in "${VERSIONS[@]}"; do
  VERSION=$(echo "$VERSION" | xargs)
  [ -z "$VERSION" ] && continue
  docker rmi "qqbot-e2e:${VERSION}" 2>/dev/null && \
    echo -e "  removed image qqbot-e2e:${VERSION}" || true
done
# 清理构建过程产生的 dangling 镜像
docker image prune -f 2>/dev/null || true

# ── 汇总报告 ─────────────────────────────────────────────────────────
echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║         Multi-Version Test Summary                ║${RESET}"
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
for line in "${SUMMARY_LINES[@]}"; do
  echo -e "║ $line"
done
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
echo -e "║ Reports saved in: ${REPORT_DIR}/"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"

# 列出生成的报告文件
echo ""
echo "Generated reports:"
ls -la "$REPORT_DIR"/*.json 2>/dev/null || echo "  (no JSON reports found)"

exit $OVERALL_EXIT
