## ADDED Requirements

### Requirement: Investigations belong to targets

The system SHALL 以调查编号和目标快照关联轮次，不将渠道、租户或会话作为调查归属条件；当前认证主体的目标授权 SHALL 决定新操作权限。

#### Scenario: Cross-channel follow-up and control
- **WHEN** 有权访问目标的调用者通过另一渠道显式引用调查编号
- **THEN** 可以查询、追问、取消或续接该调查，轮次序号连续且目标不变，每轮仅回复自己的触发地址

#### Scenario: Unauthorized target
- **WHEN** 调用者没有调查目标的访问权限
- **THEN** 拒绝列表中的该记录、详情、证据及控制，不因知道编号或更换插件而获得权限

### Requirement: Durable work is independent of adapters

The system SHALL 在原渠道停用后继续执行已持久授权且目标范围未变的排队任务，并允许从其他获授权入口读取及续接；投递 SHALL 保留原目的地，不得借用重试者的收件权限。

#### Scenario: Removed source adapter
- **WHEN** 排队任务持久受理后原渠道被停用
- **THEN** 调查仍可完成，报告可从统一读取接口访问，原通知等待原渠道恢复

### Requirement: Historical reads do not execute resources

The system SHALL 保留获授权目标的历史报告和证据可读性，不因当前目标版本变化隐藏调查；诊断执行 SHALL 仍拒绝目标版本不一致。

#### Scenario: Changed resource revision
- **WHEN** 目标资源配置变化后读取旧调查
- **THEN** 返回历史内容并标明不能续接，状态和取消仍可操作，诊断追问被明确拒绝

### Requirement: Transport identifiers remain scoped

The system SHALL 保留平台地址下的消息去重、回复 ID 和回执关联，不将传输标识当作全局调查标识。

#### Scenario: Same platform message ID through different adapters
- **WHEN** 两个入口使用相同平台消息编号且显式引用同一调查
- **THEN** 分别受理为两个轮次，不冲突、不重复投递到其他地址
