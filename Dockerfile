#
# Magp core —— Midway v4 单进程(HTTP + WebSocket 同端口)+ Prisma/SQLite。
#
# 两个容易踩的点,先说清楚:
#  1. **Prisma 客户端生成到 `prisma/generated/client`**(schema 里自定义了 output),不在 node_modules。
#     所以必须在镜像里跑 `prisma generate`,并把这份产物带进运行阶段 —— 只装依赖是起不来的。
#  2. **库是外部 PostgreSQL**,容器本身无状态 —— 不需要挂卷,横向扩也不用改。
#     DATABASE_URL 走 .env(已打入镜像);换环境时用 `-e DATABASE_URL=...` 覆盖即可。

# 基础镜像走阿里云镜像源(直连 Docker Hub 不稳)。注意它是 **Alpine/musl + Node 20**:
#  - 包管理是 apk 不是 apt-get;创建用户是 adduser 不是 useradd(busybox 没有 shadow);
#  - Prisma 在 musl 上要额外装 libc6-compat,否则引擎加载失败;
#  - 本机是 arm64,镜像也是 arm64。要部署到 x86 服务器得加 `--platform linux/amd64` 构建。

# ── 构建阶段 ───────────────────────────────────────────────
FROM registry.cn-hangzhou.aliyuncs.com/ellicksy/public:docker.m.daocloud.io_library_node_20-alpine AS builder
WORKDIR /app

# Alpine(musl)上 Prisma 的额外要求:
#  - openssl:查询引擎靠它探测平台、选对二进制,缺了 generate 直接报错;
#  - libc6-compat:Prisma 的引擎是针对 musl 编的没错,但它仍会动态链接若干 glibc 符号,
#    少了这个包会在运行时抛 "Error loading shared library"。
RUN apk add --no-cache openssl ca-certificates libc6-compat

# 先拷 package.json 再 enable:corepack 要读它的 packageManager 字段才知道该用哪个 pnpm。
# 不钉版本的话 corepack 会拉最新(pnpm 11 需要 Node 22+),在 Node 20 上直接 ERR_UNKNOWN_BUILTIN_MODULE。
COPY package.json ./
RUN corepack enable && corepack prepare --activate

# pnpm 10+ 默认拦截依赖的构建脚本(防供应链攻击),遇到 Prisma 这种要 postinstall 的包
# 就直接 ERR_PNPM_IGNORED_BUILDS 退出 —— 而且 `pnpm exec` / `pnpm prune` 都会重跑这道检查。
# 用环境变量一次性放行,免得每条命令后面挂参数还漏掉一个。
# 注:放行只是让安装不中断;Prisma 客户端真正的产出靠下面显式的 `prisma generate`,
# 不依赖那个 postinstall。(package.json 的 pnpm 字段和 pnpm-workspace.yaml 在 pnpm 11 下均不生效,试过。)
ENV PNPM_CONFIG_STRICT_DEP_BUILDS=false

# 先只拷清单 —— 依赖没变时这层命中缓存,改业务代码不必重装。
COPY pnpm-lock.yaml ./

RUN pnpm install --frozen-lockfile

COPY . .

# 顺序要紧:先 generate 出 Prisma 客户端,src 里 import 的就是它,否则 tsc 直接找不到模块。
RUN pnpm exec prisma generate \
 && pnpm run build

# 砍掉 devDependencies:运行时不需要 mwtsc/vitest/类型包。
# prisma CLI 例外 —— 启动时要用它建表(见 entrypoint),所以单独留下。
RUN pnpm prune --prod

# ── 运行阶段 ───────────────────────────────────────────────
FROM registry.cn-hangzhou.aliyuncs.com/ellicksy/public:docker.m.daocloud.io_library_node_20-alpine AS runtime
WORKDIR /app

RUN apk add --no-cache openssl ca-certificates libc6-compat

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

# 非 root 运行。Alpine 的 busybox 只有 adduser(没有 shadow 的 useradd)。
RUN adduser -D -u 10001 magp && chown -R magp:magp /app
USER magp

# `db push` 是幂等的:表已存在就什么都不做,新增字段会补上 —— 适合这种无 migration 目录的项目。
# 注意:多副本同时启动会并发 push;PG 侧是事务安全的,但生产上更稳妥的做法是单独跑一次迁移再滚服务。
# 建完表再启动;seed(默认管理员 / Free 套餐 / 内置角色)由 core 自己在 onReady 里跑。
ENTRYPOINT ["/bin/sh", "-c", "prisma db push --schema=prisma/schema.prisma --skip-generate && exec node --env-file-if-exists=.env bootstrap.js"]
