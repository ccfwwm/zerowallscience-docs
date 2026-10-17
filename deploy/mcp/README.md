# 正式文档远程 MCP

复用 `packages/nowen-mcp` 的无状态 Streamable HTTP 网关，通过
`https://zerowallscience.org/mpcdocs` 供本地 MCP 客户端连接。权限由 Nowen Note 用户 ACL、Personal API Token scopes 和 MCP 网关开关共同决定；不是匿名公开文章接口。

## 首次配置

1. 在文档后台的「设置 → 访问令牌」创建独立 PAT。生产全权限实例需要启用全部可用 scopes，资源模式设为 `unrestricted`；更安全的实例应改用 `restricted`，只授权指定笔记本及读写级别。
2. 在服务器 `/opt/zerowallscience-docs/mcp/` 放置本目录的 `docker-compose.yml`，复制 `.env.example` 为 `.env`（权限 `600`），填写 PAT 和实际根目录 ID。
3. 用 `openssl rand -hex 32` 生成独立的 `NOWEN_MCP_HTTP_TOKEN`。此值是交付客户端的 Key；不要交付后端 PAT，也不要将任何密钥提交到 Git。

## 构建和发布

在仓库根目录构建，镜像只包含 MCP 包，不重新构建或重启文档后台：

```bash
sha=$(git rev-parse HEAD)
docker build -f deploy/mcp/Dockerfile -t zerowallscience-docs-mcp:$sha .
docker save zerowallscience-docs-mcp:$sha | gzip -1 > mcp-image.tar.gz
scp mcp-image.tar.gz uscavaslinux:/opt/zerowallscience-docs/mcp/
```

服务器加载镜像后启动（将 `<sha>` 替换为上述完整提交）：

```bash
cd /opt/zerowallscience-docs/mcp
gzip -dc mcp-image.tar.gz | docker load
MCP_DEPLOY_SHA=<sha> docker compose up -d
curl -fsS http://127.0.0.1:3133/health
```

备份现有 Nginx 配置后，安装仓库的 `deploy/nginx/zerowallscience-web.https.conf`，执行 `nginx -t && systemctl reload nginx`。`/mpcdocs` 精确代理到网关的 `/mcp`，转发 `Host: 127.0.0.1` 以满足网关 Host 校验。无需新增公网端口。

容器自动重启。普通官网/后台部署保留此代理配置；MCP 版本独立更新。更新前保留旧镜像及受限配置备份，失败时用旧 SHA 再次 `docker compose up -d`，恢复原 Nginx 配置并验证后 reload；不需要恢复笔记数据库。

## 客户端接入

在支持 Streamable HTTP 与自定义请求头的客户端中填写：

```json
{
  "mcpServers": {
    "zerowall-docs": {
      "url": "https://zerowallscience.org/mpcdocs",
      "headers": { "Authorization": "Bearer <网关 Key>" }
    }
  }
}
```

部分客户端还需选择 `http` / `streamable-http`，以客户端配置格式为准。地址不是网页；无 Key 返回 401，带有效 Key 的 GET 返回 405 属正常行为。支持 `initialize`、`tools/list` 和 `tools/call`，不支持 SSE 会话恢复或主动推送。

### 开启远程写入

HTTP 网关默认拒绝写入。确认客户端和 Token 均已授权后，`.env` 必须同时设置：

```dotenv
MCP_ACCESS_MODE=read-write
NOWEN_MCP_HTTP_ALLOW_WRITE=true
MCP_ENABLE_DANGEROUS_TOOLS=true
```

还需要移除 `ALLOWED_NOTEBOOK_IDS`（表示不启用 MCP 本地笔记本白名单），并为 PAT 配置 `unrestricted` 资源模式和全部需要的 scopes。用户 ACL 仍然是最终边界；MCP 的笔记删除工具只允许移入可恢复的回收站，永久删除仍需在 Nowen Note 中手动执行。

验收需使用真实 MCP SDK 客户端连接并调用 `nowen_list_notebooks`、`nowen_list_notes`、`nowen_read_note`；全权限实例还应使用临时对象验证创建、更新和移入回收站，再清理测试数据。同时检查无 Key/错误 Key 为 401、不可信 Origin 为 403。不要将正文或密钥写入验收日志。

轮换客户端 Key：修改服务器 `.env` 的 `NOWEN_MCP_HTTP_TOKEN` 并重新创建 MCP 容器，更新本地配置。吊销后台专用 PAT 会立即阻断其后端数据访问。
