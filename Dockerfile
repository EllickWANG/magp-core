#
# Magp core —— Midway v4 单进程(HTTP + WebSocket 同端口)+ Prisma/SQLite。
#
# 两个容易踩的点,先说清楚:
#  1. **Prisma 客户端生成到 `prisma/generated/client`**(schema 里自定义了 output),不在 node_modules。
#     所以必须在镜像里跑 `prisma generate`,并把这份产物带进运行阶段 —— 只装依赖是起不来的。
#  2. **库是外部 PostgreSQL**,容器本身无状态 —— 不需要挂卷,横向扩也不用改。
#     DATABASE_URL 走 .env(已打入镜像);换环境时用 `-e DATABASE_URL=...` 覆盖即可。

# ── 构建阶段 ───────────────────────────────────────────────
FROM node:22-slim AS builder
WORKDIR /app

# openssl:Prisma 查询引擎要用它探测平台并加载对应二进制,缺了会在 generate 时报错。
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

RUN corepack enable

# pnpm 10+ 默认拦截依赖的构建脚本(防供应链攻击),遇到 Prisma 这种要 postinstall 的包
# 就直接 ERR_PNPM_IGNORED_BUILDS 退出 —— 而且 `pnpm exec` / `pnpm prune` 都会重跑这道检查。
# 用环境变量一次性放行,免得每条命令后面挂参数还漏掉一个。
# 注:放行只是让安装不中断;Prisma 客户端真正的产出靠下面显式的 `prisma generate`,
# 不依赖那个 postinstall。(package.json 的 pnpm 字段和 pnpm-workspace.yaml 在 pnpm 11 下均不生效,试过。)
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false

# 先只拷清单 —— 依赖没变时这层命中缓存,改业务代码不必重装。
COPY package.json pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

# 顺序要紧:先 generate 出 Prisma 客户端,src 里 import 的就是它,否则 tsc 直接找不到模块。
RUN pnpm exec prisma generate \
 && pnpm run build

# 砍掉 devDependencies:运行时不需要 mwtsc/vitest/类型包。
# prisma CLI 例外 —— 启动时要用它建表(见 entrypoint),所以单独留下。
RUN pnpm prune --prod

# ── 运行阶段 ───────────────────────────────────────────────
FROM node:22-slim AS runtime
WORKDIR /app

RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
 && rm -rf /var/lib/apt/lists/*

ENV NODE_ENV=production \
    PORT=7001

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/bootstrap.js ./bootstrap.js
COPY --from=builder /app/package.json ./package.json
# 配置打入镜像(架构决定)。要覆盖就在 `docker run` 时挂一份新的到 /app/.env,
# 或用 `--env-file` / `-e` 传 —— 下面 entrypoint 里 --env-file-if-exists 不会覆盖已存在的环境变量。
COPY --from=builder /app/.env ./.env

# 运行时用的 prisma CLI(builder 里 prune 掉了 devDeps,这里单独装一份精简的)
RUN npm i -g prisma@6 --no-audit --no-fund

EXPOSE 7001

# 非 root 运行;/data 要给它写权限,否则 SQLite 开不了库。
RUN useradd -m -u 10001 magp && chown -R magp:magp /app
USER magp

# `db push` 是幂等的:表已存在就什么都不做,新增字段会补上 —— 适合这种无 migration 目录的项目。
# 注意:多副本同时启动会并发 push;PG 侧是事务安全的,但生产上更稳妥的做法是单独跑一次迁移再滚服务。
# 建完表再启动;seed(默认管理员 / Free 套餐 / 内置角色)由 core 自己在 onReady 里跑。
ENTRYPOINT ["/bin/sh", "-c", "prisma db push --schema=prisma/schema.prisma --skip-generate && exec node --env-file-if-exists=.env bootstrap.js"]
