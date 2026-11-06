![clueops：让每一次排障，都有迹可循。](docs/assets/readme-hero.svg)

<div align="center">

**从问题出发，连接证据，让排障过程有迹可循。**

[快速体验](#快速体验) · [产品预览](#产品预览) · [功能一览](#功能一览) · [工作原理](#工作原理) · [接入真实环境](#接入真实环境) · [文档导航](#文档导航)

</div>

clueops 是一个可自行部署的 AI 排障服务。你提出问题或描述异常，它通过当前目标已配置的工具，检查 Kubernetes、数据库、Redis、远程服务器和 GitHub 源码，再返回包含**事实、疑似原因、建议和缺失信息**的报告。

可以直接问“支付接口突然变慢，帮我检查可能的原因”；已有日志、告警或其他线索，也可以一起提供。

每次调查都有独立编号，问题、证据、报告和投递记录会被保存。你可以继续追问，也可以在有权限的其他入口接着查。

| 从熟悉的入口开始 | 让证据支撑判断 | 把调查持续下去 |
| :--- | :--- | :--- |
| 在 Lark 群里提问，或用 REST 接入已有系统。 | 一起查看日志、数据和源码，分开呈现事实与推测。 | 保存每轮问题与结果，回看证据，并沿用调查编号追问。 |

## 产品预览

在一个工作台里查看排障记录，按目标、状态和关键词找到问题，再进入详情核对证据。

![clueops 管理控制台：排障记录、环境筛选、调查状态与消息来源](docs/assets/readme-console.png)

<details>
<summary><strong>展开查看：调查报告、证据入口与继续追问</strong></summary>

调查详情按轮次展示问题、事实、疑似原因、建议和缺失信息。报告里的证据编号对应已保存的工具结果，可展开检查查询参数和内容。

![clueops 调查详情：事实引用证据，推测单独呈现，并提供继续追问入口](docs/assets/readme-investigation.png)

</details>

*以上为当前控制台界面，使用合成演示数据展示；不代表真实环境的排障结论。*

## 功能一览

<details>
<summary><strong>查看完整能力：从接收问题到调查恢复</strong></summary>

| 能力 | 实际能帮你做什么 |
| --- | --- |
| **在群里发起排障** | 在 Lark 群里 @机器人并描述问题，可附上日志或引用同群的告警消息。报告以卡片呈现，可回复后继续追问。 |
| **通过 API 接入** | 用 REST 提交问题、查询回复和控制调查，适合脚本或已有系统接入；可与 Lark 同时启用。 |
| **关联多处证据** | 在一次调查中结合服务日志、数据库活动、缓存状态、服务器命令输出和源码，核对可能的原因。 |
| **本地命令取证** | Codex 可在授权目录中运行本地命令，命令完成后的输出会保存为证据；也可通过配置关闭本地命令。 |
| **按环境组织工具** | 把一个集群、若干数据库、服务器和代码访问凭证组成一个“目标”。不同目标可以使用不同工具、引擎和排障知识。 |
| **回看完整过程** | 管理控制台支持搜索记录、按目标和状态筛选、逐轮查看报告与证据、继续追问，以及只读查看目标和渠道信息。 |
| **控制调查进度** | 支持查状态、取消和中断后续接；同一调查按顺序处理问题，不同调查可在并发限制内同时运行。 |
| **保留执行与发送状态** | 重复消息可去重，发送失败可单独重试；重启后保留历史，中断的执行需要明确续接。 |
| **复用团队经验** | 用 `knowledge` 提供环境背景和排障约定，用 `skills` 接入可按需读取的原生技能包。 |
| **按需扩展** | 引擎、工具和渠道都通过插件合同接入。当前内置 Codex 引擎，也能加载自己实现的 ESM 模块或已安装的 npm 插件。 |

</details>

### 可以连接哪些数据源？

所有工具都按需配置，不必一次接齐。同一种工具可以配置多个实例，例如订单库和用户库分别连接。

| 工具 | 常见用途 | 访问范围由谁决定 |
| --- | --- | --- |
| **Kubernetes** | 查看资源、事件、Pod 状态和容器日志，对比不同副本的表现 | 明确指定的 kubeconfig、context，以及对应身份的 Kubernetes RBAC |
| **数据库** | 查看表结构、业务数据、数据库活动和锁，辅助分析慢查询与连接问题 | 数据库账户的原生权限；工具同时使用只读模式和查询限额 |
| **Redis** | 查看实例状态、键类型与 TTL，按游标扫描键、读取有限范围的数据 | Redis 账户与 ACL，以及插件开放的只读命令集合 |
| **SSH** | 在指定服务器执行排障命令，检查进程、日志和系统状态 | 固定的主机、经过核对的主机密钥和远端账户权限 |
| **GitHub** | 搜索代码，按分支、tag 或 commit 读取文件，核对实现细节 | 当前目标的 GitHub Token 权限；后端以只读模式运行 |

数据库当前实测 PostgreSQL；其他 DBHub 支持的引擎需要另行安装驱动和验收。Redis 当前验证单节点或托管代理入口。各工具的完整限制见[数据源边界与知识](docs/diagnostics.md)。

## 工作原理

### 架构：入口、调查、工具各司其职

渠道负责接收问题和发送回复；核心负责授权、排队、证据与状态；Codex 负责分析问题，并选择当前目标可用的工具。MCP 是模型调用工具的一套通用协议，SSH 则通过独立插件连接服务器。

![clueops 系统架构：Lark、REST 与控制台连接调查核心，Codex 使用目标知识和工具取证，状态持久保存](docs/assets/readme-architecture.svg)

<details>
<summary>查看可编辑的 Mermaid 架构图</summary>

```mermaid
flowchart TB
    subgraph entry[交互入口]
        direction LR
        lark["Lark 群聊<br/>问题、告警、追问"]
        rest["REST API<br/>脚本与系统接入"]
        admin["管理控制台<br/>历史、证据、目标概览"]
    end

    subgraph service[clueops 服务]
        core["调查核心<br/>授权 · 去重 · 排队 · 并发"]
        engine["Codex 引擎插件<br/>分析 · 取证 · 报告"]
        tools["当前目标的工具插件<br/>Kubernetes · 数据库 · Redis<br/>SSH · GitHub"]
        context["当前目标的知识与技能<br/>环境背景 · 团队排障经验"]
        store[("本地持久状态<br/>问题 · 证据 · 报告<br/>会话 · 投递记录")]
    end

    resources["已配置的外部资源<br/>集群 · 数据库 · 缓存<br/>服务器 · 代码仓库"]

    lark <--> core
    rest <--> core
    admin <-->|通过 REST 查询与追问| core
    core <--> engine
    context --> engine
    engine <-->|通过宿主调用并记录证据| tools
    tools <--> resources
    core <--> store

    classDef accent fill:#e6f5f0,stroke:#087f70,color:#164d44
    classDef neutral fill:#f6f8f9,stroke:#c4d2d6,color:#253438
    class core,engine accent
    class lark,rest,admin,tools,context,store,resources neutral
```

</details>

这里的**目标**可以理解为一份环境专属的排障工具箱。例如 `prod-a` 配置订单集群、订单库和应用源码，`prod-b` 只配置另一个集群。一次调查只装配所选目标的引擎、工具、知识和技能；调用者能选择哪些目标，由渠道授权决定。

### 流程：从问题到可以核对的报告

![排障路径：从问题开始，在目标环境中连接证据，形成可核对、可追问的报告](docs/assets/readme-overview.svg)

<details>
<summary>查看完整调查流程与追问路径</summary>

```mermaid
flowchart LR
    input["① 接收问题<br/>授权目标 · 保存问题"]
    collect["② 调用工具取证<br/>保存结果与失败信息"]
    report["③ 校验并保存报告<br/>检查事实与证据引用"]
    follow["④ 返回结果与追问<br/>沿用同一调查编号"]

    input --> collect --> report --> follow
    follow -->|继续取证| collect

    classDef step fill:#f6f8f9,stroke:#c4d2d6,color:#253438
    classDef accent fill:#e6f5f0,stroke:#087f70,color:#164d44
    class input,collect step
    class report,follow accent
```

</details>

报告会把观察到的事实与推测分开。事实必须引用本次调查中状态为成功的证据；查不到、查询失败或结果不完整，也会保留对应信息。引用校验便于核对依据，最终判断仍需要结合实际环境。

例如，一次“连接池耗尽”的调查可以这样阅读（以下仅为内容示意，并非真实排障结果）：

> **事实**：服务在故障窗口内多次报告获取连接超时。[E1] 数据库中有长时间未结束的事务。[E2]
>
> **疑似原因**：长事务可能持续占用连接，需要进一步核对应用调用链。[E1, E2]
>
> **建议**：检查相关事务的提交、回滚及连接释放路径。
>
> **缺失信息**：故障时的连接池配置，以及线上镜像对应的代码版本。

## 快速体验

先用离线示例体验提交、查看和追问。**无需模型密钥、Lark 凭证或真实数据源**：示例使用合成 Agent 和工具，HTTP 接口、调查管理与控制台使用项目的实际实现。

需要 Node.js **22.5+**、npm 和 Git；以下命令均在项目根目录执行。

### 1. 安装并检查配置

```sh
npm ci
npm run check-config -- --config examples/demo/config.yaml
```

输出包含 `"status":"valid"` 表示本地配置检查通过。配置检查不会连接外部服务，也不代表远端连接可用。

### 2. 启动 REST 示例与控制台

```sh
npm run build
npm start -- --config examples/demo/rest.yaml
```

打开 **<http://127.0.0.1:8080/admin/>**，用以下示例 Token 登录：

```text
EXAMPLE_ONLY_LOCAL_REST_TOKEN
```

首次进入时可以还没有记录。在另一个终端提交一个问题，再刷新控制台：

```sh
curl -sS http://127.0.0.1:8080/messages \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"demo-001","targetId":"cluster-a","text":"服务出现连接超时，帮我排查"}'
```

接口返回 HTTP `202`，以及 `investigationId` 和 `turnId`。这表示问题已保存并受理，报告在后台生成。离线 Agent 只返回合成报告，不会进行真实排障。

### 3. 查看结果并追问

在下面两条命令中，将 `REPLACE_EVENT_ID` 替换为刚返回的 `investigationId`：

```sh
# 查询受理通知、报告或失败信息；尚未完成时可再次查询。
curl -sS 'http://127.0.0.1:8080/messages?investigationId=REPLACE_EVENT_ID&after=0&limit=20' \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN'

# 沿用调查编号，用新的 messageId 提交追问。
curl -sS http://127.0.0.1:8080/messages \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"demo-002","investigationId":"REPLACE_EVENT_ID","text":"还缺少哪些证据？"}'
```

也可以直接在控制台的调查详情里追问。网络失败后重试同一请求时，保留原来的 `messageId` 和内容；提出新问题时使用新编号。重新体验一遍时，也需要更换示例中的消息编号。

更多 API、分页和控制操作见[渠道操作与会话恢复](docs/channels.md)。

## 接入真实环境

### 1. 准备一份私有配置

首次配置时复制模板；已经存在 `private/` 时直接编辑现有文件，避免覆盖。

```sh
cp -R examples/live private
mkdir -p private/credentials
```

```text
private/
├── config.yaml             # 默认引擎、消息渠道、目标列表与授权
├── targets/
│   ├── prod-a.yaml          # 环境 A 的工具、连接、知识与技能
│   └── prod-b.yaml          # 可选的第二个环境，需在入口显式登记
└── credentials/            # kubeconfig、证书和凭证文件
```

在 `config.yaml` 中填写模型、认证方式和渠道；在目标文件中保留需要的工具并填写连接信息。内置 Codex 引擎支持显式 API Key 或 Codex 认证文件，`apiKey`、`apiKeyFile`、`authFile` 只能选一种，详见[配置与目标](docs/configuration.md)。

配置中的相对路径以**声明该路径的文件**为基准。真实配置、凭证和默认调查状态已被 Git 忽略。

### 2. 检查并启动服务

项目提供 Docker Compose，镜像内包含运行时和固定版本的工具后端，宿主无需先安装 Node.js 或 MCP 后端。

```sh
docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm clueops --check-config --config /app/private/config.yaml
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml logs -f clueops
```

真实 Codex 调查在 macOS/Linux 环境运行，默认模式需要部署环境支持原生沙箱。Compose 的用户命名空间与权限设置、状态卷、发布镜像和直接宿主启动方式，见[部署与运行](docs/deployment.md)。

### 3. 发起第一次真实调查

完成 Lark 应用权限和事件订阅配置后，在群里从 @列表选中机器人，再发送目标与日志：

```text
@机器人 /target prod-a
ERROR connection pool exhausted ...完整原日志...

@机器人 /event <调查编号> 为什么这些连接没有释放？
@机器人 /status <调查编号>
@机器人 /cancel <调查编号>
```

只有一个获授权目标时可以省略 `/target`。也可回复受理卡片或报告并 @机器人继续追问；引用告警原文分析需要额外的消息读取权限，设置方式见[Lark 操作与恢复](docs/channels.md#lark-操作与恢复)。

## 运行时的几个关键约定

<details>
<summary><strong>了解目标授权、执行恢复与数据保留</strong></summary>

- **授权要明确。** `routes` 可限制租户、群、发送者和目标；省略时允许该渠道收到的来源使用全部已登记目标，`routes: []` 则不授权任何来源。管理控制台与 API 同样按目标权限展示调查。
- **工具权限要按实际账号设置。** Kubernetes 和 SSH 能执行的操作取决于其账号权限，并非强制只读；数据库也需要原生只读账号。项目的排障提示和工具标签不能代替服务端授权，报告完成也不表示故障已修复。
- **保存历史与恢复执行是两回事。** 重启后历史仍可查看；已开始但未完成的轮次会标为中断，需要明确 `/continue`，不会自动重放。目标范围变化后，旧报告可读，但原调查可能不能继续。
- **发送失败可以单独重试。** `/retry-delivery` 只重试未确认成功的投递，不重新运行调查；跨渠道追问仍需目标权限，并使用明确的调查编号。
- **状态按单实例部署。** 同一状态目录只能由一个服务实例写入。默认保留 7 天；只有已结束且投递全部确认的调查才会过期清理，可用 `retentionDays: 0` 关闭自动过期。
- **预算与脱敏有明确边界。** 可配置超时、调用次数、返回量、并发和可选 Token 上限。宿主记录时会脱敏已知凭证和常见敏感字段，未知业务秘密仍需自行控制；原生命令输出可能先到达模型，状态目录应按私有业务数据管理。

</details>

## 文档导航

| 你想做什么 | 从这里开始 |
| --- | --- |
| 配置模型、凭证、目标、授权与自定义插件 | [配置与目标](docs/configuration.md) |
| 部署、升级、持久化、备份和清理历史 | [部署与运行](docs/deployment.md) |
| 使用控制台、REST、Lark，以及追问和恢复 | [渠道操作与会话恢复](docs/channels.md) |
| 配置 SSH、目录访问权限和原生技能 | [SSH 与 Skills](docs/ssh-and-skills.md) |
| 了解各数据源的能力、权限和查询限制 | [数据源边界与知识](docs/diagnostics.md) |
| 开发插件，了解合同、测试和依赖 | [插件开发与验证](docs/development.md) |
| 通过 Git tag 构建并推送镜像 | [镜像发布](docs/image-release.md) |

## 开发与扩展

项目使用 TypeScript 和 ESM，核心与具体插件分离。新增引擎、工具或渠道时，实现统一插件合同，再通过配置加载即可。

```text
src/
├── core/                   # 配置、授权、调查调度、证据与状态
├── plugin-api/             # 插件公共类型与校验合同
├── plugins/                # Codex、数据源、Lark、REST 与管理控制台
└── mcp/                    # MCP 工具桥接与后端进程管理
prompts/                    # 排障与报告修正提示
examples/                   # 离线示例、真实接入模板、知识与技能示例
test/                       # 单元、集成与控制台浏览器测试
tools/                      # 构建、后端安装与验证脚本
docker/                     # 镜像与 Compose 配置
```

```sh
npm run typecheck
npm test
npm run build
```

[GitHub CI](.github/workflows/ci.yml) 在 Node.js 22/24 上执行格式、类型、测试、构建和离线配置检查，并用固定后端及临时 PostgreSQL/Redis 容器运行集成测试。集成测试准备、控制台验证和插件开发方式见[开发文档](docs/development.md)。

## 许可证

[Apache License 2.0](LICENSE)
