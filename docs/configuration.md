# 配置与目标

[返回项目首页](../README.md)

## 全局配置在哪里

服务没有自动搜索的固定配置入口，启动时通过 `--config <路径>` 指定。推荐在项目根目录维护 `private/config.yaml`；`private/` 已被 Git 忽略。

仓库中的两套示例用途不同：

| 入口 | 用途 |
| --- | --- |
| [examples/live/config.yaml](../examples/live/config.yaml) | 实际接入的全局配置模板，配合 `live/targets/` 使用；复制后填写真实连接和凭证 |
| [examples/demo/config.yaml](../examples/demo/config.yaml) | 不连接外部服务的离线示例，使用合成插件，便于先验证项目能运行 |
| [examples/demo/rest.yaml](../examples/demo/rest.yaml) | 共用demo目标和假Agent，通过真实HTTP接口测试提交、查询和追问 |

`examples/demo/` 集中放置离线入口、目标配置和假插件；`examples/live/` 放实际接入模板。两套入口分别引用自己的 `targets/`，不会相互继承或自动合并。`knowledge/` 是每轮背景示例，`skills/` 是原生技能模板，`kubernetes-rbac.yaml` 和 `postgres-reader.sql` 是管理员授权参考。

首次配置时，在项目根目录执行下面的复制命令；已有 `private/` 时直接编辑现有文件，避免覆盖自己的配置。

```sh
cp -R examples/live private
mkdir -p private/credentials
```

日常只维护一份全局配置和每个环境一份目标文件。真实模板见 [config.yaml](../examples/live/config.yaml)、[prod-a.yaml](../examples/live/targets/prod-a.yaml)、[prod-b.yaml](../examples/live/targets/prod-b.yaml)：

```text
private/
  config.yaml           # 默认 Agent、Lark、群和用户授权、目标文件映射
  targets/
    prod-a.yaml         # A的K8s、数据库、GitHub及知识
    prod-b.yaml         # B只配置K8s，也可以选择完全不同的工具
  credentials/          # kubeconfig、证书；按需放凭证文件
```

在 `config.yaml` 的 `agent` 填默认引擎，在 `channels` 填渠道连接，可用 `routes` 添加限制，在 `targets` 将目标名映射到文件。全局放共享运行设置，目标文件放该环境专属的工具、连接、访问范围和知识；文件拆分方便维护，隔离由运行时绑定与授权保证。

全局文件的顶层字段如下；`plugins` 注册的是插件实现，`sharedTools` 声明的是可被多个目标引用的已配置连接，二者作用不同。

| 字段 | 用途 | 何时填写 |
| --- | --- | --- |
| `version` | 配置格式版本，当前为 `1` | 必填 |
| `runtime` | 状态保存目录、并发和预算等服务运行设置 | 按需，模板已给状态目录 |
| `agent` | 默认排障引擎及模型凭证 | 通常填写；目标也可单独声明 `agent` |
| `plugins` | 自定义插件短名 → 模块路径或已安装 npm 包名 | 添加外部插件时填写，内置插件不用重复注册 |
| `targets` | 排障目标名 → 目标文件路径 | 必填；登记文件不会自动授予用户访问权 |
| `channels` | Lark 等渠道的连接及 `routes` 授权 | 按实际渠道填写；路由选填，可限制租户、群、用户和目标 |
| `sharedTools` | 多个目标确实需要共用的工具实例 | 可选，目标必须通过 `use` 显式引用 |

## 目标里的工具怎么配置

这里的“目标”是一个排障环境，可以组合一个集群、多个数据库及代码仓库。工具统一放在目标文件的 `tools` 列表中，没有固定的工具分类栏。

目标文件的 `tools` 是扁平列表，每项写 `name`、`plugin` 和 `config`。`name` 只是稳定实例名，没有分类或类型含义；同一插件可有多个连接，如 `orders-db`、`users-db`。内置插件名称为 `codex`、`kubernetes`、`database`、`redis`、`ssh`、`github`、`lark`、`rest`，模块、二进制、Node和状态路径已有默认值。

| 字段 | 决定什么 | 例子 |
| --- | --- | --- |
| `name` | 当前目标内的实例名称，同一目标内不能重复 | `orders-db`、`users-db` 可以分别表示两个数据库连接 |
| `plugin` | 加载哪个插件实现，决定配置格式和可用能力 | 两个连接都可以使用 `database` |
| `config` | 这个实例连接哪里、使用哪些凭证和访问范围 | 两份配置分别填写订单库和用户库的连接信息 |

`name` 本身不决定连接地址。新增同类连接时增加一个不同 `name` 的列表项，继续使用相同 `plugin`，填写各自的 `config`。实例名称参与恢复身份，建议保持稳定。

```yaml
# targets/prod-a.yaml
tools:
  - name: k8s
    plugin: kubernetes
    config:
      kubeconfig: ../credentials/prod-a.kubeconfig
      context: prod-a
  - name: orders-db
    plugin: database
    config:
      source: {type: postgres, host: db-a, database: orders, user: reader, password: REPLACE_PASSWORD}
```

新增集群时复制一份目标文件、修改其连接，再在入口登记文件；配置了路由目标白名单时同步授权。入口只显式加载登记的目标文件。暂时不用某个工具时从对应目标的 `tools` 删除；工具种类没有固定三栏，也不会自动继承其他目标的数据源。可在目标内声明 `agent` 覆盖全局默认引擎。

真实入口默认只登记 `prod-a`；`prod-b.yaml` 是可选的第二环境示例，按需登记；已配置目标白名单时同步授权。

常见修改对应的位置：

| 要做什么 | 修改哪里 |
| --- | --- |
| 更换默认模型、模型凭证或 Lark 应用 | `private/config.yaml` 的 `agent.config` 或 `channels.<名称>.config` |
| 新增环境 | 新建 `private/targets/<名称>.yaml`，在全局 `targets` 登记；已有渠道目标白名单时同步更新 |
| 新增数据库、换 kubeconfig 或限制 namespace | 对应目标文件的 `tools`；不要改其他目标 |
| 允许另一个用户或群发起排障 | 默认无需配置；限制来源时编辑渠道 `routes` 的可选过滤项 |
| 给某个环境补充排障知识 | 目标文件的 `knowledge`，填写 Markdown 文件或目录路径 |
| 为某个环境接入原生技能 | 目标文件的 `skills`，填写单个技能或技能集合目录 |

## 路径、凭证与共享

启动只需指定一个入口：`npm start -- --config /绝对路径/private/config.yaml`。入口中的 `targets.dev: ./targets/dev.yaml` 引用目标文件；目标可用 `configFile: ../tools/dev-db.yaml` 引用某个工具的配置，该配置里的 `source.passwordFile: ../credentials/dev-db.password` 再引用凭证。这里最后一个路径相对 `private/tools/dev-db.yaml`，最终指向 `private/credentials/dev-db.password`。`agent` 和渠道也支持 `configFile`，不需要把所有文件路径都传给启动命令。

这是显式文件引用，不是任意YAML片段的include。普通配置直接内联更方便，只有确实需要拆分时才加 `configFile`；`knowledge`、`skills` 保持在目标文件中声明。

- 文件路径相对于实际声明文件解析：目标中的 kubeconfig、证书、知识和直接模块路径相对于目标 YAML；全局注册的模块、凭证文件和目标映射相对于全局 YAML。已安装 npm 模块按宿主依赖解析，插件自带知识相对于模块解析。
- 凭证可直接填 `apiKey`、`appSecret`、`token`、数据库 `source.password`；也可选择对应 `apiKeyFile`、`appSecretFile`、`tokenFile`、`source.passwordFile`，每项必须恰好选一种。不要求为每个密码单独创建文件。
- 数据库密码文件只移除一个末尾LF/CRLF，首尾空格保留，与SSH密码文件一致；API Key、Token等文件仍去除首尾空白。
- 普通插件配置直接内联在 `config`。确需拆出时可显式使用 `configFile`，与 `config` 互斥；外部配置内的文件引用相对于外部文件解析。
- 采用单个 YAML 1.2 文档；拒绝重复键、未知字段、非法引用、不兼容合同及类型错误，限制文件大小为 1 MiB。不做隐式类型转换或环境变量替换。
- `enabled: false` 不加载实例；正在使用的目标或渠道不能引用已禁用实例。配置修改通过重启加载。
- `lifecycleTimeoutMs` 限制渠道启动、停止与清理等待，默认为 10000，允许 1–60000。关闭时先中止启动并停止接收，再等待完成；无法确认清理时报告失败并继续释放其他实例。迟到完成的渠道启动会再次停止并清理。

真实配置放在仓库外或被忽略的 `private/`、`.private/` 目录，使用仅服务账号可读的权限，例如 `chmod 600 private/config.yaml private/targets/*.yaml`。仓库只提交占位示例，原始私有配置不进入目标快照或配置检查输出。

确需共享来源时，在全局声明并由目标显式引用：

```yaml
# config.yaml 中
sharedTools:
  common-source:
    plugin: github
    config:
      token: REPLACE_TOKEN
# targets/prod-a.yaml 中
# tools:
#   - name: app-code
#     use: common-source
```

全局声明共享工具本身不授权；仅引用它的目标获得该实例。不同目标中各自声明的同名工具是独立实例；同一目标内的名称不能重复。重新排列列表或轮换凭证不改变目标与工具身份。

## plugin 在哪里定义

插件能力由代码实现，YAML 负责选择、配置和组装。自带插件实现在 [src/plugins](../src/plugins)，短名到模块的映射在 [catalog.ts](../src/plugins/catalog.ts)。不同能力放在不同位置使用：

| 内置短名 | 实现 | 配置位置 |
| --- | --- | --- |
| `codex` | [Codex 引擎](../src/plugins/codex/index.ts) | 全局或目标的 `agent.plugin` |
| `kubernetes` | [Kubernetes 工具](../src/plugins/kubernetes/index.ts) | 目标的 `tools[].plugin` |
| `database` | [数据库工具](../src/plugins/database/index.ts) | 目标的 `tools[].plugin` |
| `ssh` | [SSH工具](../src/plugins/ssh/index.ts) | 目标的 `tools[].plugin` |
| `github` | [GitHub 工具](../src/plugins/github/index.ts) | 目标的 `tools[].plugin` |
| `lark` | [Lark 渠道](../src/plugins/lark/index.ts) | 全局的 `channels.<名称>.plugin` |
| `rest` | [REST 渠道](../src/plugins/rest/index.ts) | 全局的 `channels.<名称>.plugin` |

外部插件不必写进本项目源码。实现并部署符合合同的模块后，可以在全局 `plugins` 注册短名，例如将模块放在 `private/plugins/custom.mjs`：

```yaml
# private/config.yaml：与 agent、targets、channels 同级。
plugins:
  custom-log: ./plugins/custom.mjs
```

```yaml
# private/targets/prod-a.yaml：添加到现有 tools 列表。
tools:
  - name: app-logs
    plugin: custom-log
    config: {} # 按自定义插件的 configSchema 填写。
```

也可以省略全局注册，在该目标中直接写 `plugin: ../plugins/custom.mjs`，或填写已安装的 npm 包名。注册短名只说明实现在哪里，不会创建工具实例或授予目标访问权；目标仍需显式声明该工具。模块本身必须已存在，如何实现见[接入插件](development.md#接入插件)。

所有实现经过同一合同校验，Core不识别厂商字段。程序嵌入使用内置短名时给 `PluginHost.load(file, builtinPlugins)` 传入 `dist/plugins/catalog.js` 导出的目录，CLI已完成该装配。

`agent.plugin` 决定使用哪个引擎，`agent.config` 的字段由该插件的 `manifest.configSchema` 定义并校验。例如内置Codex插件接受 `model`、`reasoningEffort`、`localCommands`；其他引擎可以定义不同字段，不能直接照搬Codex配置。全局 `agent` 是默认值，目标声明自己的 `agent` 时完整替换默认声明，不合并两份 `config`。

目标顶层的 `skills` 则是公共配置：声明当前环境可用的技能包，由引擎插件负责接入各自的技能机制。支持技能的引擎声明 `supportsSkills`；不支持时，配置非空技能集合会明确报错。引擎专用的加载参数仍放在它自己的 `agent.config` 中。

## Codex认证怎么配置

在 `agent.config` 的 `apiKey`、`apiKeyFile`、`authFile` 中只选一项。`apiKeyFile` 读取纯Key文本，`authFile` 读取完整Codex认证JSON，并自动识别API Key缓存或ChatGPT登录态；其他登录模式、无效文件和混填明确报错，不回退到个人环境中的凭证。

本机已有 `~/.codex/auth.json` 时可以这样写；模型名按账号实际可用的模型填写：

```yaml
agent:
  plugin: codex
  config:
    model: gpt-6.1-sol
    authFile: ~/.codex/auth.json
    localCommands: true
```

`authFile` 支持 `~/`、绝对路径和相对声明文件的路径。插件只读取这个文件，不导入个人 `config.toml`、MCP、插件或技能，也不自动继承个人模型设置。使用ChatGPT登录态时不要配置API的 `baseUrl`；API Key或含API Key的auth.json仍可使用该参数。

ChatGPT认证文件是服务登录态的导入来源：首次调查时复制到 `runtime.stateDirectory/plugins/.codex-auth/<来源路径摘要>/auth.json`，同一服务内使用相同来源的引擎共享Codex原生认证与刷新状态，各调查的HOME、工作目录和目标技能仍独立。配置检查只读取文件，不刷新或安装登录态；认证内容不拼进提示或公开范围，宿主在查询及保存命令证据前更新已知秘密的脱敏注册。原生命令输出到达模型前的边界见[原生命令取证](ssh-and-skills.md#原生命令取证)。源文件不变时，重启保留服务已经刷新的缓存；源文件重新登录后变化，重启会重新导入。切换用户或工作区会改变恢复范围，正常Token刷新不会。

服务不回写源文件。导入副本与日常客户端同时使用同一份refresh token可能相互失效；长期部署建议为服务单独登录一次，例如 `mkdir -p private/codex-login` 后执行 `CODEX_HOME="$PWD/private/codex-login" codex login`，再设置 `authFile: ./codex-login/auth.json`。失效时重新登录源文件并重启服务，不手工复制Token到apiKey字段。[OpenAI Docs认证指南](https://learn.chatgpt.com/docs/auth)、[认证持久化说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth)。

Docker需要让源文件在容器内可读，例如：

```sh
cp ~/.codex/auth.json private/credentials/codex-auth.json
chmod 600 private/credentials/codex-auth.json
```

对应配置为 `authFile: ./credentials/codex-auth.json`。Compose已挂载整个private目录，源文件可以只读；后续刷新写入可写的state卷。重新登录后更新这份导入文件再重启，不把整个个人 `.codex` 目录挂进容器。

默认只统计本轮已确认的Token用量，记录在轮次状态的 `usage` 中，并显示在报告末尾；缺失或无法归属的用量标记 `complete: false`。需要限额时只在全局 `runtime.maxModelTokens` 设置正整数，省略即不开启，不再支持 `agent.config.maxModelTokens`。显式开启后，API Key模式在请求前计数并预留输出；ChatGPT登录态根据thread累计用量减去本轮检查点进行观测后检查，超额或无法确认用量时拒绝完成报告。报告修正共享同一轮预算，恢复不重复计入已确认历史。
