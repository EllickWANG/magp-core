# Magp Core Backend

全新后端(Midway v4 / Node,**单进程**),取代旧 Bun `agent-runtime`。
业务与 agent **用文件夹分区**;agent 内部四个可换点用 **Midway 模块 + 接口 token + DI** 解耦。
设计详见 `../server/docs/agent-framework-design.md`。

## 结构

```
src/
  business/
    app/                     # 业务·app 端(迁移搬入)
    cms/                     # 业务·cms 端(迁移搬入)
    common/
      session-events.ts      # 通用转录存储(业务与 agent 共用)
      agent/                 # ★ agent(公共能力,不依赖具体业务)
        domain/              #   纯类型:Message / AgentEvent / ToolCall
        engine/              #   引擎:turn/session 纯逻辑 + AgentEngine(@Provide,只 @Inject 接口)
        model/               #   解耦① 模型/provider   —— MODEL_PROVIDER
        tools/               #   解耦② 工具/能力        —— TOOL_REGISTRY / CAPABILITY
        protocol/            #   解耦③ 客户端协议       —— CLIENT_PROTOCOL
        persistence/         #   解耦④ 持久化/会话      —— TRANSCRIPT_STORE
        permission/          #   工具权限门            —— PERMISSION
        session/             #   会话生命周期 + WS 通道 —— CLIENT_CHANNEL + AgentSessionManager
  config/  configuration.ts
```

## 边界(两层)

1. **业务 vs agent**:靠文件夹。`business/common/agent` **不许**依赖 `business/app|cms`(CI 强制)。
2. **agent 内部四个可换点**:靠 **接口 token + DI**。`engine` 只 `@Inject` 各 `*.contract` 的 token,
   **不许** import 兄弟模块的实现文件(CI 强制)。换实现 = 换绑 token 的类,engine 一行不动。

> 纯循环逻辑(`engine/turn.ts` `session.ts`)不依赖 Midway,可脱离容器单测(见 `engine/turn.test.ts`)。

## 命令

首次运行先复制配置示例,填写数据库连接和独立的管理员密码。
`AUTH_SECRET` 与 `PROVIDER_ENC_KEY` 分别使用 `openssl rand -base64 32` 生成。
`.env` 只保存在本地或部署环境,不提交到 Git,也不打入 Docker 镜像。

```bash
cp .env.example .env    # 填写配置后再启动
pnpm install
pnpm test               # 引擎纯逻辑单测(无网络/无 DB/无 Midway)
pnpm typecheck
pnpm lint:boundaries    # 文件夹 + 接口 边界红线
pnpm dev                # 起 Midway;模型 provider 通过 CMS 配置
```

Docker 部署使用 `docker compose up -d --build`,Compose 会在启动时加载本地 `.env`。
直接运行镜像时使用 `docker run --env-file .env -p 7001:7001 magp-core:latest`。

## 待办(填空点)

- [ ] ProtocolCodec:盘现有客户端 stream-json 帧,写黄金契约测试(落地前必做)
- [ ] persistence:`session-events.ts` 接 Prisma/PG;load 读时物化
- [ ] permission:接 `business/app/toolpolicy` RBAC
- [ ] capability:接 `business/app/capability` 能力服务(in-process + 记账)
- [ ] channel:接 session-socket WS hub(+ 应答关联)
- [ ] model provider:从 CMS 投影按会话动态取
- [ ] 迁移:把旧 control-plane 的 app/cms 业务搬进 `business/`,接管 `/ws`、`/api/sessions*`,删旧 `server/apps/agent-runtime`
```
