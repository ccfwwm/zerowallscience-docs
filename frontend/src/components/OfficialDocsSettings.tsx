import { useEffect, useState } from "react";
import { api } from "@/lib/api";

export default function OfficialDocsSettings() {
  const [notebooks, setNotebooks] = useState<{ id: string; name: string; workspaceName: string | null; allowComment: number }[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSiteSettings(), api.getOfficialDocsCandidates()])
      .then(([settings, rows]) => {
        if (cancelled) return;
        setSelected(settings.site_docs_notebook_id || "");
        setNotebooks(rows);
      })
      .catch((error) => { if (!cancelled) setMessage(error.message); })
      .finally(() => { if (!cancelled) setBusy(false); });
    return () => { cancelled = true; };
  }, []);

  async function save() {
    setBusy(true);
    try {
      await api.updateSiteSettings({ site_docs_notebook_id: selected });
      setMessage("官方文档目录已更新，访客刷新即可看到。");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "保存失败");
    } finally { setBusy(false); }
  }

  return (
    <section className="space-y-5">
      <h2 className="text-lg font-semibold">文档发布设置</h2>
      <p className="text-sm text-tx-secondary">正式目录保存即公开。草稿请保存在独立的“草稿（不公开）”目录。</p>
      <label className="block space-y-2">
        <span>官方文档目录</span>
        <select className="w-full rounded-lg border border-app-border bg-app-bg p-3" value={selected} onChange={(event) => setSelected(event.target.value)} disabled={busy}>
          <option value="">请选择已公开的只读目录</option>
          {notebooks.map((row) => <option key={row.id} value={row.id}>{row.workspaceName || "个人空间"} / {row.name}{row.allowComment ? "（绑定时关闭评论）" : ""}</option>)}
        </select>
      </label>
      <p className="text-sm text-tx-secondary">可选择你有管理权限的个人或团队目录。请先在目录发布设置中选择“公开”和“只读”；仅链接可见、已过期或已撤销的发布不会列出。保存绑定时会关闭所选目录的评论，保持官方文档只读。</p>
      <button className="rounded-lg bg-accent-primary px-4 py-2 text-white disabled:opacity-50" disabled={busy || !notebooks.some((row) => row.id === selected)} onClick={() => void save()}>保存文档设置</button>
      <a className="ml-4 text-accent-primary" href="/docs/" target="_blank" rel="noreferrer">查看公开文档</a>
      {message && <p role="status" className="text-sm">{message}</p>}
    </section>
  );
}
