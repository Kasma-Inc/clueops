# ClueOps（寻迹）

从日志线索到排障证据。

TypeScript 插件式排障服务：通过Lark或REST接收日志，按当前用户授权绑定目标，由Codex自主调用查询工具或SSH，保存证据并返回可追问的报告。引擎、工具、渠道均通过配置加载，Core没有厂商分支。

首次接入实际环境先看[配置与目标](#配置与目标)，再选择 [Docker Compose 部署](#docker-compose-部署)或[直接启动](#真实服务启动)；编写插件看[接入插件](#接入插件)。

需要 Node.js 22.5 或更高版本，Codex运行环境必须支持其原生OS权限，且需Git（用于隔开调查工作目录的技能发现范围，不克隆远端）；首版部署平台为macOS/Linux。Docker镜像已包含所需程序。先运行不连接外部服务的示例：

```sh
npm install
npm run check-config -- --config examples/demo/config.yaml
```

```sh
npm run typecheck
npm test
npm run build
npm start -- --check-config --config examples/demo/config.yaml
```

检查成功输出 `status: "valid"` 和插件实例身份。该命令校验并创建实例后释放资源，不启动渠道或调查。`examples/demo/plugins/fixture.mjs` 是可执行的合成测试插件，提供引擎、工具和渠道合同示例；示例凭证均为占位值，没有真实连接。

想直接用curl跑完整消息流程，见[REST渠道](#rest渠道与curl调试)，无需Lark或模型凭证。

## 配置与目标

### 全局配置在哪里

服务没有自动搜索的固定配置入口，启动时通过 `--config <路径>` 指定。推荐在项目根目录维护 `private/config.yaml`；`private/` 已被 Git 忽略。

仓库中的两套示例用途不同：

| 入口 | 用途 |
| --- | --- |
| [examples/live/config.yaml](examples/live/config.yaml) | 实际接入的全局配置模板，配合 `live/targets/` 使用；复制后填写真实连接和凭证 |
| [examples/demo/config.yaml](examples/demo/config.yaml) | 不连接外部服务的离线示例，使用合成插件，便于先验证项目能运行 |
| [examples/demo/rest.yaml](examples/demo/rest.yaml) | 共用demo目标和假Agent，通过真实HTTP接口测试提交、查询和追问 |

`examples/demo/` 集中放置离线入口、目标配置和假插件；`examples/live/` 放实际接入模板。两套入口分别引用自己的 `targets/`，不会相互继承或自动合并。`knowledge/` 是每轮背景示例，`skills/` 是原生技能模板，`kubernetes-rbac.yaml` 和 `postgres-reader.sql` 是管理员授权参考。

首次配置时，在项目根目录执行下面的复制命令；已有 `private/` 时直接编辑现有文件，避免覆盖自己的配置。

```sh
cp -R examples/live private
mkdir -p private/credentials
```

日常只维护一份全局配置和每个环境一份目标文件。真实模板见 [config.yaml](examples/live/config.yaml)、[prod-a.yaml](examples/live/targets/prod-a.yaml)、[prod-b.yaml](examples/live/targets/prod-b.yaml)：

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

### 目标里的工具怎么配置

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

### 路径、凭证与共享

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

### plugin 在哪里定义

插件能力由代码实现，YAML 负责选择、配置和组装。自带插件实现在 [src/plugins](src/plugins)，短名到模块的映射在 [catalog.ts](src/plugins/catalog.ts)。不同能力放在不同位置使用：

| 内置短名 | 实现 | 配置位置 |
| --- | --- | --- |
| `codex` | [Codex 引擎](src/plugins/codex/index.ts) | 全局或目标的 `agent.plugin` |
| `kubernetes` | [Kubernetes 工具](src/plugins/kubernetes/index.ts) | 目标的 `tools[].plugin` |
| `database` | [数据库工具](src/plugins/database/index.ts) | 目标的 `tools[].plugin` |
| `ssh` | [SSH工具](src/plugins/ssh/index.ts) | 目标的 `tools[].plugin` |
| `github` | [GitHub 工具](src/plugins/github/index.ts) | 目标的 `tools[].plugin` |
| `lark` | [Lark 渠道](src/plugins/lark/index.ts) | 全局的 `channels.<名称>.plugin` |
| `rest` | [REST 渠道](src/plugins/rest/index.ts) | 全局的 `channels.<名称>.plugin` |

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

也可以省略全局注册，在该目标中直接写 `plugin: ../plugins/custom.mjs`，或填写已安装的 npm 包名。注册短名只说明实现在哪里，不会创建工具实例或授予目标访问权；目标仍需显式声明该工具。模块本身必须已存在，如何实现见[接入插件](#接入插件)。

所有实现经过同一合同校验，Core不识别厂商字段。程序嵌入使用内置短名时给 `PluginHost.load(file, builtinPlugins)` 传入 `dist/plugins/catalog.js` 导出的目录，CLI已完成该装配。

`agent.plugin` 决定使用哪个引擎，`agent.config` 的字段由该插件的 `manifest.configSchema` 定义并校验。例如内置Codex插件接受 `model`、`reasoningEffort`、`localCommands`；其他引擎可以定义不同字段，不能直接照搬Codex配置。全局 `agent` 是默认值，目标声明自己的 `agent` 时完整替换默认声明，不合并两份 `config`。

目标顶层的 `skills` 则是公共配置：声明当前环境可用的技能包，由引擎插件负责接入各自的技能机制。支持技能的引擎声明 `supportsSkills`；不支持时，配置非空技能集合会明确报错。引擎专用的加载参数仍放在它自己的 `agent.config` 中。

### Codex认证怎么配置

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

ChatGPT认证文件是服务登录态的导入来源：首次调查时复制到 `runtime.stateDirectory/plugins/.codex-auth/<来源路径摘要>/auth.json`，同一服务内使用相同来源的引擎共享Codex原生认证与刷新状态，各调查的HOME、工作目录和目标技能仍独立。配置检查只读取文件，不刷新或安装登录态；认证内容不拼进提示或公开范围，宿主在查询及保存命令证据前更新已知秘密的脱敏注册。原生命令输出到达模型前的边界仍见下文说明。源文件不变时，重启保留服务已经刷新的缓存；源文件重新登录后变化，重启会重新导入。切换用户或工作区会改变恢复范围，正常Token刷新不会。

服务不回写源文件。导入副本与日常客户端同时使用同一份refresh token可能相互失效；长期部署建议为服务单独登录一次，例如 `mkdir -p private/codex-login` 后执行 `CODEX_HOME="$PWD/private/codex-login" codex login`，再设置 `authFile: ./codex-login/auth.json`。失效时重新登录源文件并重启服务，不手工复制Token到apiKey字段。[OpenAI Docs认证指南](https://learn.chatgpt.com/docs/auth)、[认证持久化说明](https://learn.chatgpt.com/docs/auth/ci-cd-auth)。

Docker需要让源文件在容器内可读，例如：

```sh
cp ~/.codex/auth.json private/credentials/codex-auth.json
chmod 600 private/credentials/codex-auth.json
```

对应配置为 `authFile: ./credentials/codex-auth.json`。Compose已挂载整个private目录，源文件可以只读；后续刷新写入可写的state卷。重新登录后更新这份导入文件再重启，不把整个个人 `.codex` 目录挂进容器。

默认只统计本轮已确认的Token用量，记录在轮次状态的 `usage` 中，并显示在报告末尾；缺失或无法归属的用量标记 `complete: false`。需要限额时只在全局 `runtime.maxModelTokens` 设置正整数，省略即不开启，不再支持 `agent.config.maxModelTokens`。显式开启后，API Key模式在请求前计数并预留输出；ChatGPT登录态根据thread累计用量减去本轮检查点进行观测后检查，超额或无法确认用量时拒绝完成报告。报告修正共享同一轮预算，恢复不重复计入已确认历史。

### 程序内授权

程序内的授权入口：

```js
import { PluginHost } from './dist/core/index.js';

const host = await PluginHost.load('./examples/demo/config.yaml');
try {
  const principal = {
    channelInstanceId: 'chat', tenantId: 'example-tenant',
    conversationId: 'example-room', senderId: 'example-user',
  };
  const scope = host.authorize(principal, 'cluster-a');
  console.log(scope.target.tools.map(tool => tool.resources.resourceId)); // ['synthetic-cluster-a']
  host.restore(principal, scope.target); // 重新授权并比较当前范围
} finally {
  await host.close();
}
```

多目标未指定目标时抛出 `TargetSelectionRequired`，其中只包含当前用户获准的目标。A 的目标快照仅含 A 的引擎/工具资源摘要和知识路径；不能通过修改快照里的工具列表来选择 B。共享资源必须在两个目标配置中显式引用。

恢复使用资源范围指纹：插件身份、实现/合同版本、公开资源范围和所选知识路径共同决定指纹。仅凭证轮换不改变指纹；资源或权限范围改变时拒绝恢复。每次恢复仍检查当前租户、会话和用户授权。

## 接入插件

插件采用默认导出的 ESM 对象，包含 `manifest` 和异步 `create(config, context)`。公开类型和 Schema 位于 [src/plugin-api](src/plugin-api/index.ts)，构建后同时生成声明文件；当前保持单 npm 项目，未独立发布 SDK 包。普通 JavaScript 插件可直接返回符合合同的对象，无须依赖宿主内部实现。

| 字段 | 合同 |
| --- | --- |
| `manifest.id / version / apiVersion` | 实现身份、实现版本、合同版本；当前合同版本为 `1` |
| `manifest.capabilities` | 声明 `engine`、`tools`、`channel` 中实际提供的能力 |
| `manifest.configSchema` | JSON Schema 2020-12；同步校验，不自动获取远程引用 |
| `create` | 各配置实例独立创建；配置已通过 Schema 且为不可变副本 |
| `instance.scope` | 非敏感资源身份和授权范围，例如集群、账号身份、namespace、数据库/schema、仓库；不得返回原始配置、密码、Token 或含凭证连接串 |
| `instance.dispose` | 释放创建阶段的资源；创建失败未返回实例时，插件自行清理已取得的资源 |

各能力的运行合同：

- 引擎创建/恢复会话并输出标准事件和报告，接收已经授权的工具调用合同，自行转换为所用引擎的工具形式。
- 引擎可声明 `supportsNativeTools`，表示无可用 MCP 时仍能调查；原生查询的实际结果通过 `options.recordEvidence(observation, signal)` 交给宿主绑定当前轮次、脱敏、限量和持久化。引擎不能在观察结果中指定另一个调查/目标身份。
- 工具声明名称、输入 Schema 和读取属性，在 `bind` 时为当前调查轮次创建独占后端；所有远程连接延迟到绑定阶段，连接故障以本轮不可用结果表达。
- 渠道注册标准消息处理器并返回投递回执；`start(handler, signal)` 必须合作取消，`stop()` 必须可取消尚未完成的启动，停止和释放操作须幂等。处理器返回 `accepted` 前必须持久化完整输入，已处理的拒绝或目标提示返回 `rejected`，需要平台重投的处理失败则抛出异常。出站消息可在尚无事件时发送提示，已关联调查时提供完整 `reference`。宿主先验证全部配置并创建实例，再启动路由中使用的渠道；关闭时先停止接收，再等待调查清理，最后逆序释放实例。
- 渠道可实现同步纯函数 `renderReply(reply, maxTextBytes)`，接收回复类型、目标、引用、完整文本及可选结构化报告/用量，返回分块后的 `{ text, payload? }`。业务数据在渲染前脱敏；可信渲染器只使用这些安全输入，不拼入凭证。宿主对编码后的输出执行Schema、快照和字节检查并持久化，避免再次替换渠道协议常量。文本遵守字节预算，渠道负责私有payload的编码与平台限制。`send/update` 传输保存好的内容，重试或重启不重新渲染。内置Lark渲染卡片，REST使用原有文本路径；Core不解析厂商载荷。

同一模块可配置多个实例，同名局部工具按 `(instanceId, name)` 区分。模块清单、工具 Schema 和资源摘要必须与实际能力一致；`scope` 应包含影响资源访问的身份及授权信息，凭证值单独留在插件闭包中。新增实现走相同加载路径，Core 不导入具体插件或按厂商分支。

MCP 工具可在 `bind` 的 ready 结果中返回实际发现的 `definitions`；固定版本上游工具的 Schema 在绑定后校验，并转换为稳定实例别名。Core 在返回给模型前持久化证据、检查参数、限量和脱敏。配置、模块、Schema 及知识文件都是管理员维护的受信任输入。

工具的名称、Schema、readOnly和结果状态/错误码属于可信协议，插件不得在其中编码凭证。宿主先校验协议，再脱敏最终描述、查询参数、内容、资源业务元数据和错误说明，避免合法短密码破坏协议。MCP目录转发沿用上游副作用标签，缺失视为false；同一运行时发现目录名称、Schema或标签变化会明确失败。

公共MCP参数直接遵循实际JSON Schema，包含上游明确允许的动态字段；需要禁止额外字段时由对应插件的Schema声明，不再维护第二份字段名单。绑定失败的证据也使用统一的脱敏和结果预算入口。引擎适配器将无效报告解析转成公共`ContractError`，Core不判断厂商私有码；报告只脱敏正文，调查/证据编号在结构化与纯文本呈现中保持一致。

Codex 默认保留本地命令，使用[原生权限档](https://learn.chatgpt.com/docs/permissions)限制模型的文件操作：只有本调查的工作目录和临时目录可读写，已装配技能和必要运行文件只读，其余路径默认拒绝。其他目标配置、服务认证缓存和SSH私钥不授予模型读取权限；命令环境不继承模型或MCP入口的Token。原生网络代理阻止未授权本地socket；SSH认证由独立工具插件管理，不向模型装配SSH socket。无法启用这些权限时调查失败，不回退到全权限。宿主、Codex运行时和插件仍是可信代码，它们负责读取自己的配置及凭证。

需要额外读取源码或写入导出目录时，在该目标的 `agent.config` 中显式声明：

```yaml
filesystem:
  read: [../source-checkout] # 已存在的目录或文件，只读
  write: [../exports]       # 已存在的目录或文件，允许读写
```

路径按声明该agent配置的文件解析，也支持 `~/`；符号链接按真实路径授权。配置、认证和状态目录的重叠授权会被拒绝，服务代码、依赖、宿主程序及PATH目录不能额外授权写入。系统运行目录是原生最小运行例外，不用于存放本服务配置、认证或状态，遇到这种布局会明确拒绝。不要把任何SSH密码、私钥或其他目标资料放进获准目录；SSH插件会拒绝从系统/程序运行目录加载私有配置与凭证。额外程序及其运行库也需要可读权限；默认不会放开整个包管理器目录。授权变化会改变会话范围，修改后重启并新建调查。`localCommands: false` 仍可关闭本地命令；图片查看、个人App/插件发现、子Agent和网络搜索保持关闭。

这解决本地文件和socket的访问范围。公网访问仍可用；本地命令不经过MCP资源参数检查，远端资源权限由SSH账号、数据库身份或集群RBAC落实，不能用本地目录限制替代。

### 通过 SSH 工具自主排障

SSH是独立的工具插件，放在目标的 `tools` 中。每个实例固定一台服务器，同一目标可以配置多个实例，也可以与K8s、数据库、GitHub工具一起使用。Agent自主向对应实例的 `execute` 工具提交远程 `command`，不需要为每条日志/kubectl命令实现新工具，也不需要本地SSH密钥或ssh-agent。

```yaml
# private/targets/dev.yaml；使用全局agent，不需要为SSH覆盖agent配置。
tools:
  - name: app-server
    plugin: ssh
    config:
      host: app.example.com
      user: reader
      knownHostsFile: ../credentials/app_known_hosts
      auth:
        type: private-key
        privateKeyFile: ../credentials/app_ed25519
        # 加密私钥可增加这一项，或用passphrase直接填写。
        # passphraseFile: ../credentials/app_key.passphrase

  - name: db-server
    plugin: ssh
    config:
      host: db.example.com
      user: reader
      port: 2222
      knownHostsFile: ../credentials/db_known_hosts
      auth:
        type: password
        passwordFile: ../credentials/db.password
```

| 认证方式 | auth配置 |
| --- | --- |
| 账户密码 | `type: password`，`password`或`passwordFile`二选一 |
| 私钥 | `type: private-key`，`privateKeyFile` |
| 加密私钥 | 在private-key配置中增加`passphrase`或`passphraseFile`，二选一 |
| 服务器要求密钥后再验证账户密码 | `type: private-key+password`，私钥字段及账户密码字段；私钥也可附解锁口令 |

`passphrase`用于本地解锁私钥，`password`用于服务器账户认证，两者可以同时存在。文件引用按实际声明配置的YAML解析，支持 `~/`。密码/口令文件只去掉一个末尾LF或CRLF，其余空格属于凭证并保留。私钥及秘密文件限制1MiB，只读取管理员明确配置的文件，不继承个人SSH配置、环境密码或默认agent。组合认证不会降级为单因素；交互OTP/改密提示不在本次自动认证支持范围内。

known_hosts须事先包含经过核对的主机密钥，非默认端口用 `[host]:port` 条目；hashed条目可用。不自动接受未知主机，撤销条目拒绝；CA主机证书条目目前不作为已验证的直接主机密钥使用。宿主需提供 `/usr/bin/ssh-keygen`解析信任文件，Docker镜像已包含。认证使用固定[ssh2](https://github.com/mscdex/ssh2)客户端库，只在插件内部依赖，不影响引擎或公共证据格式。

调用参数只接受 `command`，不能提供新的host、用户或凭证。每轮独占连接，同一实例同一时刻执行一个命令，忙时返回明确错误。默认连接超时10秒、单命令10秒、输出64KiB；可通过 `connectTimeoutMs`、`queryTimeoutMs`、`maxResultBytes`调整，仍受宿主本轮预算限制。退出0且输出完整才是成功证据；非零、缺失退出状态、超时、断连和超限均明确失败，超限丢弃候选输出并断开。

SSH提供通用命令能力，`readOnly: false`及MCP的readOnlyHint会如实反映这一点；只读取证任务与远端账号权限共同落实实际使用边界，不用Shell关键词分类器宣称强制只读。工具不提供隧道、Agent转发、SFTP或交互终端。取消会关闭本轮本地连接，不能证明远端命令已经终止。

连接地址、主机信任、用户和认证模式变化会改变恢复范围；普通凭证轮换不把秘密作为范围快照。修改配置后重启，旧 `agent.config.ssh`会明确报错，按上述格式迁移到tools并新建调查。本地普通命令和skills继续可用。dev私有配置已经迁移为 `dev-server`，凭证文件保留原位置。

可以在skill或knowledge中补充服务器用途、日志位置和环境约定，参考[SSH排障技能](examples/skills/ssh-investigation/SKILL.md)。SSH工具结果直接包含宿主证据编号，模型无需再调用local_command_evidence；该辅助入口仅用于Codex原生命令。

普通Markdown可通过knowledge提供每轮背景；需要原生技能发现时使用skills。两者可以一起配置，避免把同一技能同时放进knowledge而重复加载。

SDK 观测到的命令完成事件自动保存为证据；Codex 通过 `local_command_evidence` 读取真实记录及证据编号，报告仍需通过引用校验。这个辅助入口不执行命令，也不接受模型自报的命令输出。命令原始输出先由 Codex 处理，宿主在记录和证据辅助入口处脱敏，不能保证原生命令输出在到达模型前已经过滤。失败、超限或状态未知的命令不会作为成功事实使用。

固定CLI的命令输出捕获没有结构化截断字段；达到约1MiB且含完整省略标记行时，记录`LOCAL_COMMAND_OUTPUT_INCOMPLETE`和`truncated:true`，保留实际退出码及已捕获片段，辅助证据读取沿用该状态。该检测是保守的完整性判断，不能还原被CLI省略的输出。

证据读取同样计入本轮调用和返回量预算，通过 `sourceEvidenceId` 追溯原始命令记录。关闭时先向Codex CLI发送SIGINT，让它取消原生命令，再以运行标记清理残留；若CLI被超时强杀或清理无法确认，保留PID记录并报告失败；该机制用于普通子进程生命周期管理，不防御主动清空环境逃逸的恶意进程，也不能证明 SSH 远端动作已经终止。

### 在目标中配置原生 Skills

在目标文件添加skills路径即可，路径相对目标YAML解析。可以指定一个技能目录、SKILL.md文件，或者一个包含多个技能的目录：

```yaml
# private/targets/dev.yaml
tools: []
skills:
  - ../skills
knowledge:
  - ../../examples/knowledge/investigation.md
```

```text
private/
  targets/dev.yaml
  skills/
    dev-ssh/
      SKILL.md
      references/        # 按需提供
      scripts/           # 按需提供，保留可执行位
      assets/            # 按需提供
```

最小SKILL.md如下。name在同一目标内不能重复，description说明何时使用，正文提供该技能特有的信息与步骤：

```markdown
---
name: dev-ssh
description: 调查dev环境错误日志和运行异常时使用，通过SSH访问该环境。
---

在这里写应选用的SSH工具实例、日志位置和环境约定，不写密码或私钥。
```

服务启动时扫描所列路径、校验元数据并计算包内容摘要。创建或恢复调查时，把当前目标完整技能包装入该调查专用的HOME/.agents/skills，替换旧的受管集合。Codex原生读取名称、说明及安装路径，选择技能后再读取正文、references或执行scripts；不会把所有正文作为knowledge提前注入。这与 [OpenAI Docs的原生技能机制](https://learn.chatgpt.com/docs/build-skills)一致。

“安装”在这里指复制本地技能包及资源，不从GitHub或npm下载，不执行初始化脚本或安装依赖。脚本需要的程序由宿主或镜像提供；技能也不会自动开启被关闭的工具。私有连接信息和密钥路径可以写在私有技能中，密钥文件放在credentials下，避免随技能内容进入模型上下文。

只扫描当前目标明确选择的路径。每个调查有独立技能目录和Git工作仓库边界，不继承操作者个人技能或父项目skills，恢复时也会清理工作根残留的技能目录；Codex自带的系统技能仍由运行时提供。源技能由可信宿主读取，模型只能读取本调查装配的副本，不能修改副本。整个技能目录可通过符号链接引用，包内符号链接、特殊文件和嵌套的第二份SKILL.md会报错；.git及node_modules不复制、不计入内容摘要。源技能放在private/skills等管理员维护目录，与调查HOME、工作目录和受管安装位置保持分离，任一方向的包含关系都会在写入运行文件前被拒绝。集合及资源扫描最多8层，单目标最多128个技能、8192个文件、64MiB资源，单SKILL.md最多256KiB；空目录允许初始化，错误路径、非法元数据和同名冲突会明确失败。

修改配置或技能后重启服务生效。技能新增、删除、内容或执行标志变更会改变目标范围，需要新调查；已运行服务发现源包与启动时摘要不一致时会要求重启，不静默使用变化后的内容。该版本同时收紧了Codex工作目录发现边界，升级后旧Codex会话范围不匹配时应新建调查。

## REST渠道与curl调试

内置渠道目前为Lark和REST；其他平台通过同一渠道插件合同扩展。REST可单独启用，也可与Lark并行。每个REST实例固定一个租户、会话和用户，Token持有者使用该身份；目标权限仍由该实例的 `routes` 决定，请求不能伪造调用身份。

先运行离线示例，Agent和数据源均为合成实现，HTTP和调查协调流程是真实的：

```sh
npm run build
npm start -- --config examples/demo/rest.yaml
```

在另一个终端提交：

```sh
curl -sS http://127.0.0.1:8080/messages \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"demo-001","targetId":"cluster-a","text":"服务出现错误，帮我排查"}'

# 返回202、investigationId及turnId；轮询获取受理、进度、报告和失败回复。
curl -sS 'http://127.0.0.1:8080/messages?investigationId=REPLACE_EVENT_ID&after=0&limit=20' \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN'
```

查询必须带创建调查时返回的 `investigationId`，不提供全量消息列表；缺少编号返回400，未知调查、其他渠道/会话或当前身份无权访问的目标返回403。服务先筛选该调查再分页。查询响应包含 `messages` 和 `nextCursor`，后续保留同一编号并把 `after` 换成已读取的 `nextCursor`；每页最多100条。每条回复含 `messageId`、`cursor`、`text` 及可用的事件/轮次 `reference`，重启后仍可查询。

终端只看消息正文时，可在查询命令后加 `| jq -r '.messages[].text'`。消息列表包括受理、报告和失败通知，202只表示持久受理成功。修复或更新代码后须重启服务加载新构建；旧消息不会自动改写，重新测试使用新的messageId，并从原nextCursor继续查询。


追问时使用新的 `messageId`，带上实际返回的事件编号：

```sh
curl -sS http://127.0.0.1:8080/messages \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"demo-002","investigationId":"REPLACE_EVENT_ID","text":"还缺少哪些证据？"}'
```

也可用回复的 `messageId` 作为 `replyToMessageId` 关联调查。状态、取消、续接和重试投递分别加 `action: status/cancel/continue/retry-delivery`，同时提供 `investigationId` 和非空 `text`。网络错误后用同一 `messageId` 与原始内容重试；修改内容或发起新一轮时使用新编号。

真实环境在 `private/config.yaml` 的 `channels` 下添加 `plugin: rest`，完整配置示例位于 [live/config.yaml](examples/live/config.yaml) 末尾；只使用REST时删除Lark实例及其路由。将示例Token换成16–512个非空白ASCII字符的随机值，直接写 `token` 或用 `tokenFile` 引用私有文件，二选一。默认监听 `127.0.0.1:8080`，每个实例使用独立端口。请求体上限64KiB，业务拒绝返回422；认证、格式、体积、媒体类型和暂时处理失败分别返回401、400、413、415和503，错误响应不回显原始输入或Token。

REST 的 `conversationId` 是来源和授权范围，不是Codex thread编号；同一入口可创建多个独立调查。新 `messageId` 且不带调查/回复关联创建新调查，带 `investigationId` 或 `replyToMessageId` 才续接。Lark及其他渠道同样须显式关联调查，状态、取消和追问经过当前来源及用户权限校验；不会按最近调查猜测。Lark已发送消息遵循群本身的可见权限。

回复邮箱在 `runtime.stateDirectory/plugins/<渠道名>/mailbox/`，与调查记录分开保存。单实例最多10000条、单条128KiB，容量满时明确失败，不自动删旧回复；调试数据需要清理时先停机并保留仍需恢复的调查记录。该入口用于受信客户端调试；多个调用身份可分别配置渠道实例和Token。

## Docker Compose 部署

部署文件统一放在 [docker/](docker)：[compose.yaml](docker/compose.yaml)、[Dockerfile](docker/Dockerfile) 和构建忽略文件 [Dockerfile.dockerignore](docker/Dockerfile.dockerignore)。构建上下文为项目根目录，Compose 中的 `../private` 指向项目根目录的私有配置。只启动排障服务，连接配置中的现有集群、数据库、GitHub 和 Lark，不额外创建数据库或消息队列。

在项目根目录执行；不需要先在宿主安装 Node 或 MCP 后端：

```sh
# 首次配置时复制；已有 private 配置则跳过复制，直接编辑现有文件。
cp -R examples/live private
mkdir -p private/credentials
# 填写 private/config.yaml 和 private/targets/prod-a.yaml，放入引用的 kubeconfig 和证书。

docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm clueops --check-config --config /app/private/config.yaml
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml logs -f clueops
```

`--check-config` 只检查配置和本地依赖，不验证远端连接。镜像也带离线示例，可在准备真实凭证前运行：

```sh
docker run --rm clueops:local --check-config --config /app/examples/demo/config.yaml
```

Compose配置了 `security_opt: [seccomp=unconfined]`，让非root用户可创建Codex内部bubblewrap所需的用户命名空间。这个设置撤掉外层Docker默认seccomp过滤，模型命令仍受Codex内部文件/网络权限和seccomp限制；没有启用privileged、额外capability或关闭AppArmor。宿主禁用用户命名空间或其他容器策略阻止原生隔离时会失败，应调整部署环境，不要改成全权限。自行用 `docker run` 执行真实Codex调查时也需要该security-opt；仅检查配置或运行离线fixture不需要。

容器中的目录对应关系：

| 内容 | 挂载或位置 |
| --- | --- |
| 私有配置、凭证、自定义插件和知识 | 宿主 `./private` → 容器 `/app/private`，只读 |
| 调查记录、证据和默认引擎状态 | 命名卷 `clueops-state` → `/app/.clueops/state`，可写 |
| 固定 MCP 后端与 DBHub | 构建时安装在镜像中，不依赖宿主 `.clueops/bin` 或 `node_modules` |
| 公开知识和离线示例 | 镜像内 `/app/examples` |

也可以进入 `docker/` 后直接运行 `docker compose`，配置和构建路径仍按 Compose 文件位置解析。项目名固定为 `clueops`，从不同工作目录启动不会切换到另一份状态卷。`Dockerfile.dockerignore` 是与该 Dockerfile 对应的专用忽略文件，确保使用根目录构建上下文时仍排除私有配置和宿主依赖。

直接使用 `examples/live` 模板的相对路径即可，`private/targets` 内的 `../../examples/knowledge/` 在容器中仍然有效。自定义文件放在 `private/` 下或显式增加只读挂载；引用宿主绝对路径时需改为容器内的路径。kubeconfig 引用的证书文件也需能从容器读取；如果认证依赖 exec 插件，则需在派生镜像中安装该程序。

镜像以 `node` 用户（UID/GID `1000:1000`）运行。Linux 上需让该用户能够读取挂载的私有目录和文件；例如由管理员将 `private/` 所有权交给该服务用户，并为目录设置 `700`、文件设置 `600`。不要将私有配置改为所有人可读。新建状态卷会沿用镜像中的目录所有权。

Lark 通过出站长连接收消息，当前无需公网回调地址或端口映射。容器必须能访问配置中的 API、数据库和集群地址；容器里的 `localhost` 指容器自身，连接宿主服务时使用可达的宿主地址。镜像内置 tini 回收子进程，Compose 配置日志轮转、自动重启及一分钟停止宽限期，参数含义见 [Docker Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

```sh
# 修改私有配置后重启加载。
docker compose -f docker/compose.yaml restart clueops
# 修改代码或依赖后重新构建并替换容器。
docker compose -f docker/compose.yaml up -d --build
# 停止并移除容器，保留调查状态卷。
docker compose -f docker/compose.yaml down
```

仅运行一个服务实例，不能让多个容器同时写同一状态卷。备份或迁移时先停机并保存状态卷及私有配置；`docker compose -f docker/compose.yaml down -v` 会删除状态卷。默认状态路径应保持 `/app/.clueops/state`，修改 `runtime.stateDirectory` 或显式配置引擎 `stateDirectory` 时，需要同步调整持久化挂载。

镜像采用 Node 24 Debian slim，支持锁定文件列出的 Linux arm64/x64 后端，按 Docker 构建平台安装。数据库后端默认安装 PostgreSQL 驱动；其他数据库仍按[数据源边界与知识](#数据源边界与知识)单独部署和验收。需要指定基础镜像摘要或可访问的镜像地址时，可使用 `docker compose -f docker/compose.yaml build --build-arg NODE_IMAGE=<镜像引用>`；私有凭证始终通过运行时挂载提供，不作为构建参数。

## 真实服务启动

```sh
npm ci
npm run build
node tools/install-backends.mjs
# 首次创建 private 时复制；已有配置时跳过此步。
cp -R examples/live private
mkdir -p private/credentials
# 编辑 private/config.yaml 和 private/targets/*.yaml。
# kubeconfig、证书按目标文件中的引用放入 private/credentials/。
npm start -- --check-config --config private/config.yaml
npm start -- --config private/config.yaml
```

安装脚本依据 [backends.lock.json](tools/backends.lock.json) 的固定发布资产和 SHA-256 下载 K8s/GitHub 二进制到 `.clueops/bin/`，DBHub 通过独立 lockfile 安装到 `tools/dbhub/node_modules/`；Redis官方MCP通过哈希锁定依赖安装至 `.clueops/redis-venv/`，宿主需Python3.11+及venv/pip。内置插件默认使用这些路径，不需要填写 backend；自定义部署才覆盖 `backend.command/args`。请求处理不执行 npx、pip、下载或升级。`--check-config` 校验配置、模块、连接文件和授权组合，不连接集群、数据库、Redis或 Lark；成功不代表远端可达。

`SIGINT` / `SIGTERM` 停止接收并取消活动轮次，释放引擎及本轮后端，最后关闭状态文件锁。退出时输出汇总指标；清理无法确认时返回非零退出码。状态目录必须是支持 hard link、不覆盖发布、原子 rename、目录 fsync 和本机文件锁的同一持久文件系统；启动会探测，不支持时拒绝运行。首版一个状态目录只允许一个服务实例，不支持多副本共用网络盘。

配置及凭证均来自明确的配置文件，不继承个人 kubeconfig、数据库 DSN、GitHub 环境变量或 Codex 配置。默认插件状态放在 `runtime.stateDirectory/plugins/<实例>/`；停机后备份整个状态目录，若显式覆盖引擎 stateDirectory 则一并备份。运行目录与状态目录只对服务账号开放。回退时使用对应源码、lockfile和二进制摘要重新构建；范围指纹不兼容会拒绝续接，需新建事件。旧的 plugins/module/configFile 组合入口已替换，使用旧格式会明确失败；保留旧状态备份，按新模板组织配置，不自动重绑旧事件。不要删除活动状态目录来解除锁。

## Lark 操作与恢复

Lark最小接入仅需应用凭证，不需要先查询租户、群、用户或机器人ID：

```yaml
channels:
  lark:
    plugin: lark
    config:
      appId: cli_0123456789abcdef
      appSecretFile: ./credentials/lark.secret
```

| 字段 | 是否必填 / 省略时行为 |
| --- | --- |
| `plugin` | 必填，内置渠道填写 `lark` |
| `enabled` | 可选，默认 `true`；`false`自动禁用渠道及其路由 |
| `config` / `configFile` | 二选一必填；内联配置或独立文件 |
| `config.appId` | 必填，Lark自建应用App ID |
| `config.appSecret` / `config.appSecretFile` | 二选一必填；直接填写或引用凭证文件 |
| `config.tenantId` | 可选；不填从认证消息事件取得，填写后只接收该企业 |
| `config.botOpenId` | 可选；不填启动时通过官方接口自动查询，填写后跳过查询 |
| `routes` | 可选；省略允许渠道可收到的来源使用全部已登记目标；`[]`不授权任何来源且不开始接收 |
| `routes[].tenant` | 可选；省略不限企业，填写后精确匹配 |
| `routes[].conversation` | 可选；省略不限群，填写后精确匹配群chat_id |
| `routes[].allowedSenders` | 可选；省略不限用户，填写后精确匹配用户open_id；`[]`表示本规则不授权用户 |
| `routes[].targets` | 可选；省略允许全部已登记目标；`[]`表示本规则不授权目标 |

路由语义适用于所有渠道，Core不按Lark特判。多个匹配规则的授权目标取并集；空列表仅表示该规则不授权，不覆盖其他匹配规则。只填`routes: [{targets: [dev]}]`即可限制排障环境，无需同时填写其他过滤项。应用能收到哪些消息仍受Lark权限、应用可用范围和群成员关系约束；每次调查只获得所选目标的工具和配置，追问、状态与查询保持原渠道/租户/会话关联。

创建国际版Lark自建应用并启用机器人，使用长连接订阅`im.message.receive_v1`，开通群@读取`im:message.group_at_msg:readonly`及机器人发送`im:message:send_as_bot`，发布并加群。只接受正确应用的群内用户文本/富文本，需@本机器人或明确回复；租户来自SDK事件，事件与发送人租户不一致会被拒绝。机器人身份查询只在启动时执行，不增加企业/群/通讯录查询权限；`--check-config`保持本地检查，查询失败不猜测身份、不启动监听。

```text
@机器人 /target prod-a
ERROR connection pool exhausted ...完整原日志...

@机器人 /event <事件编号> 为什么这些连接没有释放？
@机器人 /status <事件编号>
@机器人 /cancel <事件编号>
@机器人 /continue <事件编号> 已确认可以续接，请继续检查
@机器人 /retry-delivery <事件编号>
```

带调查编号的新回复使用卡片：报告仅显示非空的事实、疑似原因、建议和待补充证据，证据以E1等短编号引用；展开“调查详情”可查看完整调查/轮次编号、Token用量及证据对照，展开“操作指引”可复制带当前调查编号的命令。正文末尾保留回复卡片并@机器人的追问提示；蓝色报告标题表示完成调查，不表示故障已修复。长内容按文字预算及编码后请求预算分页，帮助整体只生成一次，超长详情/帮助自身也可分页。卡片及其文本随投递计划一起保存；旧文本计划保持原样，不补写旧群消息。

环境选择、权限提示、受理、状态、取消、重试发送和失败通知也使用卡片。多目标提示只列当前来源获授权的环境及可复制的`/target`用法；状态使用中文标签，取消和重试显示实际影响，没有待处理项时明确说明。`/status`、`/cancel`和`/retry-delivery`只回复操作结果，不额外发送排查受理卡片。技术错误码进入折叠的诊断信息；统一文案维护在[src/plugins/lark/copy.ts](src/plugins/lark/copy.ts)。

新卡片使用[Lark原生回复接口](https://open.larksuite.com/document/server-docs/im-v1/message/reply)引用触发它的用户消息：受理和报告引用该轮请求，追问结果引用那条追问，状态/取消/错误提示引用对应指令或输入；各分块保持同一引用，便于群内区分并发请求。无需增加配置。引用消息ID与投递计划保存，重试/重启不换成最近消息；旧无引用计划仍使用原群发送方式。原消息无法回复时保留投递失败/未知状态，不自动改发无引用消息。

也可以在群里引用其他人的日志，再发送`@机器人 /target prod 帮我分析这条日志`；显式引用时，`@机器人 /target prod`也可直接分析原文。支持文本及包含文字、链接、代码块、Markdown的富文本，只读取直接引用的同群一条消息；图片、附件等暂不读取，原消息撤回、权限不足或内容过长会明确提示。原文作为待分析数据加入当前问题，不解析其中的`/target`等命令。已知调查输入/机器人卡片仍走原续接，不调用消息获取接口；未@的无关回复不会触发排查或提示。

这个用法需要[获取消息内容](https://open.larksuite.com/document/server-docs/im-v1/message/get)的应用权限。除接收群@和发送消息外，在Lark后台开通`im:message:readonly`，并按群消息读取要求开通`im:message.group_msg`，发布/安装新版本；群消息能力仍由Lark权限和应用可用范围决定。仅开通`im:message.group_at_msg:readonly`不能替代原文读取权限。应用读不到时可复制原文发送。此功能不扫描群历史，成功受理后保存原文快照，重投不重新读取已编辑/删除的原消息。

未完成的控制指令恢复时，之前可能已执行部分操作，回复会说明原始影响数量未能完整确认，并继续处理剩余项；不把剩余零项说成原操作没有影响。已有结果计划保持原样，不重新计算数量或改写卡片。

使用命令时在原群先从@列表选中机器人再发送。`/retry-delivery`仅重试未确认成功的消息，不重发已确认成功的分块，也不重跑调查；重试不重新排版或追加说明。公共`renderReply`同时接收调查回复和不关联调查的`notice`通知，渠道决定展示；Core保留原有机器`reason`及授权检查，未选环境的消息不会建立调查或启动模型。HTTP回复不追加Lark文案或卡片载荷。卡片发送/更新使用现有机器人权限，无需增加按钮回调或事件订阅。

新请求只有一个授权目标时可省略 `/target`。多目标时必须“目标 + 完整日志”重新发送；不会保存待选择日志。追问也可回复原输入、受理、状态或任一报告分块。显式事件编号与已知引用冲突、跨会话、目标改变或撤权会拒绝；未知引用需要事件编号，不按最近事件猜测。单独的 `/target prod-a` 不创建事件。

受理、控制指令、唯一轮序和完整脱敏输入原子落盘后，事件回调才返回，SDK 随后确认平台事件。重复平台消息返回原事件和轮次。调查在后台按事件串行，不同事件受全局/目标并发限制。回执和所有分块的原始输出计划持久化；重启或修改分块限制后沿用旧计划。发送超时保留 unknown 并用同一平台 UUID 重试；Lark 的去重窗口有限，不能保证无限期绝无重复展示。重试只发送出站消息，不重跑调查。

重启将已开始但未完成的轮次标为 interrupted，后续已受理输入暂停；`/continue` 明确终结不确定前序，再按原顺序处理排队输入，不自动重放原输入。`/cancel` 只作用于该控制指令之前的轮次，旧取消消息重投不影响后续追问。远端 SQL 是否停止不能仅凭客户端退出确认，证据/通知会保留 unknown。

调查队列满时，状态、取消、投递重试仍可操作；只有中断前序确实挡住已排队追问时，允许一条续接指令解堵，普通或重复续接仍受容量限制。停用/移除旧渠道不会阻塞其他入口启动：旧调查保留原状态和证据、暂停执行和投递，来源恢复后再补通知，不改投其他群。启动期间收到SIGTERM同样立即取消接收启动并等待资源清理。

真实Lark已完成应用启用、配置消息接收和长连接接入；完整验收还需：依次发起目标日志、回复受理/报告分块、重复投递同一消息、在同群并行两事件、测试未授权用户及多目标提示、重启后追问并重试报告发送。自动化覆盖SDK分发、可选路由、身份发现及启动取消；配置消息和连接验证不代替真实排障报告及追问验收。

## 数据源边界与知识

Kubernetes插件仅负责固定目标集群连接和转发上游core工具集：每轮生成只含所选context/cluster/user的kubeconfig，显式使用`cluster_provider_strategy=kubeconfig`。不配置宿主namespace/GVK/动作白名单，也不启用MCP的read_only或denied_resources；读取、跨namespace、Secret、写入和exec等实际权限直接由该kubeconfig身份的Kubernetes RBAC决定。工具副作用标签沿用MCP的readOnlyHint，缺失按false处理，不会把写入或exec标为只读；排障任务不会因此自动授权生产变更。

K8s工具配置仅需`kubeconfig`和`context`，可选`backend`、`resourceId`、`maxResultBytes`。旧`namespaces/resources/maxLogLines/maxPageRows`字段已删除，继续配置会明确报错。列表可省略namespace查询整个当前集群；具体对象未指定namespace时使用原kubeconfig默认namespace（未配置则default）。配置查看/切换工具集不装配，其他集群连接不进入本轮。kubeconfig文件证书被内联，认证exec仅来自管理员配置；旧auth-provider不支持。只读账号示例见[kubernetes-rbac.yaml](examples/kubernetes-rbac.yaml)。凭证脱敏、Pod环境变量/annotations裁剪、超时及返回字节预算保留在证据和公共调用边界。

日志支持多副本分别读取、container、previous 和有限 tail。固定版本没有精确日志时间过滤；取得时间不等于故障覆盖窗口，最近片段标记为有限覆盖，丢失或查询失败不能表示没有异常。

Redis可在任一目标文件的`tools`列表中按需增加；同一目标也可以配置多个Redis实例，不会自动加入其他目标：

```yaml
  - name: cache # 必填：本目标内唯一的工具名称
    plugin: redis # 必填：内置Redis官方MCP适配插件
    config:
      host: redis.example.internal # 必填，不能填写URL或连接串
      port: 6379 # 选填，默认6379
      database: 0 # 选填，默认0
      username: diagnostic_reader # 选填，Redis ACL用户名；省略使用default
      passwordFile: ../credentials/redis.password # 选填；与password二选一，无认证时均省略
      # password: REPLACE_PASSWORD # 选填，直接配置密码
      # tls: {} # 选填，存在即开启TLS并强制验证服务端证书；省略为明文
      # tls:
      #   caFile: ../credentials/redis-ca.pem # 选填，自定义CA，否则使用系统CA
      #   certFile: ../credentials/redis-client.pem # 选填，与keyFile配对配置
      #   keyFile: ../credentials/redis-client.key # 选填，客户端私钥
      maxItems: 100 # 选填，默认100，范围1–1000
      queryTimeoutMs: 10000 # 选填，默认10秒，最大60秒
      maxResultBytes: 131072 # 选填，默认128KiB，范围1KiB–1MiB
```

Redis插件复用[官方Redis MCP](https://github.com/redis/mcp-redis)0.5.1，仅开放`info`、`dbsize`、`type`（含TTL）、`scan_keys`、`get`、`hget`、`hexists`、`llen`、`lrange`、`zrange`、`xrange`。没有写入、任意命令、脚本、订阅或`scan_all_keys`；Hash按字段读取，不提供无界的`hgetall`/`smembers`。范围只接受非负索引且跨度不超过maxItems；SCAN的count是服务端提示，页数及每页数量不保证，需用返回游标继续，非零游标和范围片段会标记有限覆盖。单个GET值由上游完整读取，宿主字节限制约束回传内容，不能据此保证上游内存用量。

服务端账号应仅授予需要的命令：`+ping +select +client|setinfo +info +dbsize +type +ttl +scan +get +hget +hexists +llen +lrange +zrange +xrange`，并由管理员设置密码和键范围，不授`+@all`；ACL键模式不保证限制SCAN/INFO等全局观察。`database`只固定逻辑DB，Redis ACL不提供按DB授权；`info`是实例级状态，需要环境隔离时使用独立Redis实例/代理与账号。首版验证单节点/托管代理入口，未接入Cluster/Sentinel拓扑。密码文件仅去掉一个末尾LF/CRLF，保留首尾空格；相对路径以目标文件为基准。

官方后端使用lazy连接，工具发现成功不代表认证成功。部分错误返回普通字符串，插件按固定错误前缀保守标记失败；与这些前缀完全相同的业务字符串也会标为失败，其他业务JSON的`error`字段不会被通用判断成失败。查询超时/取消复用本轮资源释放和未知远端状态语义。

宿主安装后端还需Python3.11+及venv/pip：`node tools/install-backends.mjs`会按`tools/redis/requirements.txt`的版本和哈希安装隔离环境；Docker已包含。运行时不下载依赖、不读取个人dotenv，不把Redis密码放进命令参数或Agent上下文；未配置Redis的目标不会启动Redis后端。

数据库复用 DBHub，每轮一个 source，显式 lazy、工具级 readonly、max_rows、连接池及服务端 query_timeout。lazy 初始化成功不代表能连数据库，查询失败是错误证据。首版实测 PostgreSQL；配置支持 DBHub 的 MySQL/SQLite/SQL Server，其他引擎需要部署对应驱动并另做方言、只读和取消验收。SQLite 原生驱动安装不属于默认仅 PG 的 `--ignore-scripts` 部署。不要把 SQL 分类器作为权限边界，使用 [postgres-reader.sql](examples/postgres-reader.sql) 的只读身份，并按实际 schema、表和运行视图授权。可查询结构、业务数据、`pg_stat_activity`、`pg_locks`；查询输出仍会限行/限字节。`pg_read_all_stats` 可暴露其他数据库的活动信息，严格数据库隔离环境应由 DBA 提供经过过滤的视图或单独实例。首版不自动授予该角色，也不传任意 DSN/source 参数。

GitHub插件只负责当前目标Token与官方MCP的只读转发，不配置本地仓库名单、搜索过滤或路径/版本限制。工具目录直接来自上游`--read-only`模式；仓库访问是否允许由GitHub按Token权限决定。模型可直接使用GitHub原生搜索语法，以及tag、分支、完整SHA或省略ref的读取方式；插件不补写或改写ref/sha/detail/分页参数。

最小配置为目标文件中的`{name: app-code, plugin: github, config: {tokenFile: ../credentials/prod-github.token}}`，也可直接配置`token`（两者二选一）。`repositories`及其`runningCommit/runningVersion`字段已删除；需要权限隔离时为目标配置相应权限的Token。仍可按需覆盖backend或maxResultBytes，公共协议校验、超时/取消、输出预算及凭证保护继续生效。

源码证据记录实际仓库、路径和请求ref。使用`ref: refs/tags/v0.5.11`可直接读取；它是否对应Pod镜像仍需通过部署信息/commit等证据确认，并在报告中如实说明，不会因此禁止取证。

Codex通过显式API Key或authFile使用所选模型，认证接入见[Codex认证怎么配置](#codex认证怎么配置)。每个调查使用专用HOME/工作目录，恢复句柄校验实例、目标及范围指纹；每轮重建受限MCP入口。目标knowledge按大小和深度限制加载；知识影响调查方法，不能增加工具授权。

API Key模型调用经引擎内部本机网关隔离凭证并统计实际终态用量。未配置Token上限时不依赖input_tokens接口，也不注入输出Token上限。仅显式配置 `runtime.maxModelTokens` 时，每个Responses请求先通过 [input_tokens端点](https://developers.openai.com/api/docs/guides/token-counting)计数，再将max_output_tokens限在剩余预算内；缺少终态usage时保守消耗预留。ChatGPT登录态走原生认证，按累计检查点计算本轮差额，限额属于观测后检查。Core不实现模型推理循环。

默认限额见 [runtime-config.ts](src/core/runtime-config.ts)：输入64 KiB、MCP查询15秒、轮次120秒、调用40次、单结果128 KiB、累计1 MiB、模型Token上限默认关闭、全局4/单目标2并发、排队64、投递3次。元数据和查询参数也计入返回预算。原生命令仍受轮次总超时和显式开启的累计模型预算约束，其调用次数及捕获输出在SDK完成事件到达时计入预算；不具有MCP的单查询超时或执行前拦截保证。结果超限会截断/停止继续取证，已有证据保留。已注册凭证和常见敏感字段会在宿主记录时脱敏，业务日志中未知秘密仍须按团队的数据使用规则控制，状态目录应视为包含业务证据的私有数据。

内置提示集中维护在 [prompts/](prompts/)：`codex/investigation.md` 是排障模板，`codex/native-commands.md` 是原生命令取证说明，`report-repair.md` 是报告修正指令。`tools/build-prompts.mjs` 在dev、build、test、typecheck及配置检查前自动生成被忽略的字符串模块，tsc将其编译进dist；运行时不读取Markdown，Docker不额外携带提示源文件。修改提示后重新构建并重启服务；动态日志/历史只填充一次，不会把其中的占位符当成模板执行。

公共引擎协议目前为 `progress / usage / report`，是项目自己的插件合同；Codex插件使用TypeScript SDK的exec JSONL事件。SDK 0.166.0未暴露交互审批回调，审批策略不等于可响应的ServerRequest；真正的人工审批、补充输入需要 [Codex App Server](https://learn.chatgpt.com/docs/app-server)双向JSON-RPC及宿主请求/回复流程，当前不宣称支持。

## 验证与依赖

`npm test` 使用 Node 测试运行器，包含合成合同/恢复/并发测试，以及真实固定 Codex CLI 对本机脚本化 Responses 接口的回归。部署后运行集成测试可验证真实 K8s/GitHub 二进制的 MCP 协议和真实 DBHub + 本地 PG；不需要生产凭证。测试端点不等于线上集群或真实模型推理质量验收。

[GitHub CI](.github/workflows/ci.yml) 在推送到 main、提交 PR 或手动触发时执行 Node.js 22/24 的格式、类型、测试、构建及离线配置检查，另用固定后端和临时 PostgreSQL/Redis 容器运行集成测试，无需配置生产凭证或模型密钥。

```sh
node tools/install-backends.mjs
# 二选一：使用可用的 PostgreSQL 服务端工具，或一个本地 PostgreSQL Docker镜像。
PG_BIN=/absolute/postgresql/bin npm run test:integration
PG_TEST_IMAGE=postgres:18.1 npm run test:integration
# Redis测试同样使用独立临时容器；可指定预先拉取的镜像，默认锁定Redis8.10.0镜像摘要。
REDIS_TEST_IMAGE=redis:8.10.0 node --import tsx --test test/integration/redis.test.ts
npm run benchmark
```

PG 测试创建独立临时数据库实例并在结束后销毁；Docker镜像须预先下载，不使用个人现有数据库。需要 `psql`，服务端方式还需完整的 initdb/pg_ctl/postgres 安装。

依赖都在服务端，公开合同使用 JSON，不持久化厂商 SDK 内部格式。MCP、引擎及渠道可在插件边界替换，状态格式有显式 version；Codex 句柄替换时需新建引擎会话，证据和报告仍可保留。

| 依赖 | 固定版本 | 许可证 | 用途 |
| --- | --- | --- | --- |
| Ajv | 8.20.0 | MIT | JSON Schema 2020-12 校验 |
| ajv-formats | 3.0.1 | MIT | 标准日期等格式校验 |
| yaml | 2.9.1 | ISC | YAML 1.2 配置解析 |
| @iarna/toml | 2.2.5 | ISC | 本轮后端配置生成 |
| fs-native-extensions | 1.5.3 | Apache-2.0 | OS 文件锁，崩溃自动释放 |
| MCP client/server | 2.4.0 | Apache-2.0 | stdio 和受限 MCP 入口 |
| MCP node | 2.1.2 | Apache-2.0 | Node HTTP 传输适配 |
| Codex SDK/CLI | 0.166.0 | Apache-2.0 | 首个引擎实现 |
| Lark SDK | 1.76.0 | MIT | 国际版长连接及消息 API |
| Kubernetes MCP | 0.1.1 | Apache-2.0 | 原生 Kubernetes API 查询 |
| DBHub / pg | 1.5.0 / 8.23.1 | MIT | 数据库读取后端与 PG 驱动 |
| Redis MCP | 0.5.1 | MIT | Redis只读诊断后端，独立Python环境及哈希锁定依赖 |
| GitHub MCP | 2.0.3 | MIT | GitHub 读取后端 |

这些许可证允许商业使用，分发仍须保留相应版权/许可证和适用声明；外部服务账号与 API 条款另行适用。2026-11-02 核对固定发布及维护仓库，主项目与 DBHub 生产依赖 `npm audit` 均为0。DBHub [只读绕过](https://github.com/advisories/GHSA-mwwr-p57h-56pf)与 [MySQL 注释绕过](https://github.com/bytebase/dbhub/security/advisories/GHSA-j656-3hf2-fvjc)公告的修复版本为0.22.6，当前1.5.0仍需数据库原生权限保护。GitHub [completion/complete DoS 公告](https://github.com/github/github-mcp-server/security/advisories/GHSA-w4q6-qw23-4rg7)页面未列修复版本；宿主在协议入口拒绝该方法，不提供任意 MCP 转发。核查记录不是以后升级的安全保证。SDK 0.166.0 声明文件引用旧 MCP SDK，开发依赖额外固定1.32.2用于类型检查；服务使用MCP2传输。

实施进度见 [OpenSpec tasks](openspec/changes/add-target-scoped-investigation/tasks.md)。
