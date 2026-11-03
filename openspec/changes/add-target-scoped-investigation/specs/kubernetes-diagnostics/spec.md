# Spec Delta

## Purpose

为调查提供目标集群中的 Pod 日志、容器状态、工作负载及关联事件等实时证据，处理多副本、多容器和日志保留限制，同时让集群、namespace 和资源授权在自动查询及并发执行时保持明确且可验证。

## ADDED Requirements

### Requirement: 集群查询固定至当前目标

系统 SHALL 为本轮集群工具只装载目标集群的连接配置，MUST NOT 提供其他集群上下文或宿主配置查看/切换能力。namespace、资源种类和动作权限 SHALL 由该kubeconfig身份的Kubernetes RBAC决定；宿主 MUST NOT 维护额外namespace/GVK/动作白名单。未指定namespace的列表 SHALL 可跨namespace查询，具体对象查询 SHALL 沿用kubeconfig默认namespace。

#### Scenario: 通过同名 context 请求另一个集群
- **WHEN** A、B 集群存在同名 context，A 的调查尝试改用 B 或列举所有集群
- **THEN** 系统拒绝越界选择，A 的后端只使用 A 的配置，B 未收到请求

#### Scenario: 跨 namespace 或集群级查询
- **WHEN** 工具请求列举全部namespace的Pod，或读取节点等资源
- **THEN** 请求透传当前集群MCP，由Kubernetes身份授权决定成功或拒绝，不因宿主白名单拒绝

### Requirement: 读取日志保留容器身份和覆盖限制

系统 SHALL 支持按 Pod 和容器读取当前日志及可用的前一次容器日志，区分副本和容器身份。行数、字节及耗时 SHALL 有上限；不支持精确时间过滤或历史日志已不存在时 MUST 明示限制，不把最近日志等同于完整故障窗口。

#### Scenario: 多副本且发生容器重启
- **WHEN** 目标工作负载有多个 Pod 和容器，故障容器发生过重启
- **THEN** Agent 可分别读取相关容器当前及可用的前次日志，每份证据保留 Pod、容器、取得时间和截断信息

#### Scenario: 前次日志不可用
- **WHEN** 请求前次容器日志但集群已不保留该日志
- **THEN** 系统明确返回不可用原因，不声称该容器此前没有异常

### Requirement: 读取运行状态及相关事件

系统 SHALL 在授权范围内提供 Pod 与容器状态、工作负载归属、副本状态、Service 后端和相关事件，以支持故障关联。无权限、资源不存在、接口不支持或取证时刻不同 MUST 被保留为结果限制，不伪装成健康状态。

#### Scenario: Pod 因调度或探针失败不可用
- **WHEN** Pod 状态与相关事件指示调度、拉取镜像、容器重启或探针异常
- **THEN** 工具返回可用状态和事件证据供 Agent 分析，并保留资源身份及取得时间

### Requirement: 透传集群工具并保留执行和输出边界

插件 SHALL 透传上游core工具集，保留工具真实readOnlyHint，MUST NOT 将写入或exec误标为只读。后端 SHALL 不额外启用read_only模式或denied_resources，实际权限由Kubernetes身份约束；排障任务不会因此自动授权生产变更。超时、取消和结果字节预算 SHALL 由公共层执行，已知凭证及敏感输出 SHALL 在返回Agent前脱敏；MCP目录变更 SHALL 拒绝沿用当前运行时的绑定。

#### Scenario: Kubernetes拒绝动作
- **WHEN** Agent调用上游提供的读取、写入或exec工具，但kubeconfig身份无对应权限
- **THEN** Kubernetes拒绝作为失败证据保留，宿主不补授权限或换用其他连接

#### Scenario: 输出过大
- **WHEN** 上游日志或资源列表超过允许结果规模
- **THEN** 系统明确返回截断或超限信息，可在剩余预算内缩小范围，不静默发送无界数据
