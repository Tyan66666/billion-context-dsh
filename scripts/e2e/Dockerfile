# E2E 运行时镜像：钉版本的被测 launcher + 日志解码/断言工具。
# 设计依据 docs/e2e-testing-design.md「容器化运行」——本镜像已在
# OrbStack（linux/arm64）上全链路验证；宿主机只需要 Docker + Node（宿主
# 构建 dist），不要求安装 dsh CLI / pnpm / zstd。
#
# 升级被测 launcher 时改这里的版本号并重建镜像（决策 8：只测覆盖线最新版）。
FROM node:22-slim

# zstd 解会话日志（多帧拼接，Node 内置 zstd 解不了）；git 供 dsh 环境探测
RUN apt-get update \
 && apt-get install -y --no-install-recommends zstd ca-certificates git \
 && rm -rf /var/lib/apt/lists/*

# pnpm 供 profile 目录安装第三方插件（本插件以 file:/repo 方式安装）
RUN npm i -g pnpm@10

# 被测 launcher 本体：钉版本 → 运行时可复现
RUN npm i -g @deepseek-ai/dsh@0.1.2-rc.1

# 测试进程不回传遥测
ENV DSH_TELEMETRY_DISABLED=1
