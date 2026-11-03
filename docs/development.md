# 插件开发与验证

[返回项目首页](../README.md)

## 接入插件

插件采用默认导出的 ESM 对象，包含 `manifest` 和异步 `create(config, context)`。公开类型和 Schema 位于 [src/plugin-api](../src/plugin-api/index.ts)，构建后同时生成声明文件；当前保持单 npm 项目，未独立发布 SDK 包。普通 JavaScript 插件可直接返回符合合同的对象，无须依赖宿主内部实现。

| 字段 | 合同 |
| --- | --- |
| `manifest.id / version / apiVersion` | 实现身份、实现版本、合同版本；当前合同版本为 `1` |
| `manifest.capabilities` | 声明 `engine`、`tools`、`channel` 中实际提供的能力 |
| `manifest.configSchema` | JSON Schema 2020-12；同步校验，不自动获取远程引用 |
| `create` | 各配置实例独立创建；配置已通过 Schema 且为不可变副本 |
| `instance.scope` | 非敏感资源身份和授权范围，例如集群、账号身份、namespace、数据库/schema、仓库；不得返回原始配置、密码、Token 或含凭证连接串 |
| `instance.channel.describe` | 可选、同步返回公开的运行时身份（如机器人 Open ID）；只读内存，不发起网络或历史查询，不返回凭证。Core 按目标权限汇总到渠道信息接口 |
| `instance.dispose` | 释放创建阶段的资源；创建失败未返回实例时，插件自行清理已取得的资源 |
| `instance.pruneInvestigations` | 可选的本地历史清理；接收过期调查 ID 和本实例拥有的会话句柄，须幂等并保留认证状态 |

各能力的运行合同：

- 引擎创建/恢复会话并输出标准事件和报告，接收已经授权的工具调用合同，自行转换为所用引擎的工具形式。
- 引擎可声明 `supportsNativeTools`，表示无可用 MCP 时仍能调查；原生查询的实际结果通过 `options.recordEvidence(observation, signal)` 交给宿主绑定当前轮次、脱敏、限量和持久化。引擎不能在观察结果中指定另一个调查/目标身份。
- 工具声明名称、输入 Schema 和读取属性，在 `bind` 时为当前调查轮次创建独占后端；所有远程连接延迟到绑定阶段，连接故障以本轮不可用结果表达。
- 渠道注册标准消息处理器并返回投递回执；`start(handler, signal)` 必须合作取消，`stop()` 必须可取消尚未完成的启动，停止和释放操作须幂等。处理器返回 `accepted` 前必须持久化完整输入，已处理的拒绝或目标提示返回 `rejected`，需要平台重投的处理失败则抛出异常。出站消息可在尚无事件时发送提示，已关联调查时提供完整 `reference`。宿主先验证全部配置并创建实例，再启动路由中使用的渠道；关闭时先停止接收，再等待调查清理，最后逆序释放实例。
- 渠道可实现同步纯函数 `renderReply(reply, maxTextBytes)`，接收回复类型、目标、引用、完整文本及可选结构化报告/用量，返回分块后的 `{ text, payload? }`。业务数据在渲染前脱敏；可信渲染器只使用这些安全输入，不拼入凭证。宿主对编码后的输出执行Schema、快照和字节检查并持久化，避免再次替换渠道协议常量。文本遵守字节预算，渠道负责私有payload的编码与平台限制。`send/update` 传输保存好的内容，重试或重启不重新渲染。内置Lark渲染卡片，REST使用原有文本路径；Core不解析厂商载荷。

同一模块可配置多个实例，同名局部工具按 `(instanceId, name)` 区分。模块清单、工具 Schema 和资源摘要必须与实际能力一致；`scope` 应包含影响资源访问的身份及授权信息，凭证值单独留在插件闭包中。新增实现走相同加载路径，Core 不导入具体插件或按厂商分支。

历史保留策略由 Core 决定，插件只删除自己管理的本地文件。Core 不解释厂商目录结构；各引擎只收到自身实例的会话句柄，渠道按调查 ID 清理邮箱。插件清理在受理与存储队列之外执行，不能误删仍使用中的会话或共享认证目录；失败会保留删除计划供重试。未实现该可选方法的外部插件继续兼容，但其私有文件不会由 Core 猜测路径删除。

MCP 工具可在 `bind` 的 ready 结果中返回实际发现的 `definitions`；固定版本上游工具的 Schema 在绑定后校验，并转换为稳定实例别名。Core 在返回给模型前持久化证据、检查参数、限量和脱敏。配置、模块、Schema 及知识文件都是管理员维护的受信任输入。

工具的名称、Schema、readOnly和结果状态/错误码属于可信协议，插件不得在其中编码凭证。宿主先校验协议，再脱敏最终描述、查询参数、内容、资源业务元数据和错误说明，避免合法短密码破坏协议。MCP目录转发沿用上游副作用标签，缺失视为false；同一运行时发现目录名称、Schema或标签变化会明确失败。

公共MCP参数直接遵循实际JSON Schema，包含上游明确允许的动态字段；需要禁止额外字段时由对应插件的Schema声明，不再维护第二份字段名单。绑定失败的证据也使用统一的脱敏和结果预算入口。引擎适配器将无效报告解析转成公共`ContractError`，Core不判断厂商私有码；报告只脱敏正文，调查/证据编号在结构化与纯文本呈现中保持一致。

已知结构优先复用 SDK 类型或公共契约类型；内部函数返回具体读模型，不用 `unknown` 或宽泛字典代替。JSON/YAML、动态插件和模型输出在入口校验后再进入业务代码，不用双重类型断言绕过校验。脱敏只改正文、参数、资源业务元数据和错误说明，保留协议编号与状态类型。

## 程序内授权

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


## 验证与依赖

`npm test` 使用 Node 测试运行器，包含合成合同/恢复/并发测试，以及真实固定 Codex CLI 对本机脚本化 Responses 接口的回归。安装后端后运行集成测试可验证真实 K8s/GitHub 二进制的 MCP 协议和真实 DBHub + 本地 PG；不需要生产凭证。测试端点不等于线上集群或真实模型推理质量验收。

[GitHub CI](../.github/workflows/ci.yml) 在推送到 main、提交 PR 或手动触发时执行 Node.js 22/24 的格式、类型、测试、构建及离线配置检查，另用固定后端和临时 PostgreSQL/Redis 容器运行集成测试，无需配置生产凭证或模型密钥。

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

实施进度见 [OpenSpec tasks](../openspec/changes/add-target-scoped-investigation/tasks.md)。


## 管理控制台浏览器回归

```sh
npm run test:admin-ui
```

此命令先构建当前代码，再启动只提供静态资源的临时本地服务，通过 Playwright CLI 执行浏览器交互检查。需要 `npx` 和 Playwright CLI 可用的浏览器环境；首次运行时通过 `npx` 准备 CLI。与 `npm test` 分开运行，不要求模型、数据源或私有配置。

浏览器脚本在 [admin-console.js](../test/browser/admin-console.js)，所有调查、证据、登录与追问请求都使用合成响应。覆盖手动筛选及未应用提示、分页与草稿保留、连续请求、轮询错误恢复、证据追加与延迟响应、追问幂等重试、失效目标、路由滚动、登录生命周期及窄屏布局。临时服务和浏览器在结束时关闭。
