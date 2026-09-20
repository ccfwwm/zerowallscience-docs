import { getBaseUrl } from "@/lib/api";

export interface SiteAIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  apiKeySet: boolean;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface SiteAIProfileDraft {
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
}

export interface SiteAIModelOption {
  id: string;
  name: string;
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const token = localStorage.getItem("nowen-token") || "";
  const headers = new Headers(init?.headers);
  headers.set("Content-Type", "application/json");
  if (token) headers.set("Authorization", `Bearer ${token}`);
  const response = await fetch(`${getBaseUrl()}/settings/ai-models${path}`, { ...init, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body?.error || `请求失败：${response.status}`);
  return body as T;
}

export const siteAIModels = {
  list: () => request<{
    profiles: SiteAIProfile[];
    defaultProfileId: string;
    activeProfileId: string;
  }>(""),
  create: (draft: SiteAIProfileDraft) => request<{ profile: SiteAIProfile; defaultProfileId: string }>("", {
    method: "POST",
    body: JSON.stringify(draft),
  }),
  update: (profileId: string, draft: SiteAIProfileDraft) => request<{ profile: SiteAIProfile; defaultProfileId: string }>(`/${encodeURIComponent(profileId)}`, {
    method: "PUT",
    body: JSON.stringify(draft),
  }),
  remove: (profileId: string) => request<{ success: true; defaultProfileId: string }>(`/${encodeURIComponent(profileId)}`, { method: "DELETE" }),
  setDefault: (profileId: string) => request<{ defaultProfileId: string }>("/default", {
    method: "PUT",
    body: JSON.stringify({ profileId }),
  }),
  activate: (profileId: string) => request<{ profile: SiteAIProfile; activeProfileId: string }>(`/${encodeURIComponent(profileId)}/activate`, { method: "PUT" }),
  discoverModels: (draft: SiteAIProfileDraft, profileId?: string) => request<{ models: SiteAIModelOption[]; source?: string }>("/discover-models", {
    method: "POST",
    body: JSON.stringify({ ...draft, profileId }),
  }),
};
