# SSH 与原生 Skills

[返回项目首页](../README.md)

## 原生命令与目录权限

Codex 默认保留本地命令，使用[原生权限档](https://learn.chatgpt.com/docs/permissions)限制模型的文件操作：只有本调查的工作目录和临时目录可读写，已装配技能和必要运行文件只读，其余路径默认拒绝。其他目标配置、服务认证缓存和SSH私钥不授予模型读取权限；命令环境不继承模型或MCP入口的Token。原生网络代理阻止未授权本地socket；SSH认证由独立工具插件管理，不向模型装配SSH socket。无法启用这些权限时调查失败，不回退到全权限。宿主、Codex运行时和插件仍是可信代码，它们负责读取自己的配置及凭证。

上述边界适用于默认 `sandboxMode: restricted`。无法创建用户命名空间的部署可以显式设置 [`sandboxMode: danger-full-access`](configuration.md#codex沙箱怎么配置)，关闭 Codex 内部文件系统隔离和命令网络代理；该模式不能同时使用下述 `filesystem` 授权。

需要额外读取源码或写入导出目录时，在该目标的 `agent.config` 中显式声明：

```yaml
filesystem:
  read: [../source-checkout] # 已存在的目录或文件，只读
  write: [../exports]       # 已存在的目录或文件，允许读写
```

路径按声明该agent配置的文件解析，也支持 `~/`；符号链接按真实路径授权。配置、认证和状态目录的重叠授权会被拒绝，服务代码、依赖、宿主程序及PATH目录不能额外授权写入。系统运行目录是原生最小运行例外，不用于存放本服务配置、认证或状态，遇到这种布局会明确拒绝。不要把任何SSH密码、私钥或其他目标资料放进获准目录；SSH插件会拒绝从系统/程序运行目录加载私有配置与凭证。额外程序及其运行库也需要可读权限；默认不会放开整个包管理器目录。授权变化会改变会话范围，修改后重启并新建调查。`localCommands: false` 仍可关闭本地命令；图片查看、个人App/插件发现、子Agent和网络搜索保持关闭。

这解决本地文件和socket的访问范围。公网访问仍可用；本地命令不经过MCP资源参数检查，远端资源权限由SSH账号、数据库身份或集群RBAC落实，不能用本地目录限制替代。

## 通过 SSH 工具自主排障

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

可以在skill或knowledge中补充服务器用途、日志位置和环境约定，参考[SSH排障技能](../examples/skills/ssh-investigation/SKILL.md)。SSH工具结果直接包含宿主证据编号，模型无需再调用local_command_evidence；该辅助入口仅用于Codex原生命令。

普通Markdown可通过knowledge提供每轮背景；需要原生技能发现时使用skills。两者可以一起配置，避免把同一技能同时放进knowledge而重复加载。

## 原生命令取证

SDK 观测到的命令完成事件自动保存为证据；Codex 通过 `local_command_evidence` 读取真实记录及证据编号，报告仍需通过引用校验。这个辅助入口不执行命令，也不接受模型自报的命令输出。命令原始输出先由 Codex 处理，宿主在记录和证据辅助入口处脱敏，不能保证原生命令输出在到达模型前已经过滤。失败、超限或状态未知的命令不会作为成功事实使用。

固定CLI的命令输出捕获没有结构化截断字段；达到约1MiB且含完整省略标记行时，记录`LOCAL_COMMAND_OUTPUT_INCOMPLETE`和`truncated:true`，保留实际退出码及已捕获片段，辅助证据读取沿用该状态。该检测是保守的完整性判断，不能还原被CLI省略的输出。

证据读取同样计入本轮调用和返回量预算，通过 `sourceEvidenceId` 追溯原始命令记录。关闭时先向Codex CLI发送SIGINT，让它取消原生命令，再以运行标记清理残留；若CLI被超时强杀或清理无法确认，保留PID记录并报告失败；该机制用于普通子进程生命周期管理，不防御主动清空环境逃逸的恶意进程，也不能证明 SSH 远端动作已经终止。


## 在目标中配置原生 Skills

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
