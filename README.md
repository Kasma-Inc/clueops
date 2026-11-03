# clueops

从日志线索到排障证据。

clueops 是 TypeScript 插件式 AI 排障服务：通过 Lark 或 REST 接收日志，在用户获授权的目标内调用 Kubernetes、数据库、Redis、SSH 和 GitHub 工具，保存证据并返回可以继续追问的报告。

- 按目标组合集群、数据库、代码仓库和排障知识，隔离连接与调查范围。
- 引擎、诊断工具和消息渠道通过插件合同加载；当前内置 Codex 引擎。
- 保存调查、证据和投递状态，支持追问、取消、重试发送及重启恢复。

## 快速开始

需要 Node.js 22.5+、Git，以及支持 Codex 原生权限的 macOS/Linux 环境。下面的离线示例无需模型密钥、Lark 凭证或真实数据源：

```sh
npm ci
npm run check-config -- --config examples/demo/config.yaml
```

成功时输出 `status: "valid"`。示例仅校验配置与插件装配；要用 curl 跑完整消息流程，见 [REST 调试](docs/channels.md#rest渠道与curl调试)；浏览器管理入口见[管理控制台](docs/channels.md#管理控制台)。

## 接入实际环境

先阅读[配置与目标](docs/configuration.md)，再复制实际配置模板；已有 `private/` 时直接编辑，避免覆盖。

```sh
cp -R examples/live private
mkdir -p private/credentials
```

填写模型认证、目标连接和渠道凭证后，选择 [Docker Compose 部署](docs/deployment.md#docker-compose-部署)或[直接启动](docs/deployment.md#真实服务启动)。真实配置、凭证和调查状态由 Git 忽略；示例中的凭证均为占位值。

## 文档

文档中的命令默认在项目根目录执行；配置中的相对路径按声明文件解析。

| 内容 | 文档 |
| --- | --- |
| 全局配置、目标、凭证、Codex 认证与插件选择 | [配置与目标](docs/configuration.md) |
| Docker Compose、宿主启动、持久化与更新 | [部署与运行](docs/deployment.md) |
| Git tag 构建和推送镜像、Registry 变量与版本规则 | [镜像发布](docs/image-release.md) |
| 管理控制台、REST/curl、Lark 指令、追问、取消和恢复 | [渠道操作与会话恢复](docs/channels.md) |
| SSH 认证、目录权限和目标原生技能 | [SSH 与 Skills](docs/ssh-and-skills.md) |
| Kubernetes、数据库、Redis、GitHub 及执行边界 | [数据源边界与知识](docs/diagnostics.md) |
| 插件合同、程序内授权、测试、CI 与依赖 | [插件开发与验证](docs/development.md) |

## 开发验证

```sh
npm run typecheck
npm test
npm run build
```

[GitHub CI](.github/workflows/ci.yml) 在 main 推送和 PR 中验证 Node.js 22/24，并使用固定后端与临时 PostgreSQL/Redis 容器运行集成测试。集成测试准备及执行方式见[开发文档](docs/development.md#验证与依赖)。
