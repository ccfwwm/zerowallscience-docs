import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AlertCircle, Bot, Check, CheckCircle2, ChevronDown, Eye, EyeOff, Loader2, Plus, RefreshCw, Save, Trash2, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import { siteAIModels, type SiteAIModelOption, type SiteAIProfile, type SiteAIProfileDraft } from "@/lib/siteAIModels";
import { emitAIProfilesChanged } from "@/lib/aiProfiles";
import { PROVIDER_PRESETS } from "@/lib/aiProviderPresets";

const EMPTY_DRAFT: SiteAIProfileDraft = { name: "", provider: "openai", apiUrl: "https://api.openai.com/v1", apiKey: "", model: "gpt-4o-mini" };

function toDraft(profile: SiteAIProfile): SiteAIProfileDraft {
  return { name: profile.name, provider: profile.provider, apiUrl: profile.apiUrl, apiKey: profile.apiKey, model: profile.model };
}

export default function AIModelSettingsPanel() {
  const [profiles, setProfiles] = useState<SiteAIProfile[]>([]);
  const [defaultProfileId, setDefaultProfileId] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [draft, setDraft] = useState<SiteAIProfileDraft>(EMPTY_DRAFT);
  const [models, setModels] = useState<SiteAIModelOption[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [modelOpen, setModelOpen] = useState(false);
  const [message, setMessage] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [modelError, setModelError] = useState("");
  const discoverySeq = useRef(0);

  const preset = useMemo(() => PROVIDER_PRESETS.find((item) => item.id === draft.provider) || PROVIDER_PRESETS[PROVIDER_PRESETS.length - 1], [draft.provider]);
  const selectedProfile = profiles.find((profile) => profile.id === selectedId) || null;

  const load = useCallback(async (preferredId?: string) => {
    setLoading(true);
    try {
      const result = await siteAIModels.list();
      setProfiles(result.profiles);
      setDefaultProfileId(result.defaultProfileId);
      const target = result.profiles.find((profile) => profile.id === preferredId) || result.profiles.find((profile) => profile.id === result.defaultProfileId) || result.profiles[0];
      if (target) { setSelectedId(target.id); setDraft(toDraft(target)); }
      else { setSelectedId(null); setDraft({ ...EMPTY_DRAFT, name: "默认渠道" }); }
    } catch (error) {
      setMessage({ type: "error", text: (error as Error)?.message || "AI 模型配置加载失败" });
    } finally { setLoading(false); }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const discover = useCallback(async () => {
    const seq = ++discoverySeq.current;
    if (!draft.apiUrl.trim()) return;
    setDiscovering(true); setModelError("");
    try {
      const result = await siteAIModels.discoverModels(draft, selectedId || undefined);
      if (seq !== discoverySeq.current) return;
      setModels(result.models);
      if (!result.models.length) setModelError("接口没有返回可识别的模型，可手动填写模型名称。");
      else if (!draft.model) setDraft((current) => ({ ...current, model: result.models[0].id }));
    } catch (error) {
      if (seq === discoverySeq.current) { setModels([]); setModelError((error as Error)?.message || "获取模型失败"); }
    } finally { if (seq === discoverySeq.current) setDiscovering(false); }
  }, [draft, selectedId]);

  const selectProfile = (profile: SiteAIProfile) => { setSelectedId(profile.id); setDraft(toDraft(profile)); setModels([]); setModelError(""); setMessage(null); };
  const startNew = () => { setSelectedId(null); setDraft({ ...EMPTY_DRAFT, name: `渠道 ${profiles.length + 1}` }); setModels([]); setModelError(""); setMessage(null); };
  const changeProvider = (provider: string) => {
    const next = PROVIDER_PRESETS.find((item) => item.id === provider);
    if (!next) return;
    setDraft((current) => ({ ...current, provider, apiUrl: next.url, apiKey: "", model: next.defaultModel }));
    setModels([]); setModelError("");
  };

  const save = async () => {
    if (!draft.name.trim()) { setMessage({ type: "error", text: "请输入渠道名称" }); return; }
    setBusy(true); setMessage(null);
    try {
      const result = selectedId ? await siteAIModels.update(selectedId, draft) : await siteAIModels.create(draft);
      await load(result.profile.id); emitAIProfilesChanged(); setMessage({ type: "success", text: "AI 渠道已保存" });
    } catch (error) { setMessage({ type: "error", text: (error as Error)?.message || "保存失败" }); }
    finally { setBusy(false); }
  };
  const setDefault = async () => {
    if (!selectedId || selectedId === defaultProfileId) return;
    setBusy(true); setMessage(null);
    try { const result = await siteAIModels.setDefault(selectedId); setDefaultProfileId(result.defaultProfileId); setMessage({ type: "success", text: "默认渠道已更新" }); emitAIProfilesChanged(); }
    catch (error) { setMessage({ type: "error", text: (error as Error)?.message || "设置默认渠道失败" }); }
    finally { setBusy(false); }
  };
  const remove = async () => {
    if (!selectedId || profiles.length <= 1 || !window.confirm("确定删除这个 AI 渠道吗？")) return;
    setBusy(true);
    try { const result = await siteAIModels.remove(selectedId); await load(result.defaultProfileId); emitAIProfilesChanged(); }
    catch (error) { setMessage({ type: "error", text: (error as Error)?.message || "删除失败" }); }
    finally { setBusy(false); }
  };

  if (loading) return <div className="flex min-h-[320px] items-center justify-center text-zinc-400"><Loader2 className="animate-spin" size={22} /></div>;

  return <div className="space-y-5">
    <div className="flex items-center gap-3"><div className="flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-white"><Bot size={19} /></div><div><h2 className="text-xl font-bold text-zinc-900 dark:text-zinc-100">AI 模型配置</h2><p className="text-sm text-zinc-500 dark:text-zinc-400">管理员维护可用渠道；用户可在 AI 写作助手中切换渠道和模型。</p></div></div>
    <div className="grid gap-4 lg:grid-cols-[220px_minmax(0,1fr)]">
      <aside className="rounded-xl border border-zinc-200 bg-zinc-50/70 p-2 dark:border-zinc-800 dark:bg-zinc-900/30"><div className="mb-2 flex items-center justify-between px-1"><span className="text-xs font-semibold text-zinc-500">可用渠道</span><button type="button" onClick={startNew} className="rounded-md p-1.5 text-zinc-500 hover:bg-white hover:text-accent-primary" title="新建渠道"><Plus size={14} /></button></div><div className="max-h-[440px] space-y-1 overflow-auto">{profiles.map((profile) => <button key={profile.id} type="button" onClick={() => selectProfile(profile)} className={cn("w-full rounded-lg border px-3 py-2.5 text-left", selectedId === profile.id ? "border-accent-primary/50 bg-white shadow-sm dark:bg-zinc-900" : "border-transparent hover:bg-white dark:hover:bg-zinc-800/70")}><div className="flex items-center gap-2"><span className="min-w-0 flex-1 truncate text-sm font-medium text-zinc-800 dark:text-zinc-200">{profile.name}</span>{profile.id === defaultProfileId && <Star size={13} className="shrink-0 fill-amber-400 text-amber-400" />}</div><div className="mt-1 truncate text-[10px] text-zinc-400">{profile.provider} · {profile.model || "未选模型"}</div></button>)}{selectedId === null && <div className="rounded-lg border border-dashed border-accent-primary/50 bg-accent-primary/5 px-3 py-2.5 text-sm text-accent-primary">新建渠道</div>}</div></aside>
      <section className="space-y-4 rounded-xl border border-zinc-200 p-4 dark:border-zinc-800">
        <div className="grid gap-3 sm:grid-cols-2"><label className="space-y-1.5"><span className="text-xs font-medium text-zinc-500">渠道名称</span><input value={draft.name} onChange={(event) => setDraft((current) => ({ ...current, name: event.target.value }))} placeholder="例如：DeepSeek 主力" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm outline-none focus:border-accent-primary dark:border-zinc-700 dark:bg-zinc-900" /></label><label className="space-y-1.5"><span className="text-xs font-medium text-zinc-500">服务商</span><div className="relative"><select value={draft.provider} onChange={(event) => changeProvider(event.target.value)} className="w-full appearance-none rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-8 text-sm dark:border-zinc-700 dark:bg-zinc-900">{PROVIDER_PRESETS.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select><ChevronDown size={14} className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400" /></div></label></div>
        <label className="block space-y-1.5"><span className="text-xs font-medium text-zinc-500">API 地址</span><input value={draft.apiUrl} onChange={(event) => setDraft((current) => ({ ...current, apiUrl: event.target.value }))} placeholder="https://api.example.com/v1" className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 text-sm dark:border-zinc-700 dark:bg-zinc-900" /></label>
        {preset.needsKey && <label className="block space-y-1.5"><span className="text-xs font-medium text-zinc-500">API Key</span><div className="relative"><input type={showKey ? "text" : "password"} value={draft.apiKey} onChange={(event) => setDraft((current) => ({ ...current, apiKey: event.target.value }))} placeholder={selectedProfile?.apiKeySet ? "已保存密钥，留空保持不变" : "sk-..."} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-10 text-sm dark:border-zinc-700 dark:bg-zinc-900" /><button type="button" onClick={() => setShowKey((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400">{showKey ? <EyeOff size={14} /> : <Eye size={14} />}</button></div></label>}
        <div className="space-y-1.5"><div className="flex items-center justify-between"><span className="text-xs font-medium text-zinc-500">模型</span><button type="button" onClick={() => void discover()} disabled={discovering || !draft.apiUrl} className="inline-flex items-center gap-1 text-[10px] text-accent-primary disabled:opacity-40">{discovering ? <Loader2 size={11} className="animate-spin" /> : <RefreshCw size={11} />}刷新模型</button></div><div className="relative"><input value={draft.model} onChange={(event) => setDraft((current) => ({ ...current, model: event.target.value }))} onFocus={() => models.length > 0 && setModelOpen(true)} placeholder={preset.defaultModel || "手动输入模型名称"} className="w-full rounded-lg border border-zinc-200 bg-white px-3 py-2 pr-9 text-sm dark:border-zinc-700 dark:bg-zinc-900" />{models.length > 0 && <button type="button" onClick={() => setModelOpen((value) => !value)} className="absolute right-2.5 top-1/2 -translate-y-1/2 text-zinc-400"><ChevronDown size={14} /></button>}{modelOpen && models.length > 0 && <div className="absolute z-50 mt-1 max-h-60 w-full overflow-auto rounded-lg border border-zinc-200 bg-white py-1 shadow-xl dark:border-zinc-700 dark:bg-zinc-900">{models.map((model) => <button key={model.id} type="button" onClick={() => { setDraft((current) => ({ ...current, model: model.id })); setModelOpen(false); }} className="flex w-full items-center justify-between px-3 py-2 text-left text-sm hover:bg-accent-primary/5"><span className="truncate">{model.name}</span>{draft.model === model.id && <Check size={13} />}</button>)}</div>}</div><div className="min-h-4 text-[10px] text-amber-600">{modelError}</div></div>
        <div className="flex flex-wrap items-center gap-2 border-t border-zinc-100 pt-4 dark:border-zinc-800"><button type="button" onClick={() => void save()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg bg-accent-primary px-4 py-2 text-xs font-medium text-white disabled:opacity-50">{busy ? <Loader2 size={13} className="animate-spin" /> : <Save size={13} />}保存渠道</button>{selectedId && selectedId !== defaultProfileId && <button type="button" onClick={() => void setDefault()} disabled={busy} className="inline-flex items-center gap-1.5 rounded-lg border border-amber-300 px-4 py-2 text-xs font-medium text-amber-700 disabled:opacity-50"><Star size={13} />设为默认</button>}{selectedId && <button type="button" onClick={() => void remove()} disabled={busy || profiles.length <= 1} className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-medium text-red-500 disabled:opacity-40"><Trash2 size={13} />删除</button>}{message && <span className={cn("ml-auto inline-flex items-center gap-1 text-xs", message.type === "success" ? "text-emerald-600" : "text-red-500")}>{message.type === "success" ? <CheckCircle2 size={13} /> : <AlertCircle size={13} />}{message.text}</span>}</div>
      </section>
    </div>
  </div>;
}
