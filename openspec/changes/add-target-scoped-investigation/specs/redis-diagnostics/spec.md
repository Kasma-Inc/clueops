# Spec Delta

## Purpose

复用 Redis 官方 MCP，为指定目标提供只读排障证据，避免跨环境连接、无限扫描和把失败当作无异常。

## ADDED Requirements

### Requirement: Redis连接按目标固定

Redis插件 SHALL 从目标配置解析固定host、port、DB和可选账号/密码文件及TLS证书，文件路径相对声明文件；凭证 MUST 只交当前轮工具后端并注册脱敏。模型输入 MUST NOT 覆盖连接、DB、认证或加载其他目标。首版 SHALL 验证单节点/代理入口，不宣称支持Redis Cluster或Sentinel拓扑发现；DB编号 MUST NOT 被描述为Redis ACL隔离边界。

#### Scenario: 覆盖连接或切换DB
- **WHEN** A调查在查询参数中提供B地址、DB或凭证
- **THEN** 调用在上游执行前被拒绝，B未收到查询，A上下文不包含B配置

### Requirement: 仅开放只读且有界的Redis查询

插件 SHALL 白名单开放info、dbsize、type（含TTL）、scan_keys、get、hget、hexists、llen、lrange、zrange和xrange，MUST NOT 开放写入、任意命令、脚本、订阅或自动完整扫描。扫描count和范围/条数 SHALL 有上限；全量集合读取不开放。账号 SHALL 按实际需求仅授权必要Redis命令，工具只读元数据 MUST NOT 代替服务端ACL。

#### Scenario: 请求删除或无限范围
- **WHEN** 调用delete、scan_all_keys、负索引全量读取或超过配置批量
- **THEN** 工具入口拒绝，不执行Redis命令

### Requirement: Redis证据标记覆盖和失败边界

查询 SHALL 有超时和结果字节上限，返回数据关联固定连接/DB、键和取得时间；非零SCAN游标及有界范围片段 MUST 标记截断/有限覆盖，不把空批次当完整扫描。上游认证/权限/连接失败 SHALL 作为失败证据，MUST NOT 表示空结果；取消释放本轮后端，不影响另一轮，远端执行终止未确认时标为未知。官方后端把部分错误编码成普通字符串时，适配器 SHALL 保守识别固定错误前缀并说明其与同文业务字符串不可区分的限制。

#### Scenario: 空扫描批次但游标未归零
- **WHEN** scan_keys返回空keys且非零cursor
- **THEN** 证据保留游标并标记有限覆盖，不判定无匹配键

#### Scenario: Redis认证被拒或取消
- **WHEN** 固定连接的认证失败，或A轮调用取消
- **THEN** 保留明确失败与已知覆盖，B轮仍可读取，不自动切换无密码或其他目标连接
