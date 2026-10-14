import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { api } from "@/lib/api";
import { toast } from "@/lib/toast";
import { Button } from "@/components/ui/button";

export default function FileMoveDialog({ ids, currentFolderId, onClose, onMoved }: {
  ids: string[];
  currentFolderId?: string | null;
  onClose: () => void;
  onMoved: (folderId: string | null, folderName: string | null) => void;
}) {
  const { t } = useTranslation();
  const [folders, setFolders] = useState<Array<{ id: string; name: string }>>([]);
  const [target, setTarget] = useState(currentFolderId ?? "");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const dialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => { previous?.focus(); };
  }, []);

  useEffect(() => {
    let cancelled = false;
    api.attachmentFolders.list().then((res) => {
      if (!cancelled) setFolders(res.folders);
    }).catch((err: unknown) => {
      if (!cancelled) setError(err instanceof Error ? err.message : t("fileManager.moveFailed"));
    }).finally(() => {
      if (!cancelled) setLoading(false);
    });
    return () => { cancelled = true; };
  }, [t]);

  const move = async () => {
    setSaving(true);
    try {
      const res = await api.files.move(ids, target || null);
      toast.success(t("fileManager.moved", { count: res.moved }));
      onMoved(res.folderId, res.folderName);
      onClose();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : t("fileManager.moveFailed"));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[130] flex items-center justify-center px-4">
      <div className="absolute inset-0 bg-black/30" onClick={() => { if (!saving) onClose(); }} />
      <div ref={dialogRef} tabIndex={-1} role="dialog" aria-modal="true" aria-label={t("fileManager.moveFiles")} className="relative w-full max-w-sm rounded-xl border border-app-border bg-app-elevated p-4 shadow-xl outline-none" onKeyDown={(event) => {
        if (event.key === "Escape" && !saving) { event.stopPropagation(); onClose(); }
        if (event.key !== "Tab") return;
        const controls = dialogRef.current?.querySelectorAll<HTMLElement>("select:not(:disabled), button:not(:disabled)");
        const first = controls?.[0]; const last = controls?.[controls.length - 1];
        if (!first || !last) return;
        if (event.shiftKey && (document.activeElement === first || document.activeElement === dialogRef.current)) {
          event.preventDefault(); last.focus();
        } else if (!event.shiftKey && (document.activeElement === last || document.activeElement === dialogRef.current)) {
          event.preventDefault(); first.focus();
        }
      }}>
        <h2 className="text-sm font-semibold text-tx-primary">{t("fileManager.moveFiles")}</h2>
        <p className="mt-2 text-xs text-tx-secondary">{t("fileManager.moveHint", { count: ids.length })}</p>
        {error ? <p role="alert" className="mt-3 text-xs text-red-500">{error}</p> : (
          <label className="mt-4 block text-xs text-tx-secondary">
            {t("fileManager.targetFolder")}
            <select value={target} onChange={(e) => setTarget(e.target.value)} disabled={loading || saving} className="mt-1.5 w-full rounded-md border border-app-border bg-app-surface px-2 py-2 text-tx-primary">
              <option value="">{t("fileManager.unarchived")}</option>
              {folders.map((folder) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}
            </select>
          </label>
        )}
        <div className="mt-4 flex justify-end gap-2">
          <Button size="sm" variant="outline" disabled={saving} onClick={onClose}>{t("common.cancel")}</Button>
          <Button size="sm" disabled={loading || saving || !!error} onClick={move}>{t(saving ? "fileManager.moving" : "fileManager.moveFiles")}</Button>
        </div>
      </div>
    </div>
  );
}
