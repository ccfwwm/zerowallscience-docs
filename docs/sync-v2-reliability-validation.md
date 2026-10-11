# Sync V2 reliability validation / 同步可靠性验证

日期：2026-10-11。基准 `d95d3787`；开发分支 `codex/sync-v2-reliability`。所有笔记正文均为临时测试数据。

## Phase 0

审计交付：`docs/sync-v2-reliability-audit.md`，commit `bd26fabe`。已核查 Issue #829 和合并后的 PR #821。架构图、平台读写路径、实体矩阵、问题清单和缺口见审计文件。

## Phase 1：数据一致性修复

| 已复现问题 | 修复与执行链路 |
| --- | --- |
| 远端永久删除丢掉本机离线正文 | `mobileSyncEngine.ts`：删除也经过 pending/冲突保护；正文、mutation 与远端删除标记同时保留 |
| 旧离线更新复活已永久删除的服务器笔记 | `apply.ts`/`sync-v2.ts`：带已有基线的更新不再当创建；返回可恢复删除冲突；恢复须另存新身份 |
| 本机同时保存标题/正文丢掉先前修改 | `nativeLocalRepository.ts`：读取当前笔记/权限/版本、更新业务和插入 Outbox 同个串行事务 |
| 无效 ACK 显示云端已确认 | `mobileNoteSyncReceipt.ts`：必须有有效正整数版本；`mobileSyncEngine.ts` 在出队前验证当前批次和版本，非法 ACK 保留队列 |
| 在途切账号后 JSON 解码继续接受旧 ACK | `mobileSyncEngine.ts`：传输取消、重试发送前校验 AbortSignal，JSON 解码后再检查会话；旧会话不宣告状态变化 |
| ACK 等待期间继续编辑导致自身冲突 | ACK 事务校准后续 baseVersion；批次内同笔记按服务端应用顺序接续版本；自身回声只认精确 mutation ACK 且读取最新 pending payload |
| 未记录本地 ACK 时崩溃，重启 Snapshot 误判已创建实体为冲突 | 持久化 mutationId 先重放 Push，再做首次/恢复 Snapshot；duplicate 结果与原队列出队同事务落盘 |
| 解决冲突后版本基线分叉 | keep-local 以远端版本生成新修订；冲突查询限定 Profile；未解决冲突阻止同实体的新队列静默上传 |
| Desktop 合并离线创建和编辑后携带错误已有版本 | `push.ts`：保持最早的缺失 baseVersion，创建不会因后续编辑变成更新 |

未使用清库/删除全部 Outbox/覆盖真实用户笔记；没有 schema 迁移或新增依赖。冲突台账保留双方。拒绝旧身份更新会让过去悄悄“重新创建”的客户端产生明确冲突；这是预期保护。永久删除后的保留本地须另存为新笔记，不能复用旧 ID。

自动化结果：

- `sync-v2-mobile-multidevice.test.ts`：12/12。独立磁盘上的三客户端 SQLite + 独立服务器 SQLite，真实 HTTP/Hono Sync V2 路由；覆盖 Markdown/富文本、双向和三端收敛、并发、close/reopen、丢失 ACK、重复 mutationId、Apply/Outbox 失败、永久删除、自身回声、非法收据。
- 后端组合 `sync-v2-protocol.test.ts`、`sync-v2-engine.test.ts`、`sync-v2-mobile-multidevice.test.ts`、`encrypted-notes-sync.test.ts`：84/84。
- 前端目标组合 `mobileSyncEndpoint`、`mobileNativeReceiptIntegration`、`mobileSyncUnknownEntity`、`mobileSyncUnexpectedFailure`、`mobileNoteSyncReceipt`、`nativeLocalNoteList`：35/35；另一次含目录密码与 #829 既有 fallback 的组合：70/70。
- `node scripts/data-consistency-contract.mjs --verify`：12 条契约、56 个用例引用；新增 DCC-012 已进入既有门禁。
- 前端 `npm run build`：通过。此后源码变更仍须最终再构建；不能用该中间构建证明最终 APK。

测试执行方式：Windows 的 `better-sqlite3` 是 Electron ABI，必须使用 `ELECTRON_RUN_AS_NODE=1` 的项目 Electron，参数为 `--import ./backend/node_modules/tsx/dist/loader.mjs --import ./backend/tests/setup-db-isolation.ts --test <目标文件>`。PowerShell 对 GUI exe 应使用 `Start-Process -WindowStyle Hidden -Wait -PassThru` 并检查 `ExitCode`。直接 Node 因 ABI 不符没有运行成功；未加载隔离 setup 的加密套件最初失败，补正确 setup 后已通过。新增测试最初确实出现删除丢正文、错误 confirmed、复活旧笔记、并行回写丢标题和延迟 ACK 假冲突的失败。

## 未验收与下一步

- #829 基准已有“本地缺失 → 服务端授权 → 远端完整读取”fallback；本次没有新复现日志。该 fallback 仍不等于刚创建的服务端树笔记已经持久化到 Native，不能宣称离线完整解决。
- Android 原生闪退：已读取连接设备 PJZ110 crash buffer，没有获得本次 Sync V2 的明确崩溃堆栈；原生列表预览限长与 Kotlin Filesystem 修复在基准里。新增源码验证不能替代新包设备验收。
- Phase 2：Native `sync.changed` → Pull、重连/周期补偿、Apply 后 UI 刷新、知识树、附件与冲突面板专项覆盖。
- Phase 3：最终构建/lint、Android 隔离包运行、故障恢复设备场景、Docker/NAS、迁移/备份恢复及延迟实测。iOS/HarmonyOS/其他桌面系统仍需独立平台证据。
- 尚无 P50/P95/P99；P95≤3s/P99≤10s 只是目标。
