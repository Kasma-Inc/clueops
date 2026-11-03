# Debian/glibc 用于运行固定版本的 Codex、MCP 二进制及文件锁原生扩展。
# 构建上下文仍是项目根目录：docker build -f docker/Dockerfile .
ARG NODE_IMAGE=node:24-bookworm-slim
FROM ${NODE_IMAGE} AS base
WORKDIR /app
RUN apt-get update \
    && apt-get install -y --no-install-recommends ca-certificates openssh-client git netcat-openbsd python3 python3-venv tini \
    && rm -rf /var/lib/apt/lists/*

FROM base AS build
COPY package.json package-lock.json ./
RUN npm ci

# 在构建阶段下载并校验后端，容器启动时不安装依赖。
COPY tools/install-backends.mjs tools/backends.lock.json ./tools/
COPY tools/dbhub/package.json tools/dbhub/package-lock.json ./tools/dbhub/
COPY tools/redis/requirements.txt ./tools/redis/
RUN node tools/install-backends.mjs

COPY tsconfig.json ./
COPY src ./src
COPY prompts ./prompts
COPY tools/build-prompts.mjs tools/build-admin.mjs ./tools/
RUN npm run build && npm prune --omit=dev

FROM base AS runtime
ENV NODE_ENV=production

COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --from=build --chown=node:node /app/.clueops/bin ./.clueops/bin
COPY --from=build --chown=node:node /app/.clueops/redis-venv ./.clueops/redis-venv
COPY --from=build --chown=node:node /app/tools/dbhub ./tools/dbhub
COPY --chown=node:node tools/codex-launcher.mjs ./tools/codex-launcher.mjs
# 只包含公开示例；私有配置由部署环境只读挂载。
COPY --chown=node:node examples ./examples

# 首次创建命名卷时沿用此目录的所有权，服务以 UID/GID 1000 运行。
RUN mkdir -p /app/.clueops/state \
    && chmod 755 /app/tools/codex-launcher.mjs \
    && chown node:node /app/.clueops/state
USER node

STOPSIGNAL SIGTERM
# Docker 和 Kubernetes 都由 tini 转发停止信号、回收孤儿子进程。
ENTRYPOINT ["/usr/bin/tini", "--", "node", "dist/index.js"]
CMD ["--config", "/app/private/config.yaml"]
