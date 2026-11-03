## ADDED Requirements

### Requirement: Scoped management reads

The system SHALL 在 REST 身份的当前渠道、租户、会话与目标授权范围内列出调查、读取详情与证据，并在分页之前过滤不可访问的调查。

#### Scenario: Unauthorized source
- **WHEN** 调用者尝试读取其他来源或当前无权访问目标的调查
- **THEN** 系统拒绝详情和证据读取，并且列表不包含该调查

### Requirement: Read-only target overview

The system SHALL 仅展示获授权目标的当前运行时安全配置概要，不返回原始配置和凭证。

#### Scenario: Target overview
- **WHEN** 已认证用户查看目标配置
- **THEN** 页面展示目标、引擎、工具范围、知识数量和技能信息，没有编辑操作

### Requirement: Integrated management console

The system SHALL 在显式启用管理功能的 REST 实例上提供同源浅色控制台，支持调查列表筛选、详情阅读、证据分页和使用原消息接口追问。

#### Scenario: Follow-up
- **WHEN** 用户在调查详情提交非空追问
- **THEN** 追问关联当前调查，页面显示受理结果并更新后续轮次

#### Scenario: Disconnected session
- **WHEN** Token 缺失或失效
- **THEN** 页面要求连接，不展示缓存的调查或目标内容


### Requirement: Explicit filter application

The system SHALL 在点击“筛选”或搜索框中按回车后应用目标、状态和搜索词，并区分待提交条件与已应用条件。

#### Scenario: Pending filters
- **WHEN** 用户修改目标但尚未提交筛选
- **THEN** 系统保留已应用结果，提示条件未应用，刷新和翻页不会丢弃或隐式提交草稿

### Requirement: Resilient detail updates

The system SHALL 在暂时请求失败后继续轮询，保持已展开证据，且不让迟到响应回退轮次状态或遗漏新增证据。

#### Scenario: Evidence arrives before an already loaded offset
- **WHEN** 新证据按时间和编号排序进入已读范围之前
- **THEN** 用户仍可加载它，原有条目不重复、展开状态保留
