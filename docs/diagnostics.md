# 数据源边界与知识

[返回项目首页](../README.md)

Kubernetes插件仅负责固定目标集群连接和转发上游core工具集：每轮生成只含所选context/cluster/user的kubeconfig，显式使用`cluster_provider_strategy=kubeconfig`。不配置宿主namespace/GVK/动作白名单，也不启用MCP的read_only或denied_resources；读取、跨namespace、Secret、写入和exec等实际权限直接由该kubeconfig身份的Kubernetes RBAC决定。工具副作用标签沿用MCP的readOnlyHint，缺失按false处理，不会把写入或exec标为只读；排障任务不会因此自动授权生产变更。

K8s工具配置仅需`kubeconfig`和`context`，可选`backend`、`resourceId`、`maxResultBytes`。旧`namespaces/resources/maxLogLines/maxPageRows`字段已删除，继续配置会明确报错。列表可省略namespace查询整个当前集群；具体对象未指定namespace时使用原kubeconfig默认namespace（未配置则default）。配置查看/切换工具集不装配，其他集群连接不进入本轮。kubeconfig文件证书被内联，认证exec仅来自管理员配置；旧auth-provider不支持。只读账号示例见[kubernetes-rbac.yaml](../examples/kubernetes-rbac.yaml)。凭证脱敏、Pod环境变量/annotations裁剪、超时及返回字节预算保留在证据和公共调用边界。

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

数据库复用 DBHub，每轮一个 source，显式 lazy、工具级 readonly、max_rows、连接池及服务端 query_timeout。lazy 初始化成功不代表能连数据库，查询失败是错误证据。首版实测 PostgreSQL；配置支持 DBHub 的 MySQL/SQLite/SQL Server，其他引擎需要部署对应驱动并另做方言、只读和取消验收。SQLite 原生驱动安装不属于默认仅 PG 的 `--ignore-scripts` 部署。不要把 SQL 分类器作为权限边界，使用 [postgres-reader.sql](../examples/postgres-reader.sql) 的只读身份，并按实际 schema、表和运行视图授权。可查询结构、业务数据、`pg_stat_activity`、`pg_locks`；查询输出仍会限行/限字节。`pg_read_all_stats` 可暴露其他数据库的活动信息，严格数据库隔离环境应由 DBA 提供经过过滤的视图或单独实例。首版不自动授予该角色，也不传任意 DSN/source 参数。

GitHub插件只负责当前目标Token与官方MCP的只读转发，不配置本地仓库名单、搜索过滤或路径/版本限制。工具目录直接来自上游`--read-only`模式；仓库访问是否允许由GitHub按Token权限决定。模型可直接使用GitHub原生搜索语法，以及tag、分支、完整SHA或省略ref的读取方式；插件不补写或改写ref/sha/detail/分页参数。

最小配置为目标文件中的`{name: app-code, plugin: github, config: {tokenFile: ../credentials/prod-github.token}}`，也可直接配置`token`（两者二选一）。`repositories`及其`runningCommit/runningVersion`字段已删除；需要权限隔离时为目标配置相应权限的Token。仍可按需覆盖backend或maxResultBytes，公共协议校验、超时/取消、输出预算及凭证保护继续生效。

源码证据记录实际仓库、路径和请求ref。使用`ref: refs/tags/v0.5.11`可直接读取；它是否对应Pod镜像仍需通过部署信息/commit等证据确认，并在报告中如实说明，不会因此禁止取证。

Codex通过显式API Key或authFile使用所选模型，认证接入见[Codex认证怎么配置](configuration.md#codex认证怎么配置)。每个调查使用专用HOME/工作目录，恢复句柄校验实例、目标及范围指纹；每轮重建受限MCP入口。目标knowledge按大小和深度限制加载；知识影响调查方法，不能增加工具授权。

API Key模型调用经引擎内部本机网关隔离凭证并统计实际终态用量。未配置Token上限时不依赖input_tokens接口，也不注入输出Token上限。仅显式配置 `runtime.maxModelTokens` 时，每个Responses请求先通过 [input_tokens端点](https://developers.openai.com/api/docs/guides/token-counting)计数，再将max_output_tokens限在剩余预算内；缺少终态usage时保守消耗预留。ChatGPT登录态走原生认证，按累计检查点计算本轮差额，限额属于观测后检查。Core不实现模型推理循环。

默认限额见 [runtime-config.ts](../src/core/runtime-config.ts)：输入64 KiB、MCP查询15秒、轮次120秒、调用40次、单结果128 KiB、累计1 MiB、模型Token上限默认关闭、全局4/单目标2并发、排队64、投递3次。元数据和查询参数也计入返回预算。原生命令仍受轮次总超时和显式开启的累计模型预算约束，其调用次数及捕获输出在SDK完成事件到达时计入预算；不具有MCP的单查询超时或执行前拦截保证。结果超限会截断/停止继续取证，已有证据保留。已注册凭证和常见敏感字段会在宿主记录时脱敏，业务日志中未知秘密仍须按团队的数据使用规则控制，状态目录应视为包含业务证据的私有数据。

内置提示集中维护在 [prompts/](../prompts/)：`codex/investigation.md` 是排障模板，`codex/native-commands.md` 是原生命令取证说明，`report-repair.md` 是报告修正指令。`tools/build-prompts.mjs` 在dev、build、test、typecheck及配置检查前自动生成被忽略的字符串模块，tsc将其编译进dist；运行时不读取Markdown，Docker不额外携带提示源文件。修改提示后重新构建并重启服务；动态日志/历史只填充一次，不会把其中的占位符当成模板执行。

公共引擎协议目前为 `progress / usage / report`，是项目自己的插件合同；Codex插件使用TypeScript SDK的exec JSONL事件。SDK 0.166.0未暴露交互审批回调，审批策略不等于可响应的ServerRequest；真正的人工审批、补充输入需要 [Codex App Server](https://learn.chatgpt.com/docs/app-server)双向JSON-RPC及宿主请求/回复流程，当前不宣称支持。
