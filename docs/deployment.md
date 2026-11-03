# 部署与运行

[返回项目首页](../README.md)

以下命令均在项目根目录执行。通过 Git tag 发布镜像见[镜像发布](image-release.md)。

## 使用发布镜像

先按[配置文档](configuration.md)准备 `private/config.yaml`、目标和凭证。将以下内容保存为 `private/compose.image.yaml`，替换为实际镜像地址和版本：

```yaml
services:
  clueops:
    image: registry.example.com/kasma-inc/clueops:v0.1.0
```

私有 Registry 先执行 `docker login registry.example.com`，再拉取并启动：

```sh
docker compose -f docker/compose.yaml -f private/compose.image.yaml pull clueops
docker compose -f docker/compose.yaml -f private/compose.image.yaml up -d --no-build
```

该覆盖文件只替换镜像，沿用原有私有配置挂载、状态卷和运行设置。后续更新版本时修改覆盖文件，再执行同样的拉取和启动命令。

## Docker Compose 部署

部署文件统一放在 [docker/](../docker)：[compose.yaml](../docker/compose.yaml)、[Dockerfile](../docker/Dockerfile) 和构建忽略文件 [Dockerfile.dockerignore](../docker/Dockerfile.dockerignore)。构建上下文为项目根目录，Compose 中的 `../private` 指向项目根目录的私有配置。只启动排障服务，连接配置中的现有集群、数据库、GitHub 和 Lark，不额外创建数据库或消息队列。

在项目根目录执行；不需要先在宿主安装 Node 或 MCP 后端：

```sh
# 首次配置时复制；已有 private 配置则跳过复制，直接编辑现有文件。
cp -R examples/live private
mkdir -p private/credentials
# 填写 private/config.yaml 和 private/targets/prod-a.yaml，放入引用的 kubeconfig 和证书。

docker compose -f docker/compose.yaml build
docker compose -f docker/compose.yaml run --rm clueops --check-config --config /app/private/config.yaml
docker compose -f docker/compose.yaml up -d
docker compose -f docker/compose.yaml logs -f clueops
```

`--check-config` 只检查配置和本地依赖，不验证远端连接。镜像也带离线示例，可在准备真实凭证前运行：

```sh
docker run --rm clueops:local --check-config --config /app/examples/demo/config.yaml
```

Compose配置了 `security_opt: [seccomp=unconfined]`，让非root用户可创建Codex内部bubblewrap所需的用户命名空间。这个设置撤掉外层Docker默认seccomp过滤，默认模式下模型命令仍受Codex内部文件/网络权限和seccomp限制；没有启用privileged、额外capability或关闭AppArmor。宿主禁用用户命名空间或其他容器策略阻止原生隔离时会失败。优先调整部署环境；ACK 等无法修改节点参数的环境，可在明确接受容器内访问权限后，显式配置 [`agent.config.sandboxMode: danger-full-access`](configuration.md#codex沙箱怎么配置)。默认隔离模式下，自行用 `docker run` 执行真实Codex调查也需要该security-opt；仅检查配置、运行离线fixture或显式关闭内部沙箱时不需要。

容器中的目录对应关系：

| 内容 | 挂载或位置 |
| --- | --- |
| 私有配置、凭证、自定义插件和知识 | 宿主 `./private` → 容器 `/app/private`，只读 |
| 调查记录、证据和默认引擎状态 | 命名卷 `clueops-state` → `/app/.clueops/state`，可写 |
| 固定 MCP 后端与 DBHub | 构建时安装在镜像中，不依赖宿主 `.clueops/bin` 或 `node_modules` |
| 公开知识和离线示例 | 镜像内 `/app/examples` |

也可以进入 `docker/` 后直接运行 `docker compose`，配置和构建路径仍按 Compose 文件位置解析。项目名固定为 `clueops`，从不同工作目录启动不会切换到另一份状态卷。`Dockerfile.dockerignore` 是与该 Dockerfile 对应的专用忽略文件，确保使用根目录构建上下文时仍排除私有配置和宿主依赖。

直接使用 `examples/live` 模板的相对路径即可，`private/targets` 内的 `../../examples/knowledge/` 在容器中仍然有效。自定义文件放在 `private/` 下或显式增加只读挂载；引用宿主绝对路径时需改为容器内的路径。kubeconfig 引用的证书文件也需能从容器读取；如果认证依赖 exec 插件，则需在派生镜像中安装该程序。

镜像以 `node` 用户（UID/GID `1000:1000`）运行。Linux 上需让该用户能够读取挂载的私有目录和文件；例如由管理员将 `private/` 所有权交给该服务用户，并为目录设置 `700`、文件设置 `600`。不要将私有配置改为所有人可读。新建状态卷会沿用镜像中的目录所有权。

Lark 通过出站长连接收消息，当前无需公网回调地址或端口映射。容器必须能访问配置中的 API、数据库和集群地址；容器里的 `localhost` 指容器自身，连接宿主服务时使用可达的宿主地址。镜像内置 tini 回收子进程，Compose 配置日志轮转、自动重启及一分钟停止宽限期，参数含义见 [Docker Compose 服务配置](https://docs.docker.com/reference/compose-file/services/)。

```sh
# 修改私有配置后重启加载。
docker compose -f docker/compose.yaml restart clueops
# 修改代码或依赖后重新构建并替换容器。
docker compose -f docker/compose.yaml up -d --build
# 停止并移除容器，保留调查状态卷。
docker compose -f docker/compose.yaml down
```

仅运行一个服务实例，不能让多个容器同时写同一状态卷。备份或迁移时先停机并保存状态卷及私有配置；`docker compose -f docker/compose.yaml down -v` 会删除状态卷。默认状态路径应保持 `/app/.clueops/state`，修改 `runtime.stateDirectory` 或显式配置引擎 `stateDirectory` 时，需要同步调整持久化挂载。

镜像采用 Node 24 Debian slim，支持锁定文件列出的 Linux arm64/x64 后端，按 Docker 构建平台安装。数据库后端默认安装 PostgreSQL 驱动；其他数据库仍按[数据源边界与知识](diagnostics.md#数据源边界与知识)单独部署和验收。需要指定基础镜像摘要或可访问的镜像地址时，可使用 `docker compose -f docker/compose.yaml build --build-arg NODE_IMAGE=<镜像引用>`；私有凭证始终通过运行时挂载提供，不作为构建参数。


## 真实服务启动

```sh
npm ci
npm run build
node tools/install-backends.mjs
# 首次创建 private 时复制；已有配置时跳过此步。
cp -R examples/live private
mkdir -p private/credentials
# 编辑 private/config.yaml 和 private/targets/*.yaml。
# kubeconfig、证书按目标文件中的引用放入 private/credentials/。
npm start -- --check-config --config private/config.yaml
npm start -- --config private/config.yaml
```

安装脚本依据 [backends.lock.json](../tools/backends.lock.json) 的固定发布资产和 SHA-256 下载 K8s/GitHub 二进制到 `.clueops/bin/`，DBHub 通过独立 lockfile 安装到 `tools/dbhub/node_modules/`；Redis官方MCP通过哈希锁定依赖安装至 `.clueops/redis-venv/`，宿主需Python3.11+及venv/pip。内置插件默认使用这些路径，不需要填写 backend；自定义部署才覆盖 `backend.command/args`。请求处理不执行 npx、pip、下载或升级。`--check-config` 校验配置、模块、连接文件和授权组合，不连接集群、数据库、Redis或 Lark；成功不代表远端可达。

`SIGINT` / `SIGTERM` 停止接收并取消活动轮次，释放引擎及本轮后端，最后关闭状态文件锁。退出时输出汇总指标；清理无法确认时返回非零退出码。状态目录必须是支持 hard link、不覆盖发布、原子 rename、目录 fsync 和本机文件锁的同一持久文件系统；启动会探测，不支持时拒绝运行。首版一个状态目录只允许一个服务实例，不支持多副本共用网络盘。

配置及凭证均来自明确的配置文件，不继承个人 kubeconfig、数据库 DSN、GitHub 环境变量或 Codex 配置。默认插件状态放在 `runtime.stateDirectory/plugins/<实例>/`；停机后备份整个状态目录，若显式覆盖引擎 stateDirectory 则一并备份。运行目录与状态目录只对服务账号开放。回退时使用对应源码、lockfile和二进制摘要重新构建；范围指纹不兼容会拒绝续接，需新建事件。旧的 plugins/module/configFile 组合入口已替换，使用旧格式会明确失败；保留旧状态备份，按新模板组织配置，不自动重绑旧事件。不要删除活动状态目录来解除锁。

## 历史清理

`runtime.retentionDays` 默认 `7`，设为 `0` 关闭自动过期。服务启动后和每小时检查一次，按整条调查的最后活动时间判断；只有所有轮次已结束、所有投递已确认，且当前没有执行或收尾任务的调查才会清理。排队、运行、中断以及投递未确认或失败的调查继续保留。

清理涵盖受理记录、报告、证据、投递计划、REST 邮箱及引擎会话工作目录。Codex 共享登录态模式通过原生 `codex delete <UUID> --force` 删除会话；API Key 模式的隔离会话目录整体移除。认证文件和共享刷新缓存保留。插件清理失败会在后续检查或重启时重试，清理中途退出不会把过期任务恢复成待执行状态。

过期调查不再支持查询、续接或投递重试，消息去重记录也一并移除。该规则是按时间保留历史，不是磁盘容量上限；未结束或未确认投递的数据仍会占空间。退出指标中的 `prunedInvestigations` 统计本次进程完成清理的调查数。升级到包含该功能的镜像后生效。
