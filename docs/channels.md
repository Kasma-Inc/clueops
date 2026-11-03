# 渠道操作与会话恢复

[返回项目首页](../README.md)

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

查询必须带创建调查时返回的 `investigationId`，不提供全量消息列表；缺少编号返回400，未知调查或当前身份无权访问的目标返回403。服务先筛选该调查再分页。查询响应包含 `messages` 和 `nextCursor`，后续保留同一编号并把 `after` 换成已读取的 `nextCursor`；每页最多100条。每条回复含 `messageId`、`cursor`、`text` 及可用的事件/轮次 `reference`，重启后仍可查询。

终端只看消息正文时，可在查询命令后加 `| jq -r '.messages[].text'`。消息列表包括受理、报告和失败通知，202只表示持久受理成功。修复或更新代码后须重启服务加载新构建；旧消息不会自动改写，重新测试使用新的messageId，并从原nextCursor继续查询。


追问时使用新的 `messageId`，带上实际返回的事件编号：

```sh
curl -sS http://127.0.0.1:8080/messages \
  -H 'Authorization: Bearer EXAMPLE_ONLY_LOCAL_REST_TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"messageId":"demo-002","investigationId":"REPLACE_EVENT_ID","text":"还缺少哪些证据？"}'
```

也可用回复的 `messageId` 作为 `replyToMessageId` 关联调查。状态、取消、续接和重试投递分别加 `action: status/cancel/continue/retry-delivery`，同时提供 `investigationId` 和非空 `text`。网络错误后用同一 `messageId` 与原始内容重试；修改内容或发起新一轮时使用新编号。

真实环境在 `private/config.yaml` 的 `channels` 下添加 `plugin: rest`，完整配置示例位于 [live/config.yaml](../examples/live/config.yaml) 末尾；只使用REST时删除Lark实例及其路由。将示例Token换成16–512个非空白ASCII字符的随机值，直接写 `token` 或用 `tokenFile` 引用私有文件，二选一。默认监听 `127.0.0.1:8080`，每个实例使用独立端口。请求体上限64KiB，业务拒绝返回422；认证、格式、体积、媒体类型和暂时处理失败分别返回401、400、413、415和503，错误响应不回显原始输入或Token。

REST 的 `conversationId` 是认证来源和回复地址，不是调查归属或 Codex thread 编号；同一入口可创建多个独立调查。新 `messageId` 且不带调查/回复关联创建新调查，带 `investigationId` 或 `replyToMessageId` 才续接。Lark及其他渠道同样须显式关联调查；有目标权限的调用者可以在不同入口使用同一调查编号查询、追问、取消或续接，不会按最近调查猜测。平台回复消息编号仍只在当前来源地址内解析。Lark已发送消息遵循群本身的可见权限。

统一调查查询使用 `GET /api/investigations`、`GET /api/investigations/:id` 和证据接口，接口不依赖 `admin` 页面开关。`GET /messages` 是当前 REST 实例的投递邮箱，只包含投递到该实例的回复，不代表其他来源调查的全部内容。回复邮箱在 `runtime.stateDirectory/plugins/<渠道名>/mailbox/`，与调查记录分开保存。单实例最多10000条、单条128KiB，过期调查的回复随历史清理删除；容量满时仍明确失败，不为接收新消息淘汰未过期回复。该入口用于受信客户端调试；多个调用身份可分别配置渠道实例和Token。


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

路由语义适用于所有渠道，Core不按Lark特判。多个匹配规则的授权目标取并集；空列表仅表示该规则不授权，不覆盖其他匹配规则。只填`routes: [{targets: [dev]}]`即可限制排障环境，无需同时填写其他过滤项。应用能收到哪些消息仍受Lark权限、应用可用范围和群成员关系约束；每次调查只获得所选目标的工具和配置，追问、状态与查询按调查编号和当前调用者的目标权限关联；渠道、租户和会话仅用于入口认证与回复寻址，不是调查所有权。

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

环境选择、权限提示、受理、状态、取消、重试发送和失败通知也使用卡片。多目标提示只列当前来源获授权的环境及可复制的`/target`用法；状态使用中文标签，取消和重试显示实际影响，没有待处理项时明确说明。`/status`、`/cancel`和`/retry-delivery`只回复操作结果，不额外发送排查受理卡片。技术错误码进入折叠的诊断信息；统一文案维护在[src/plugins/lark/copy.ts](../src/plugins/lark/copy.ts)。

新卡片使用[Lark原生回复接口](https://open.larksuite.com/document/server-docs/im-v1/message/reply)引用触发它的用户消息：受理和报告引用该轮请求，追问结果引用那条追问，状态/取消/错误提示引用对应指令或输入；各分块保持同一引用，便于群内区分并发请求。无需增加配置。引用消息ID与投递计划保存，重试/重启不换成最近消息；旧无引用计划仍使用原群发送方式。原消息无法回复时保留投递失败/未知状态，不自动改发无引用消息。

也可以在群里引用其他人的日志，再发送`@机器人 /target prod 帮我分析这条日志`；显式引用时，`@机器人 /target prod`也可直接分析原文。支持文本及包含文字、链接、代码块、Markdown的富文本，只读取直接引用的同群一条消息；图片、附件等暂不读取，原消息撤回、权限不足或内容过长会明确提示。原文作为待分析数据加入当前问题，不解析其中的`/target`等命令。已知调查输入/机器人卡片仍走原续接，不调用消息获取接口；未@的无关回复不会触发排查或提示。

这个用法需要[获取消息内容](https://open.larksuite.com/document/server-docs/im-v1/message/get)的应用权限。除接收群@和发送消息外，在Lark后台开通`im:message:readonly`，并按群消息读取要求开通`im:message.group_msg`，发布/安装新版本；群消息能力仍由Lark权限和应用可用范围决定。仅开通`im:message.group_at_msg:readonly`不能替代原文读取权限。应用读不到时可复制原文发送。此功能不扫描群历史，成功受理后保存原文快照，重投不重新读取已编辑/删除的原消息。

未完成的控制指令恢复时，之前可能已执行部分操作，回复会说明原始影响数量未能完整确认，并继续处理剩余项；不把剩余零项说成原操作没有影响。已有结果计划保持原样，不重新计算数量或改写卡片。

使用命令时在原群先从@列表选中机器人再发送。`/retry-delivery`仅重试未确认成功的消息，不重发已确认成功的分块，也不重跑调查；重试不重新排版或追加说明。公共`renderReply`同时接收调查回复和不关联调查的`notice`通知，渠道决定展示；Core保留原有机器`reason`及授权检查，未选环境的消息不会建立调查或启动模型。HTTP回复不追加Lark文案或卡片载荷。卡片发送/更新使用现有机器人权限，无需增加按钮回调或事件订阅。

新请求只有一个授权目标时可省略 `/target`。多目标时必须“目标 + 完整日志”重新发送；不会保存待选择日志。追问也可回复原输入、受理、状态或任一报告分块。显式事件编号与已知引用冲突、跨会话、目标改变或撤权会拒绝；未知引用需要事件编号，不按最近事件猜测。单独的 `/target prod-a` 不创建事件。

受理、控制指令、唯一轮序和完整脱敏输入原子落盘后，事件回调才返回，SDK 随后确认平台事件。重复平台消息返回原事件和轮次。调查在后台按事件串行，不同事件受全局/目标并发限制。回执和所有分块的原始输出计划持久化；重启或修改分块限制后沿用旧计划。发送超时保留 unknown 并用同一平台 UUID 重试；Lark 的去重窗口有限，不能保证无限期绝无重复展示。重试只发送出站消息，不重跑调查。

重启将已开始但未完成的轮次标为 interrupted，后续已受理输入暂停；`/continue` 明确终结不确定前序，再按原顺序处理排队输入，不自动重放原输入。`/cancel` 只作用于该控制指令之前的轮次，旧取消消息重投不影响后续追问。远端 SQL 是否停止不能仅凭客户端退出确认，证据/通知会保留 unknown。

调查队列满时，状态、取消、投递重试仍可操作；只有中断前序确实挡住已排队追问时，允许一条续接指令解堵，普通或重复续接仍受容量限制。停用/移除旧渠道不会阻塞其他入口启动：已持久受理且目标范围未变的任务继续执行，历史和新报告可从其他获授权入口读取；原通知等待来源恢复，不改投其他群。启动期间收到SIGTERM同样立即取消接收启动并等待资源清理。

真实Lark已完成应用启用、配置消息接收和长连接接入；完整验收还需：依次发起目标日志、回复受理/报告分块、重复投递同一消息、在同群并行两事件、测试未授权用户及多目标提示、重启后追问并重试报告发送。自动化覆盖SDK分发、可选路由、身份发现及启动取消；配置消息和连接验证不代替真实排障报告及追问验收。

## 管理控制台

第一版包含排障记录（搜索、目标/状态筛选、分页）、调查详情（按轮次阅读报告、证据预览、追问）和目标配置只读查看。在 REST 渠道的 `config` 中设置 `admin: true` 开启页面，重启后访问该入口的 `/admin/`，使用同一实例配置的 Token 登录。默认关闭，不影响原有 `/messages` 接口。 已有服务需要重新构建并重启；请在实际启动时 `--config` 指定的配置中开启入口，仅修改示例配置不会影响正在运行的服务。

离线示例已开启控制台：

```sh
npm run build
npm start -- --config examples/demo/rest.yaml
# 浏览器打开 http://127.0.0.1:8080/admin/
# 示例 Token：EXAMPLE_ONLY_LOCAL_REST_TOKEN
```

先按上面的 curl 示例提交调查，随后刷新记录列表即可查看。离线 Agent 只生成合成报告，不进行真实排障。

目标、状态和搜索词仅在点击“筛选”或搜索框中按回车后应用。修改后会提示“条件已修改”，列表标题旁显示已应用的条件；刷新和翻页使用已应用条件，并保留尚未提交的输入。应用新条件会回到第一页。

调查统一按当前调用者的目标授权展示，包含 Lark、REST 及其他渠道产生的记录。来源只作为元数据展示；历史配置版本变化不会隐藏报告和证据，界面会明确标明不能继续执行该调查。目标页展示当前生效的安全资源范围、引擎、知识条目数量和技能概要，不返回原始 YAML、凭证和内部会话句柄。目标修改仍通过配置文件完成，重启生效。

Token 只保留在页面内存，刷新或断开后重新输入；不要将 Token 拼接到 URL。对外访问时使用 HTTPS 反向代理保护传输。前端资源随 `npm run build` 复制到 `dist`，Docker 镜像使用相同构建，无需额外前端服务或依赖。

管理数据接口均需要 `Authorization: Bearer <token>`：

| 接口 | 用途 |
| --- | --- |
| `GET /api/investigations` | 按 `search`、`targetId`、`status` 筛选，使用 `limit`（1–50）和响应的 `nextBefore` 游标分页 |
| `GET /api/investigations/:id` | 最近轮次与报告，使用 `limit`（1–50）和 `nextBefore` 读取更早轮次 |
| `GET /api/investigations/:id/evidence?turnId=...` | 指定轮次证据，使用 `offset` 和 `limit`（1–20）分页；内容预览最多12,000字符，截断会明确标注 |
| `GET /api/targets` | 当前身份可访问目标的运行时配置概要 |

列表游标是末次受理时间与调查编号的组合，继续查询时须进行 URL 编码。追问复用 `POST /messages`，网络失败时使用同一个 `messageId` 和相同内容重试，避免重复创建轮次。


渠道无关调查版本可直接读取旧 v1 状态目录。写入跨渠道轮次后，旧版本不能直接读取该目录；回滚须使用跨渠道写入前的状态备份。
