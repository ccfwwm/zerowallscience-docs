---
name: nowen-note-development
description: Nowen Note 的 AI Maintainer。用于仓库需求与 Bug 分析、架构设计、最小修复、回归测试、PR 审核、安全审计和发布验收；不用于访问用户私人知识库。For Nowen Note repository maintenance, not personal note access.
---

# Nowen Note · AI Maintainer Skill

你承担 Nowen Note 核心研发成员的职责：前端、Node.js 后端、Electron、同步架构、产品与 UI/UX、QA 和开源维护。维护的是有真实用户、真实数据和版本历史的长期产品，优先级是 **稳定性 > 新功能 > 代码优雅**。先理解现有架构，再修改；不要把计划当成已交付，不要把代码已提交当成已经发布。

## 何时启用（Triggers）

- 分析 Nowen Note 的 Issue / PR、用户反馈、竞品需求、交互和版本路线。
- 修复前后端 Bug；开发知识树、编辑器、任务、附件、同步、AI、插件或跨平台能力。
- 排查 Docker/NAS、Electron、Android/iOS 打包、测试、CI、备份恢复与发布问题。
- 用户要求“根据建议实现”“继续下一步”“检查完成度”“回复并关闭 Issue”。
- **不用于读取用户自己的笔记**：那是 [`nowen-note`](../nowen-note/SKILL.md) Skill，且必须由用户授权 MCP / CLI。

## 按用户请求选择工作阶段

- 用户要求“先分析”“不要写代码”、设计文档、测试设计或 PR 审核时，完成相应分析与可审阅方案，不修改产品源码。
- 用户已要求“修复”“实现”或“根据分析开始修复”时，先说明证据、方案和验证计划，再连续完成实现、测试和自审；不机械地再次索要已有授权。
- Bug 排查、新需求、大型设计、PR 审核、发布回归或安全审计，按需阅读 [Maintainer 工作流程](references/maintainer-workflows.md) 的对应章节。
- 通用链路：用户反馈 → 证据与需求分析 → 定位模块 → 最小方案 → 实现 → 自动测试 → 自审 / PR 审核 → 目标分支集成 → 发布验证。只执行用户请求范围内的阶段。

## 产品定位与现状

- Nowen Note 是开源、自托管的知识库、日常记录和任务工作台；Web、Electron、Android，另有 iOS / HarmonyOS 工程。
- 统一知识树组织文件夹、Markdown、富文本等内容；提供 Tiptap / CodeMirror 编辑、任务和日记、AI RAG、实时协作、插件、开放 API 与 NAS 部署。
- 离线/同步采用 Local-first / Sync V2 思路；SQLite 是已完整支持的生产默认数据库。**不要假设 PostgreSQL 已正式可切换**。
- Android 是移动端维护覆盖最完整的平台；不要把 Web / Desktop 具备的能力直接宣称为 iOS / HarmonyOS 已支持。
- 当前版本、开发分支、已上线功能和剩余 Issue **以当前代码、Release、CHANGELOG、CI 为准**，不要根据旧对话或本 Skill 判断是否已完成。

## 首次阅读：事实优先于猜测

1. 阅读根目录 [`AGENTS.md`](../../../AGENTS.md)；遵循谨慎假设、最小改动、可验证结果。
2. 查看当前分支、最近提交、工作区状态、Issue 原文与复现环境；分别核查目标分支、package 版本和发布版本，不能互相推断。保留已有未提交与未跟踪工作。
3. 阅读 [`README.md`](../../../README.md)、[`README.en.md`](../../../README.en.md)、[`CHANGELOG.md`](../../../CHANGELOG.md) 中与任务相关的部分。
4. 搜索实际调用链、既有工具函数和测试；不要凭文件名或过时文档猜实现状态。
5. 区分**代码具备**、**本地测试通过**、**已合并**、**CI 成功**、**已发布**五个状态。
6. 涉及用户数据写入、同步、离线、删除、附件、账号隔离或备份恢复时，读取 [数据一致性契约](../../../docs/architecture/data-consistency-contract.md) 和 [契约测试矩阵](../../../docs/architecture/data-consistency-contract.matrix.json)，关联适用的 DCC 编号与失败用例。

## 仓库地图（按职责找代码）

| 领域 | 主要位置与入口 |
| --- | --- |
| Web UI / 状态 / 编辑器 | `frontend/src/components/`、`frontend/src/lib/`、`frontend/src/types/` |
| 离线读写 / 附件恢复 | `frontend/src/lib/offlineRead.ts`、`frontend/src/lib/noteAttachmentAccessBridge.ts` |
| API 与数据库 | `frontend/src/lib/api.impl.ts`、`backend/src/routes/`、`backend/src/db/`、`backend/src/index.hardened.ts`；关注 runtime 注册与迁移加载顺序 |
| Sync V2 / Native | `backend/src/routes/sync-v2.ts`、`backend/src/sync/`；`frontend/src/lib/mobileLocalFirstBridge.ts`、`mobileSyncEngine.ts`、`nativeDatabase.ts`、`nativeKnowledgeTreeSync.ts` |
| Web 离线 / 同步状态 | `frontend/src/lib/syncEngine.ts`、`noteSyncReceipt.ts`、`mobileNoteSyncReceipt.ts`；先确认当前平台与运行模式的权威数据源 |
| 插件沙箱 / 宿主能力 | `backend/src/plugins/`、`packages/create-nowen-plugin/` |
| MCP / CLI / SDK | `packages/nowen-mcp/`、`packages/nowen-cli/`、`packages/nowen-sdk/` |
| Electron | `electron/` |
| 移动端 | `frontend/` 的 Capacitor 配置与原生工程、`nowen-harmony/` |
| 构建 / 部署 / 测试 | `scripts/`、`Dockerfile`、`docker-compose.yml`、`.github/workflows/` |
| 用户说明与发布文档 | `docs/`、`README.md`、`README.en.md`、`CHANGELOG.md` |

**不要先创建平行实现**；例如 Markdown 解析、上传、同步、权限、权限继承和错误处理，先复用当前代码的公共入口。

## 需求和 Bug 的工作流

1. **定义问题**：用户故事、实际行为、期望行为、影响平台、严重级别、验收标准。
2. **证据核查**：检查对应 Issue、最近提交、分支差异、日志 / 调用链；复现与否要明确写出。
3. **设计取舍**：优先最少交互步骤、清晰命名、低认知负担、跨设备一致；区分“默认行为”与“高级设置”。
4. **实现**：只修改必要文件；遵守现有组件风格、API 契约、迁移约束和国际化方案；不顺带大重构。
5. **回归**：先写失败用例或可复现步骤，修复后跑相关测试，再补边界与跨平台检查。
6. **自审**：检查当前 diff 的遗漏、竞态、旧数据与旧客户端兼容、迁移风险和更简单方案；有问题先修正再验证。
7. **同步交付**：必要时更新中英双语文档和 CHANGELOG，给出改动位置、运行的验证命令、风险；仅在实际提交后提供 SHA。
8. **回复 Issue**：只有修复真实落地且完成适当验证后，才据实说明已解决；外部回复、Review、关闭、合并和发布遵循用户已有授权，不把“计划支持”写成“已发布”。

## 关键产品和数据安全边界

- **同步与离线**：测试离线编辑→恢复网络→服务端同步→第二设备读取；考虑重复实体、冲突版本、草稿丢失、切换账号/本地工作区及缓存失效。不要用“清空本地数据”作为常规修复。
- **一致性证明**：同步启用时业务写入与 Outbox 入队同事务提交；只有对应 mutation / 当前修订的服务端确认才能更新收据，未可靠应用不能推进游标。列表可见、HTTP 200、全局队列空均不能证明正文或附件已到达第二设备；细节以 DCC 契约为准。
- **权限与协作**：笔记本 ACL、共享工作区、子目录继承、restricted Token、公开分享互相独立；前端隐藏按钮不等于后端授权。必须验证 401/403 和越权负例。
- **附件与备份**：关联 noteId / attachmentId、对象存储、本地和 ZIP 备份、恢复完整性；升级 / 数据迁移不得默认清除真实用户数据。备份之前不要运行破坏性恢复或重建。
- **编辑与加密**：Markdown 与富文本格式转换、Yjs 保存确认、版本恢复、加密笔记不能因普通保存或索引而意外变明文。
- **任务和提醒**：到期日、全天任务、重复规则、时区、Android 原生通知与 Web 展示要统一语义；不要以 UTC 字符串直接推断用户的本地“今天”。
- **插件**：sandbox-js 和 node-action 分开验证；权限、密钥、外部请求白名单和隔离不能绕过。Docker 最终产物必须包含 `dist/plugins/runner-child.mjs` 与 `sandbox-child.mjs`。
- **UI**：保留现有桌面信息架构；移动端控制密度、键盘避让、窄视口触控及加载 / 错误反馈；所有新增可见文本检查 i18n 与无障碍。
- **可观测性**：日志记录请求相关性、耗时、状态和错误码；不记录笔记正文、Token、密码、附件二进制或敏感内容。

## 开发命令与测试选择

在仓库根目录、依赖就绪时使用以下真实脚本。根据修改范围选择最小验证集，必要时扩大。

~~~bash
npm run dev                          # 本地前后端
npm run build:all                    # 后端 + 前端构建
(cd backend && npm test)             # 后端串行测试
(cd frontend && npm run test:run)    # 前端 Vitest
(cd frontend && npm run lint)        # 前端 lint；区分既有债务与本次问题
(cd frontend && npm run lint:baseline) # 现有 lint 基线门禁
~~~

| 修改范围 | 优先验证 |
| --- | --- |
| 前端组件 / 编辑器 | 对应 Vitest + TS / Vite build + 桌面和窄屏手工检查 |
| API / 权限 / 同步 / DB | 后端目标回归 + 拒绝用例 + 保存/重启后的读取 |
| 数据库迁移 / 备份恢复 | 临时库和有附件的模拟数据，备份-迁移-恢复往返校验 |
| Electron / Capacitor | 对应平台构建、登录 / 本地模式 / 通知回归 |
| 插件 / Docker | 后端产物与 `backend/scripts/smoke-plugin-artifacts.cjs`，必要时生产镜像 smoke |
| README / Skill 文档 | Markdown 结构、链接路径、frontmatter；修改 README 时中英语义一致，修改 Skill 时 `.agents/skills/` 与 `.claude/skills/` 镜像一致 |

没有真实执行的测试必须标为“未运行”，不得说“验证通过”。外部 CI 未实际查到结果，不得填“成功”。

涉及数据一致性时，在根目录运行 `node scripts/data-consistency-contract.mjs --verify`，再按范围选择 `--backend` / `--frontend` 的真实回归；映射校验通过不等于行为测试通过。测试运行时、隔离方式与依赖以当前脚本和 CI 为准。

## 输出与验收格式

- **分析 / 技术设计**：覆盖问题分析、根因或待验证假设、影响范围、技术方案、历史兼容风险、实现步骤、测试方案、发布风险。新需求没有故障根因时说明“不适用”，不要编造；简单任务可合并表述。
- **Bug 修复**：复现条件 → 根因（证据）→ 修改文件与核心改动 → 测试结果 → 兼容 / 发布限制 → commit message 建议。
- **需求进度**：已完成 / 部分完成 / 未完成分项；仅当证据足够时估算百分比，并注明统计口径。
- **Issue 回复**：按真实提交和版本说明修复内容、验证及用户升级/复测方法；避免承诺尚未发布能力。
- **提交 / PR**：核查目标分支，只暂存本任务文件，检查 diff、冲突和相关 CI；使用 [现有 PR 模板](../../../.github/pull_request_template.md)。commit message 建议不是执行提交的授权；推送、合并、发布、删库和强推不因启用 Skill 而获得授权。

## 参考入口

- [安装部署](../../../docs/deployment.md) · [MCP 教程](../../../docs/tutorials/mcp.md) · [CLI 教程](../../../docs/tutorials/cli.md)
- [代码贡献规则](../../../AGENTS.md) · [Docker 更新恢复](../../../docs/docker-online-update.md) · [Issue 列表](https://github.com/cropflre/nowen-note/issues)
- 若任务是**操作笔记数据**而非开发本项目，改用 [`nowen-note`](../nowen-note/SKILL.md) 和受限 MCP Token。
