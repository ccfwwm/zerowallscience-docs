import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import { notebookPublicationApi } from "@/lib/notebookPublicationApi";

export default function OfficialDocsSettings() {
  const [notebooks, setNotebooks] = useState<{ id: string; name: string }[]>([]);
  const [selected, setSelected] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let cancelled = false;
    void Promise.all([api.getSiteSettings(), api.getNotebooks("personal")])
      .then(async ([settings, rows]) => {
        const eligible = await Promise.all(rows.map(async (row) => {
          const publication = await notebookPublicationApi.getPublication(row.id);
          return publication?.isActive && publication.accessMode === "public"
            && publication.permission === "read" && !publication.allowEdit && !publication.allowComment ? row : null;
        }));
        if (cancelled) return;
        setSelected(settings.site_docs_notebook_id || "");
        setNotebooks(eligible.filter((row): row is NonNullable<typeof row> => row !== null));
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
          {notebooks.map((row) => <option key={row.id} value={row.id}>{row.name}</option>)}
        </select>
      </label>
      <p className="text-sm text-tx-secondary">新目录需先在目录菜单的发布设置中启用公开、只读，并关闭评论和编辑，之后才能在这里绑定。</p>
      <button className="rounded-lg bg-accent-primary px-4 py-2 text-white disabled:opacity-50" disabled={busy || !selected} onClick={() => void save()}>保存文档设置</button>
      <a className="ml-4 text-accent-primary" href="/docs/" target="_blank" rel="noreferrer">查看公开文档</a>
      {message && <p role="status" className="text-sm">{message}</p>}
    </section>
  );
}
