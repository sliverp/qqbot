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
  # 打印完整命令到 stderr
  echo -e "${CYAN}  ── [${name}] \$ $*${RESET}" >&2
  output=$("$@" 2>&1) || exit_code=$?
  echo "$output" >&2
  echo -e "${CYAN}  ── [${name}] exit=${exit_code} ──${RESET}" >&2
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

# 断言消息发送成功（返回中包含 "Sent" 和 "Message ID"）
assert_http_ok() {
  local name="$1" output="$2"
  if echo "$output" | grep -q "Sent"; then
    record_result "$name" "pass"
  else
    echo -e "${RED}  ── [${name}] HTTP check FAILED, full response: ──${RESET}" >&2
    echo "$output" >&2
    echo -e "${RED}  ── [${name}] end ──${RESET}" >&2
    record_result "$name" "fail" "response does not contain 'Sent'"
    return 1
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

# 2.1 添加 Bot1（默认账户）
assert_success "channel.bot1_add" \
  openclaw channels add --channel qqbot --token "${BOT1_APPID}:${BOT1_SECRET}" || true

# 2.2 验证 Bot1 通道已添加
CH_LIST=$(assert_success "channel.list_after_bot1" openclaw channels list) || true
assert_contains "channel.qqbot_visible" "$CH_LIST" "qqbot" || true

# 2.3 添加 Bot2（多账户）
assert_success "channel.bot2_add" \
  openclaw channels add --channel qqbot --account bot2 --token "${BOT2_APPID}:${BOT2_SECRET}" || true

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

# 重启 gateway，使 channel 配置生效
log "重启 OpenClaw gateway ..."
assert_success "gateway.restart" openclaw gateway restart || true
sleep 5

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
TEST_FILE="/tmp/e2e-test.txt"
echo "[E2E Test] QQBot file message test @ $(date '+%Y-%m-%d %H:%M:%S')" > "$TEST_FILE"
log "生成测试文件 / Generated test file: $TEST_FILE"

if [ -f "$TEST_FILE" ]; then
  MSG_OUT_F1=$(assert_success "message.bot1_file_c2c" \
    openclaw message send \
      --channel "qqbot" \
      --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
      --media "$TEST_FILE") || true
  assert_http_ok "message.bot1_file_c2c_http" "$MSG_OUT_F1" || true

  MSG_OUT_F2=$(assert_success "message.bot2_file_c2c" \
    openclaw message send \
      --channel "qqbot" \
      --account bot2 \
      --target "qqbot:c2c:${BOT2_TEST_OPENID}" \
      --media "$TEST_FILE") || true
  assert_http_ok "message.bot2_file_c2c_http" "$MSG_OUT_F2" || true
else
  record_result "message.bot1_file_c2c" "skip" "test file not available"
  record_result "message.bot2_file_c2c" "skip" "test file not available"
fi

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 4: <qqmedia> 标签消息
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 4: Media Tag Messages (<qqmedia>)"

# 4.1 文本中包含 <qqmedia> 图片 URL 标签
MSG_TAG_IMG=$(assert_success "media_tag.image_url" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E Tag] 这是一张图片 <qqmedia>https://picsum.photos/400/300</qqmedia> @ ${TIMESTAMP}") || true
assert_http_ok "media_tag.image_url_http" "$MSG_TAG_IMG" || true

# 4.2 文本中包含 <qqmedia> 本地文件标签
TEST_TAG_FILE="/tmp/e2e-tag-test.txt"
echo "[E2E Test] Tag file content @ $(date '+%Y-%m-%d %H:%M:%S')" > "$TEST_TAG_FILE"
MSG_TAG_FILE=$(assert_success "media_tag.local_file" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E Tag] 这是文件 <qqmedia>${TEST_TAG_FILE}</qqmedia> @ ${TIMESTAMP}") || true
assert_http_ok "media_tag.local_file_http" "$MSG_TAG_FILE" || true

# 4.3 文本中包含多个 <qqmedia> 标签（混合）
MSG_TAG_MULTI=$(assert_success "media_tag.multi_tags" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E Tag] 图1 <qqmedia>https://picsum.photos/200/200</qqmedia> 图2 <qqmedia>https://picsum.photos/300/200</qqmedia> @ ${TIMESTAMP}") || true
assert_http_ok "media_tag.multi_tags_http" "$MSG_TAG_MULTI" || true

# 4.4 向后兼容：旧标签 <qqimg> 应被自动转换为 <qqmedia>
MSG_TAG_COMPAT=$(assert_success "media_tag.compat_qqimg" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E Tag] 旧标签兼容测试 <qqimg>https://picsum.photos/250/250</qqimg> @ ${TIMESTAMP}") || true
assert_http_ok "media_tag.compat_qqimg_http" "$MSG_TAG_COMPAT" || true

# 4.5 纯文本 + 标签前后都有文字（验证文本拆分正确）
MSG_TAG_SURROUND=$(assert_success "media_tag.text_around" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "前面的文字 <qqmedia>https://picsum.photos/150/150</qqmedia> 后面的文字 @ ${TIMESTAMP}") || true
assert_http_ok "media_tag.text_around_http" "$MSG_TAG_SURROUND" || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 5: Markdown 格式消息
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 5: Markdown Format Messages"

# 5.1 标题 + 加粗 + 斜体
MSG_MD_BASIC=$(assert_success "markdown.basic_format" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "# E2E Markdown 测试

## 二级标题

这是 **加粗文字**，这是 *斜体文字*，这是 ~~删除线~~。

@ ${TIMESTAMP} | OpenClaw ${OC_VERSION}") || true
assert_http_ok "markdown.basic_format_http" "$MSG_MD_BASIC" || true

# 5.2 列表 + 代码块
MSG_MD_LIST=$(assert_success "markdown.list_and_code" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "### 功能列表

- 项目一：文本消息
- 项目二：图片消息
- 项目三：语音消息

有序列表：
1. 第一步
2. 第二步
3. 第三步

代码块：
\`\`\`python
print('Hello QQBot!')
\`\`\`

行内代码：\`openclaw message send\`

@ ${TIMESTAMP}") || true
assert_http_ok "markdown.list_and_code_http" "$MSG_MD_LIST" || true

# 5.3 链接 + 引用
MSG_MD_LINK=$(assert_success "markdown.link_and_quote" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "### 链接 & 引用测试

> 这是一段引用文字
> 可以有多行

链接：[OpenClaw 文档](https://github.com)

分隔线：

---

@ ${TIMESTAMP}") || true
assert_http_ok "markdown.link_and_quote_http" "$MSG_MD_LINK" || true

# 5.4 Markdown + <qqmedia> 标签混合
MSG_MD_TAG=$(assert_success "markdown.mixed_with_media_tag" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "## 混合测试

**加粗标题** 下面是一张图片：

<qqmedia>https://picsum.photos/350/250</qqmedia>

> 图片上方和下方都有 Markdown 格式内容

- 列表项 A
- 列表项 B

@ ${TIMESTAMP} | OpenClaw ${OC_VERSION}") || true
assert_http_ok "markdown.mixed_with_media_tag_http" "$MSG_MD_TAG" || true

# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# TEST SUITE 6: 真实文件 & 无后缀 URL 类型检测
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
log_section "Suite 6: Real File & Content-Type Detection"

# 6.1 本地真实图片文件（tests/test.jpg）
E2E_TEST_IMG="$(cd "$(dirname "$0")" && pwd)/test.jpg"
if [ -f "$E2E_TEST_IMG" ]; then
  MSG_REAL_IMG=$(assert_success "detect.local_image_jpg" \
    openclaw message send \
      --channel "qqbot" \
      --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
      --message "[E2E] 本地真实图片 <qqmedia>${E2E_TEST_IMG}</qqmedia> @ ${TIMESTAMP}") || true
  assert_http_ok "detect.local_image_jpg_http" "$MSG_REAL_IMG" || true
else
  record_result "detect.local_image_jpg" "skip" "test.jpg not found in tests/"
  record_result "detect.local_image_jpg_http" "skip" "test.jpg not found in tests/"
fi

# 6.2 无后缀网络 URL（服务端返回 Content-Type: image/png）
#     验证 HEAD fallback → GET+Range 能正确探测为 image
MSG_NOEXT_URL=$(assert_success "detect.url_no_extension" \
  openclaw message send \
    --channel "qqbot" \
    --target "qqbot:c2c:${BOT1_TEST_OPENID}" \
    --message "[E2E] 无后缀URL图片 <qqmedia>https://exam.clawhome.cc/cert/47513288-b4e4-4ecc-a385-c85d9a13a9b4/image</qqmedia> @ ${TIMESTAMP}") || true
assert_http_ok "detect.url_no_extension_http" "$MSG_NOEXT_URL" || true

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
