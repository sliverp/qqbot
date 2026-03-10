FROM node:22-slim

ARG OPENCLAW_VERSION=latest

LABEL maintainer="sliverp"
LABEL description="OpenClaw + QQBot plugin E2E test environment"

# 确保 npm 全局 bin 在 PATH 中
ENV PATH="/usr/local/lib/node_modules/.bin:${PATH}"

# 安装基础工具
RUN apt-get update && apt-get install -y --no-install-recommends \
    curl jq ca-certificates git \
    && rm -rf /var/lib/apt/lists/*

# 安装指定版本的 OpenClaw，并验证安装成功
RUN echo "Installing OpenClaw version: ${OPENCLAW_VERSION}" && \
    if [ "$OPENCLAW_VERSION" = "latest" ]; then \
      npm install -g openclaw; \
    else \
      npm install -g "openclaw@${OPENCLAW_VERSION}"; \
    fi && \
    echo "npm global bin: $(npm prefix -g)/bin" && \
    ls -la "$(npm prefix -g)/bin/" && \
    echo "PATH=$PATH" && \
    openclaw --version || { echo "ERROR: openclaw not found after install"; exit 1; }

# 初始化 OpenClaw 配置目录
RUN mkdir -p /root/.openclaw

# 复制插件源码
WORKDIR /workspace/qqbot
COPY . .

# 安装依赖 & 构建
RUN npm install && npm run build

# 复制测试脚本并赋予执行权限
RUN chmod +x tests/e2e.sh

ENTRYPOINT ["bash", "tests/e2e.sh"]
