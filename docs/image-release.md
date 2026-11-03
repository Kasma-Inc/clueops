# 镜像发布

[返回项目首页](../README.md) · [部署与运行](deployment.md)

推送 Git tag 后，[镜像发布工作流](../.github/workflows/image-release.yml)先调用现有 CI，验证该 tag 对应的提交。检查全部通过后，构建并推送 `linux/amd64`、`linux/arm64` 多架构镜像。

## Registry 配置

在 GitHub 仓库的 **Settings → Secrets and variables → Actions** 中配置以下项目。现有配置可以直接复用。

| 名称 | 类型 | 内容示例 |
| --- | --- | --- |
| `DOCKER_REGISTRY` | Variable | `registry.example.com`，仅主机名及可选端口，不带 `https://` 或路径 |
| `DOCKER_NAMESPACE` | Variable | `kasma-inc`，仓库命名空间，不带首尾斜线 |
| `DOCKER_REPO` | Variable | `clueops`，镜像仓库名 |
| `DOCKER_USERNAME` | Secret | 有目标仓库推送权限的用户名 |
| `DOCKER_PASSWORD` | Secret | 对应密码或访问令牌 |

镜像地址为：

```text
DOCKER_REGISTRY/DOCKER_NAMESPACE/DOCKER_REPO:<Git tag>
```

用户名和密码只用于工作流的 Registry 登录，不作为 Docker 构建参数或镜像内容。构建上下文仍由 [Dockerfile.dockerignore](../docker/Dockerfile.dockerignore)限制，私有配置和调查状态不进入镜像。

## 发布一个版本

先提交并推送要发布的代码，再为明确的提交创建 tag：

```sh
git tag -a v0.1.0 -m "Release v0.1.0"
git push origin v0.1.0
```

工作流监听所有 tag 推送；Git tag 必须同时符合 Docker tag 格式：首字符为字母、数字或下划线，后续可含字母、数字、下划线、点和连字符，总长度最多 128 字符。推荐 `v0.1.0`、`v0.2.0-rc.1`；含斜线或加号的 tag 会在登录 Registry 前被拒绝。

镜像保留 Git tag 原名，例如 `v0.1.0` 对应：

```sh
docker pull registry.example.com/kasma-inc/clueops:v0.1.0
```

工作流不会额外生成 `latest`、主版本或次版本别名。预发布 tag 使用自己的独立镜像 tag。

## 查看结果与部署

在仓库的 [Actions → Image release](https://github.com/Kasma-Inc/clueops/actions/workflows/image-release.yml) 查看验证、构建和推送结果。构建使用现有 [Dockerfile](../docker/Dockerfile)，包含固定版本的 Codex、MCP 后端及 DBHub；Docker 构建缓存由 GitHub Actions 保存。

拉取镜像后，按[使用发布镜像](deployment.md#使用发布镜像)提供私有配置和可写状态目录。镜像发布与实际环境部署分开执行；工作流不会连接业务集群、数据库或 Lark，也不会自动更新正在运行的服务。
