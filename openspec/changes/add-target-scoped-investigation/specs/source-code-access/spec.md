# Spec Delta

## Purpose

通过GitHub官方MCP读取目标Token有权访问的源码和相关信息，保留真实请求版本及上游限制，不用本地权限策略阻断正常取证。

## ADDED Requirements

### Requirement: GitHub权限由目标Token决定

插件 SHALL 只持有当前目标的GitHub Token，使用官方MCP的只读模式并转发其实际工具目录与Schema。仓库访问 SHALL 由GitHub根据Token权限执行；宿主 MUST NOT 额外维护repositories名单、固定读取工具名单、搜索语法或路径白名单，也不允许模型覆盖工具进程的认证环境。旧repositories及其运行版本字段 SHALL 从配置中删除，不保留两套权限模式。

#### Scenario: 请求Token有权访问的仓库
- **WHEN** Agent读取仓库或使用GitHub原生搜索语法
- **THEN** 请求按上游Schema透传到当前Token的MCP，由GitHub决定是否授权，不追加repo过滤或本地正则限制

#### Scenario: 上游只读工具目录
- **WHEN** GitHub MCP返回只读工具目录
- **THEN** 所有实际返回工具及其副作用标签被转发，不仅限于宿主手写的工具子集，仓库写入仍不属于该模式

### Requirement: ref及查询参数原样传递

符合上游Schema的tag、branch、完整SHA或省略ref的文件请求 SHALL 可正常传递，MUST NOT 强制先解析为40位SHA，或改写ref/sha/detail/搜索/分页参数。插件 SHALL 记录请求仓库、路径和ref等来源信息；是否对应线上部署 SHALL 由报告根据取得的证据说明，不能将镜像tag与Git tag未经验证就视为相同版本，也不能因此禁止读取。

#### Scenario: 读取用户故障版本标签
- **WHEN** get_file_contents请求ref=refs/tags/v0.5.11并包含合法owner/repo/path
- **THEN** 参数原样到达GitHub MCP，不因ref不是完整SHA而返回QUERY_OUT_OF_SCOPE；证据保留该ref，但不自动证明其对应Pod镜像

#### Scenario: 分支或默认版本
- **WHEN** Agent指定分支、SHA或省略ref
- **THEN** 按GitHub MCP原生语义读取，不自动补写配置中的runningCommit，版本对应关系未知时在报告中说明

### Requirement: 上游失败与公共边界保留

工具查询 SHALL 复用公共Schema校验、目标绑定、超时/取消、结果预算、脱敏及持久化。GitHub拒绝、限流、接口失败或截断 SHALL 如实记录，MUST NOT 伪装为空结果或由插件新增权限回退；源码文本仍作为待分析证据，不改变目标连接或凭证。

#### Scenario: GitHub拒绝请求
- **WHEN** GitHub MCP因Token权限或接口规则拒绝一次调用
- **THEN** 失败作为上游结果返回并留存，不切换Token或改用其他目标连接
