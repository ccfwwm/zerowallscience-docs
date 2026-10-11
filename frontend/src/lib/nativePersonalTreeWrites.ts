import type { KnowledgeTreeNode } from "./knowledgeTreeApi";
import type { NativeDatabase } from "./nativeDatabase";
import { applyNativePersonalTree, NATIVE_TREE_ENTITY_SET, nativeTreeSubscriptionKey } from "./nativeKnowledgeTreeSync";
import { newLocalId } from "./localRepository";

export interface NativeTreeMove { id: string; parentId?: string | null; sortOrder?: number }
export interface NativeTreeWriteContext { profileId: string; deviceId: string; userId: string }

export async function readNativePersonalTreeNode(db: NativeDatabase, id: string): Promise<Record<string, unknown> | null> {
  return (await db.query<Record<string, unknown>>(`SELECT id,userId,workspaceId,parentId,nodeType,resourceType,
    resourceId,sortOrder,isDeleted,deletedAt,createdAt,updatedAt FROM native_knowledge_tree_nodes
    WHERE scopeKey='personal' AND id=?`, [id]))[0] || null;
}

export function sameNativeTreePosition(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  return a.parentId === b.parentId && a.sortOrder === b.sortOrder && a.isDeleted === b.isDeleted;
}

export function nativeTreeMutationPayload(desired: Record<string, unknown>, base: Record<string, unknown>): Record<string, unknown> {
  return { ...desired, baseParentId: base.parentId, baseSortOrder: base.sortOrder, baseIsDeleted: base.isDeleted };
}

/** Only explicit local intentions override navigation; synced rows carry no ACL proof. */
export async function listNativePersonalTreeOverrides(db: NativeDatabase, profileId: string): Promise<Array<Record<string, unknown>>> {
  return db.query(`SELECT t.* FROM native_knowledge_tree_nodes t WHERE t.scopeKey='personal' AND (
    EXISTS (SELECT 1 FROM sync_outbox o WHERE o.profileId=? AND o.scopeKey='personal'
      AND o.entityType='knowledge_tree_node' AND o.entityId=t.id)
    OR EXISTS (SELECT 1 FROM sync_conflicts c WHERE c.profileId=? AND c.scopeKey='personal'
      AND c.entityType='knowledge_tree_node' AND c.entityId=t.id AND c.status='unresolved'))`, [profileId,profileId]);
}

function unavailable(): never {
  throw Object.assign(new Error("个人目录订阅、权限或密码信息尚未确认，请使用在线操作"), { code: "NATIVE_TREE_WRITE_UNAVAILABLE" });
}

export async function syncNativeNotebookMoveParents(tx: NativeDatabase, ids: string[]): Promise<void> {
  for (const id of ids) {
    const node = await readNativePersonalTreeNode(tx,id);
    if (!node || node.resourceType !== "notebook") continue;
    let parentId = node.parentId as string | null, container: string | null = null;
    while (parentId) {
      const parent = await readNativePersonalTreeNode(tx,parentId);
      if (!parent) throw new Error("知识树父节点缺失");
      if (parent.resourceType === "notebook") { container = String(parent.resourceId); break; }
      if (!parent.parentId && parent.resourceType === "note") {
        container = (await tx.query<{notebookId:string}>("SELECT notebookId FROM notes WHERE scopeKey='personal' AND id=?",[parent.resourceId]))[0]?.notebookId || null;
      }
      parentId = parent.parentId as string | null;
    }
    await tx.run("UPDATE notebooks SET parentId=?,sortOrder=? WHERE scopeKey='personal' AND id=?",[container,node.sortOrder,node.resourceId]);
  }
}

/** Caller owns the transaction. Cached owner ACL and complete unprotected ancestry are required. */
export async function writeNativePersonalTreeMoves(
  tx: NativeDatabase, items: NativeTreeMove[], context: NativeTreeWriteContext,
): Promise<KnowledgeTreeNode[]> {
  const binding = (await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key=?", [nativeTreeSubscriptionKey(context.profileId)]))[0];
  if (binding?.value !== NATIVE_TREE_ENTITY_SET) unavailable();
  const cached = (await tx.query<{value:string}>("SELECT value FROM native_runtime_meta WHERE key='knowledgeTreeSnapshot:v1:personal:0'"))[0];
  let nodes: KnowledgeTreeNode[];
  try {
    const parsed: unknown = JSON.parse(cached?.value || "null");
    if (!Array.isArray(parsed)) unavailable();
    nodes = parsed;
  } catch { unavailable(); }
  const overrides = await listNativePersonalTreeOverrides(tx, context.profileId);
  nodes = nodes.map((node) => {
    const override = overrides.find((row) => row.id === node.id);
    return override ? { ...node, parentId: override.parentId as string | null, sortOrder: override.sortOrder as number } : node;
  });
  const byId = new Map(nodes.map((node) => [node.id,node]));
  const assertAncestry = (id: string): KnowledgeTreeNode => {
    const first = byId.get(id); let node = first;
    const visited = new Set<string>();
    while (node) {
      if (visited.has(node.id) || node.userId !== context.userId || node.workspaceId !== null
        || node.isDeleted || node.access?.source !== "owner" || !node.access.capabilities.canView
        || (node.resourceType === "notebook" && node.isPasswordProtected !== 0)) unavailable();
      visited.add(node.id);
      if (!node.parentId) return first!;
      node = byId.get(node.parentId);
    }
    unavailable();
  };
  const entries = [], result: KnowledgeTreeNode[] = [], seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id)) throw new Error("移动批次包含重复节点");
    seen.add(item.id);
    const proof = assertAncestry(item.id);
    // Document/mindmap/file writes also couple to body/attachment mutations.
    // Keep their existing online path until those separate queues are covered.
    if (proof.resourceType !== "notebook") unavailable();
    if (!proof.access.capabilities.canMove) unavailable();
    const current = await readNativePersonalTreeNode(tx,item.id);
    if (!current || current.userId !== context.userId || current.isDeleted) unavailable();
    // A structure Pull newer than the ACL snapshot must not inherit an old
    // unprotected path. Local pending overrides were incorporated above.
    if (current.parentId !== proof.parentId) unavailable();
    const parentId = item.parentId === undefined ? current.parentId : item.parentId;
    if (parentId) {
      const parent = assertAncestry(String(parentId));
      const stored = await readNativePersonalTreeNode(tx,parent.id);
      if (!stored || stored.isDeleted || stored.parentId !== parent.parentId
        || (!parent.access.capabilities.canCreate && !parent.access.capabilities.canMove)) unavailable();
    }
    const desired = { ...current, parentId, sortOrder: item.sortOrder ?? current.sortOrder, updatedAt: new Date().toISOString() };
    if (sameNativeTreePosition(current,desired)) { result.push(proof); continue; }
    const payload = nativeTreeMutationPayload(desired,current);
    entries.push({ entityId:item.id, payload:desired });
    await tx.run(`INSERT INTO sync_outbox (id,mutationId,profileId,deviceId,scopeKey,entityType,entityId,
      operation,payload,status,retryCount,createdAt) VALUES (?,?,?,?,'personal','knowledge_tree_node',?,'upsert',?,'pending',0,?)`,
    [newLocalId(),newLocalId(),context.profileId,context.deviceId,item.id,JSON.stringify(payload),desired.updatedAt]);
    result.push({ ...proof, parentId: parentId as string | null, sortOrder: desired.sortOrder as number, updatedAt: desired.updatedAt });
  }
  await applyNativePersonalTree(tx,entries,context.userId,false);
  await syncNativeNotebookMoveParents(tx,items.map((item) => item.id));
  return result;
}
