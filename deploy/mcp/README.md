# 正式文档远程 MCP

复用 `packages/nowen-mcp` 的无状态 Streamable HTTP 网关，通过
`https://zerowallscience.org/mpcdocs` 供本地 MCP 客户端连接。只读权限限定为正式文档根目录及子目录；不是匿名公开文章接口，授权范围内未公开的笔记也可读取。

## 首次配置

1. 在文档后台的「设置 → 访问令牌」创建独立 PAT：选择 `notes:read`、`notebooks:read`，资源模式为 `restricted`，仅授权当前正式文档根目录 `read` 并包含子目录。
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

部分客户端还需选择 `http` / `streamable-http`，以客户端配置格式为准。地址不是网页；无 Key 返回 401，带有效 Key 的 GET 返回 405 属正常行为。支持 `initialize`、`tools/list` 和 `tools/call`，不支持 SSE 会话恢复或主动推送。只读服务仍会列出写入工具，但调用会被权限策略拒绝。

验收需使用真实 MCP SDK 客户端连接并调用 `nowen_list_notebooks`、`nowen_list_notes`、`nowen_read_note`；同时检查无 Key/错误 Key 为 401、不可信 Origin 为 403、范围外读取和写入被拒绝。不要将正文或密钥写入验收日志。

轮换客户端 Key：修改服务器 `.env` 的 `NOWEN_MCP_HTTP_TOKEN` 并重新创建 MCP 容器，更新本地配置。吊销后台专用 PAT 会立即阻断其后端数据访问。
