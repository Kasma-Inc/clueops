# Spec Delta

## Purpose

通过引擎无关的目标SSH工具提供多服务器远程取证，认证凭证由宿主使用，模型自主选择诊断命令并取得有界、可引用证据。

## ADDED Requirements

### Requirement: SSH实例固定目标连接

SSH SHALL 使用现有tools插件合同和name/plugin/config或configFile声明；一个实例固定host、port、user和已信任主机密钥，同一目标可声明多个实例。调用 MUST NOT 接受其他地址、账户、凭证、隧道或Agent转发选项。Codex MUST 不再通过agent.config.ssh装配SSH；其他引擎可复用同一工具。

#### Scenario: 当前目标配置多台服务器
- **WHEN** A目标声明app和db两个SSH实例，B声明另一个实例
- **THEN** A可分别调用app/db，B的工具不装配；覆盖host或猜测B工具时在连接前拒绝

### Requirement: 明确支持文件化认证方式

插件 SHALL 支持账户密码、私钥、加密私钥及服务器要求的公钥后账户密码；password与passphrase各自支持直接值或文件引用且互斥。路径 SHALL 按声明文件解析并支持~/。密钥格式或解锁错误在配置阶段安全失败；不读取默认SSH配置、环境密码或个人agent，不将凭证装入模型目录、环境、结果或报告。交互OTP不属于本次自动认证范围，不能静默降级。

#### Scenario: 各认证方式与组合认证
- **WHEN** SSH服务分别要求密码、私钥、加密私钥或publickey,password
- **THEN** 插件使用配置方式完成真实协议认证；组合方式不得退化为只用密码或只用密钥

### Requirement: 已信任主机与恢复身份

插件 SHALL 使用明确knownHostsFile中的目标主机密钥验证服务端，不自动接受未知或撤销的密钥。host/user/port、主机信任及认证模式 SHALL 进入非敏感范围；普通密码/密钥轮换不保留秘密快照且不改变同一范围。错误配置或主机/范围变化 MUST 不静默续用旧会话。

#### Scenario: 主机密钥错误或资源变化
- **WHEN** 对端主机密钥不匹配、被撤销，或目标主机/信任配置变更
- **THEN** 错误连接不执行命令，旧范围不能自动恢复，凭证不出现在错误或公开范围

### Requirement: 远程命令取证及生命周期

插件 SHALL 只开放有界command输入，命令内容由Agent选择；工具readOnly SHALL 为false，生产只读取证要求仍由任务与远端身份落实，不能用Shell字符串分类宣称强制只读。每轮连接独占，其他轮次取消不影响当前连接；结果包含stdout/stderr和退出状态，超时/超限/连接丢失明确失败并保留远端状态未知。关闭 SHALL 释放本地连接，迟到结果不可落盘；不能将客户端断开视为远端命令已终止。

#### Scenario: 成功、失败与输出上限
- **WHEN** 命令正常退出、返回非零、未返回退出状态或输出超限
- **THEN** 仅已确认退出0且完整的结果为成功，其他情况保留失败或截断，宿主统一脱敏及记录证据

#### Scenario: A取消而B继续
- **WHEN** 两个轮次使用独立SSH连接，A的长命令超时或被取消
- **THEN** A连接释放并拒绝迟到结果，B仍可查询，A不声称远端动作已终止
