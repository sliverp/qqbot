#!/usr/bin/env bash
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# QQBot Plugin — E2E Test Suite
#
# 环境变量（必填，详见 .env.example）:
#   BOT1_APPID / BOT1_SECRET   — 第一个 QQ Bot
#   BOT2_APPID / BOT2_SECRET   — 第二个 QQ Bot
#   BOT1_TEST_OPENID           — Bot1 的测试用户 OpenID（C2C）
#   BOT2_TEST_OPENID           — Bot2 的测试用户 OpenID（C2C）
#
# 可选:
#   OPENCLAW_VERSION           — 当前容器的 OpenClaw 版本（由 Docker 注入）
#   BOT1_TEST_GROUP_OPENID     — Bot1 的测试群 OpenID
#   BOT2_TEST_GROUP_OPENID     — Bot2 的测试群 OpenID
#   TEST_IMAGE_PATH            — 用于 file 消息测试的图片路径
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

set -euo pipefail

# ── 颜色 & 格式 ──────────────────────────────────────────────────────
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
RESET='\033[0m'

# ── 报告目录 ─────────────────────────────────────────────────────────
OC_VERSION="${OPENCLAW_VERSION:-unknown}"
REPORT_DIR="tests/reports"
REPORT_FILE="${REPORT_DIR}/report-${OC_VERSION}-$(date +%Y%m%d-%H%M%S).txt"
REPORT_JSON="${REPORT_DIR}/report-${OC_VERSION}-$(date +%Y%m%d-%H%M%S).json"
mkdir -p "$REPORT_DIR"

# ── 计数器 ───────────────────────────────────────────────────────────
TOTAL=0
PASSED=0
FAILED=0
SKIPPED=0
RESULTS_JSON="[]"

# ── 工具函数 ─────────────────────────────────────────────────────────
log()      { echo -e "${CYAN}[$(date '+%H:%M:%S')]${RESET} $*"; }
log_ok()   { echo -e "${GREEN}  ✓ $*${RESET}"; }
log_fail() { echo -e "${RED}  ✗ $*${RESET}"; }
log_skip() { echo -e "${YELLOW}  ⊘ $* (SKIPPED)${RESET}"; }
log_section() { echo -e "\n${BOLD}━━━ $* ━━━${RESET}\n"; }

# 记录单条测试结果
# Usage: record_result "test_name" "pass|fail|skip" "detail message"
record_result() {
  local name="$1" status="$2" detail="${3:-}"
  TOTAL=$((TOTAL + 1))
  case "$status" in
    pass) PASSED=$((PASSED + 1)); log_ok "$name" ;;
    fail) FAILED=$((FAILED + 1)); log_fail "$name — $detail" ;;
    skip) SKIPPED=$((SKIPPED + 1)); log_skip "$name — $detail" ;;
  esac
  # 追加到 JSON 数组
  RESULTS_JSON=$(echo "$RESULTS_JSON" | jq --arg n "$name" --arg s "$status" --arg d "$detail" \
    '. + [{"test": $n, "status": $s, "detail": $d}]')
  # 追加到文本报告
  printf "%-50s %s  %s\n" "$name" "$status" "$detail" >> "$REPORT_FILE"
}

# 断言命令成功（exit code = 0）
assert_success() {
  local name="$1"; shift
  local output exit_code=0
  output=$("$@" 2>&1) || exit_code=$?
  # 调试信息输出到 stderr，避免被 $() 捕获
  echo -e "${CYAN}  ── [${name}] command output (exit=${exit_code}) ──${RESET}" >&2
  echo "$output" >&2
  echo -e "${CYAN}  ── [${name}] end output ──${RESET}" >&2
  if [ $exit_code -eq 0 ]; then
    record_result "$name" "pass"
    echo "$output"
  else
    record_result "$name" "fail" "exit code ${exit_code}"
    echo "$output"
    return 1
  fi
}

# 断言输出包含某个字符串
assert_contains() {
  local name="$1" haystack="$2" needle="$3"
  if echo "$haystack" | grep -qi "$needle"; then
    record_result "$name" "pass"
  else
    record_result "$name" "fail" "expected to contain '$needle'"
    return 1
  fi
}

# 断言 HTTP 状态码
assert_http_ok() {
  local name="$1" output="$2"
  if echo "$output" | grep -qiE "error|failed|500|401|403"; then
    echo -e "${RED}  ── [${name}] HTTP check FAILED, full response: ──${RESET}" >&2
    echo "$output" >&2
    echo -e "${RED}  ── [${name}] end ──${RESET}" >&2
    record_result "$name" "fail" "response contains error"
    return 1
  else
    record_result "$name" "pass"
  fi
}

# ── 环境检查 ─────────────────────────────────────────────────────────
log_section "环境检查 / Environment Check"

echo "Test run: $(date -u '+%Y-%m-%d %H:%M:%S UTC')" > "$REPORT_FILE"
echo "OpenClaw version: ${OC_VERSION}" >> "$REPORT_FILE"
echo "Node: $(node -v)" >> "$REPORT_FILE"
echo "---" >> "$REPORT_FILE"
printf "%-50s %s  %s\n" "TEST" "STATUS" "DETAIL" >> "$REPORT_FILE"
echo "---" >> "$REPORT_FILE"

log "OpenClaw version: ${OC_VERSION}"
log "Node: $(node -v)"
log "npm: $(npm -v)"

# 验证必填环境变量
REQUIRED_VARS=(BOT1_APPID BOT1_SECRET BOT2_APPID BOT2_SECRET BOT1_TEST_OPENID BOT2_TEST_OPENID)
MISSING=()
for var in "${REQUIRED_VARS[@]}"; do
  if [ -z "${!var:-}" ]; then
    MISSING+=("$var")
  fi
done

if [ ${#MISSING[@]} -gt 0 ]; then
  log_fail "缺少必填环境变量 / Missing required env vars: ${MISSING[*]}"
  log "请参考 tests/.env.example 配置 / See tests/.env.example"
  exit 1
fi

record_result "env.required_vars" "pass"

# 验证 openclaw 可用
if command -v openclaw &>/dev/null; then
  OC_ACTUAL=$(openclaw --version 2>/dev/null || echo "unknown")
  log "openclaw CLI: $OC_ACTUAL"
  record_result "env.openclaw_installed" "pass"
else
  record_result "env.openclaw_installed" "fail" "openclaw not found in PATH"
  exit 1
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 1: openclaw plugins install
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 1: Plugin Install (openclaw plugins install)"

# 1.1 安装插件
INSTALL_OUT=$(assert_success "install.from_source" openclaw plugins install .) || true

# 1.2 验证插件出现在列表中
LIST_OUT=$(assert_success "install.plugins_list" openclaw plugins list) || true
assert_contains "install.qqbot_in_list" "$LIST_OUT" "qqbot" || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 2: openclaw channels add — 单 Bot & 多 Bot
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 2: Channel Add (single & multi bot)"

# 2.1 配置 Bot1（默认账户）
assert_success "channel.bot1_appid" \
  openclaw config set channels.qqbot.appId "$BOT1_APPID" || true
assert_success "channel.bot1_secret" \
  openclaw config set channels.qqbot.clientSecret "$BOT1_SECRET" || true
assert_success "channel.bot1_enable" \
  openclaw config set channels.qqbot.enabled true || true

# 2.2 验证 Bot1 通道已添加
CH_LIST=$(assert_success "channel.list_after_bot1" openclaw channels list) || true
assert_contains "channel.qqbot_visible" "$CH_LIST" "qqbot" || true

# 2.3 配置 Bot2（多账户）
assert_success "channel.bot2_appid" \
  openclaw config set channels.qqbot.accounts.bot2.appId "$BOT2_APPID" || true
assert_success "channel.bot2_secret" \
  openclaw config set channels.qqbot.accounts.bot2.clientSecret "$BOT2_SECRET" || true
assert_success "channel.bot2_enable" \
  openclaw config set channels.qqbot.accounts.bot2.enabled true || true

# 2.4 验证配置文件包含两个 bot
CONFIG_JSON=$(cat ~/.openclaw/openclaw.json 2>/dev/null || echo "{}")
assert_contains "channel.bot1_in_config" "$CONFIG_JSON" "$BOT1_APPID" || true
assert_contains "channel.bot2_in_config" "$CONFIG_JSON" "$BOT2_APPID" || true

log "最终配置 / Final config:"
echo "$CONFIG_JSON" | jq '.channels.qqbot // empty' 2>/dev/null || echo "(jq parse failed)"

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 3: openclaw message send — 文本 & 文件消息
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 3: Message Send (text & file)"

TIMESTAMP=$(date '+%Y-%m-%d %H:%M:%S')

# 3.1 Bot1 发送文本消息（C2C）
MSG_OUT1=$(assert_success "message.bot1_text_c2c" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E Test] Bot1 text @ ${TIMESTAMP} | OpenClaw ${OC_VERSION}") || true
assert_http_ok "message.bot1_text_c2c_http" "$MSG_OUT1" || true

# 3.2 Bot2 发送文本消息（C2C）
MSG_OUT2=$(assert_success "message.bot2_text_c2c" \
  openclaw message send \
    --channel "qqbot" \
    --account bot2 \
    --target "qqbot:c2c:${BOT2_TEST_OPENID}" \
    --message "[E2E Test] Bot2 text @ ${TIMESTAMP} | OpenClaw ${OC_VERSION}") || true
assert_http_ok "message.bot2_text_c2c_http" "$MSG_OUT2" || true

# 3.3 文件消息测试
TEST_IMAGE="${TEST_IMAGE_PATH:-}"
if [ -z "$TEST_IMAGE" ]; then
  # 生成一张 1x1 PNG 作为测试图片
  TEST_IMAGE="/tmp/e2e-test-image.png"
  # 最小合法 PNG (67 bytes)
  printf '\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde\x00\x00\x00\x0cIDATx\x9cc\xf8\x0f\x00\x00\x01\x01\x00\x05\x18\xd8N\x00\x00\x00\x00IEND\xaeB`\x82' > "$TEST_IMAGE"
  log "生成测试图片 / Generated test image: $TEST_IMAGE"
fi

if [ -f "$TEST_IMAGE" ]; then
  MSG_OUT_F1=$(assert_success "message.bot1_file_c2c" \
    openclaw message send \
      --channel "qqbot" \
      --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
      --message "[E2E Test] Bot1 file msg" \
      --media "$TEST_IMAGE") || true
  assert_http_ok "message.bot1_file_c2c_http" "$MSG_OUT_F1" || true

  MSG_OUT_F2=$(assert_success "message.bot2_file_c2c" \
    openclaw message send \
      --channel "qqbot" \
      --account bot2 \
      --target "qqbot:c2c:${BOT2_TEST_OPENID}" \
      --message "[E2E Test] Bot2 file msg" \
      --media "$TEST_IMAGE") || true
  assert_http_ok "message.bot2_file_c2c_http" "$MSG_OUT_F2" || true
else
  record_result "message.bot1_file_c2c" "skip" "test image not available"
  record_result "message.bot2_file_c2c" "skip" "test image not available"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 生成报告
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "测试报告 / Test Report"

# 文本摘要
SUMMARY="Total: ${TOTAL} | Passed: ${PASSED} | Failed: ${FAILED} | Skipped: ${SKIPPED}"
echo "---" >> "$REPORT_FILE"
echo "$SUMMARY" >> "$REPORT_FILE"

# JSON 报告
jq -n \
  --arg ver "$OC_VERSION" \
  --arg node "$(node -v)" \
  --arg ts "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" \
  --argjson total "$TOTAL" \
  --argjson passed "$PASSED" \
  --argjson failed "$FAILED" \
  --argjson skipped "$SKIPPED" \
  --argjson results "$RESULTS_JSON" \
  '{
    openclaw_version: $ver,
    node_version: $node,
    timestamp: $ts,
    summary: { total: $total, passed: $passed, failed: $failed, skipped: $skipped },
    results: $results
  }' > "$REPORT_JSON"

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║           QQBot E2E Test Report                  ║${RESET}"
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
echo -e "║ OpenClaw Version : ${OC_VERSION}"
echo -e "║ Node             : $(node -v)"
echo -e "║ Date             : $(date -u '+%Y-%m-%d %H:%M:%S UTC')"
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
echo -e "║ Total   : ${TOTAL}"
echo -e "║ ${GREEN}Passed${RESET}  : ${PASSED}"
echo -e "║ ${RED}Failed${RESET}  : ${FAILED}"
echo -e "║ ${YELLOW}Skipped${RESET} : ${SKIPPED}"
echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"

# 逐条输出
echo "$RESULTS_JSON" | jq -r '.[] |
  if .status == "pass" then "║ \u001b[32m✓\u001b[0m " + .test
  elif .status == "fail" then "║ \u001b[31m✗\u001b[0m " + .test + " — " + .detail
  else "║ \u001b[33m⊘\u001b[0m " + .test + " — " + .detail
  end'

echo -e "${BOLD}╠══════════════════════════════════════════════════╣${RESET}"
echo -e "║ Text report : ${REPORT_FILE}"
echo -e "║ JSON report : ${REPORT_JSON}"
echo -e "${BOLD}╚══════════════════════════════════════════════════╝${RESET}"

# 退出码：有失败则非零
if [ "$FAILED" -gt 0 ]; then
  log_fail "${FAILED} test(s) failed!"
  exit 1
fi

log_ok "All ${PASSED} tests passed!"
exit 0
