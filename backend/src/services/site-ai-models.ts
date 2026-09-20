import { randomUUID } from "node:crypto";
import { systemSettingsRepository } from "../repositories";

export interface SiteAIProfile {
  id: string;
  name: string;
  provider: string;
  apiUrl: string;
  apiKey: string;
  model: string;
  createdAt: string;
  updatedAt: string;
}

export interface PublicSiteAIProfile extends Omit<SiteAIProfile, "apiKey"> {
  apiKey: string;
  apiKeySet: boolean;
}

export const SITE_AI_PROFILES_KEY = "ai_site_profiles_v1";
export const SITE_AI_DEFAULT_PROFILE_KEY = "ai_site_default_profile_id";
export const USER_SITE_AI_PROFILE_KEY = "ai_site_active_profile_id";
export const MAX_SITE_AI_PROFILES = 50;

function text(value: unknown, fallback: string, max: number): string {
  return typeof value === "string" ? value.trim().slice(0, max) : fallback;
}

export function normalizeSiteAIProfile(input: unknown, base?: SiteAIProfile, touchUpdatedAt = true): SiteAIProfile {
  const raw = input && typeof input === "object" ? input as Record<string, unknown> : {};
  const now = new Date().toISOString();
  const apiUrl = text(raw.apiUrl, base?.apiUrl || "", 500).replace(/\/+$/, "");
  if (apiUrl) {
    const parsed = new URL(apiUrl);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("AI API 地址必须使用 http 或 https");
    }
  }
  return {
    id: text(raw.id, base?.id || `site-ai-${randomUUID()}`, 100),
    name: text(raw.name, base?.name || "默认渠道", 80) || "默认渠道",
    provider: text(raw.provider, base?.provider || "openai", 40) || "openai",
    apiUrl,
    apiKey: text(raw.apiKey, base?.apiKey || "", 2000),
    model: text(raw.model, base?.model || "", 200),
    createdAt: text(raw.createdAt, base?.createdAt || now, 64),
    updatedAt: touchUpdatedAt ? now : text(raw.updatedAt, base?.updatedAt || now, 64),
  };
}

export function readSiteAIProfiles(): SiteAIProfile[] {
  const raw = systemSettingsRepository.get(SITE_AI_PROFILES_KEY)?.value || "";
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.slice(0, MAX_SITE_AI_PROFILES).map((item) => {
      try { return normalizeSiteAIProfile(item, item as SiteAIProfile, false); } catch { return null; }
    }).filter((item): item is SiteAIProfile => !!item);
  } catch {
    return [];
  }
}

export function readSiteAIDefaultProfileId(profiles = readSiteAIProfiles()): string {
  const configured = systemSettingsRepository.get(SITE_AI_DEFAULT_PROFILE_KEY)?.value || "";
  return profiles.some((profile) => profile.id === configured) ? configured : (profiles[0]?.id || "");
}

export function writeSiteAIProfiles(profiles: SiteAIProfile[], defaultProfileId: string): void {
  systemSettingsRepository.setMany([
    { key: SITE_AI_PROFILES_KEY, value: JSON.stringify(profiles) },
    { key: SITE_AI_DEFAULT_PROFILE_KEY, value: defaultProfileId },
  ]);
}

export function maskSiteAIProfile(profile: SiteAIProfile): PublicSiteAIProfile {
  return {
    ...profile,
    apiKey: profile.apiKey ? `****${profile.apiKey.slice(-4)}` : "",
    apiKeySet: !!profile.apiKey,
  };
}

export function resolveSiteAIProfileKey(rawKey: unknown, currentKey: string): string {
  if (rawKey === undefined || typeof rawKey !== "string") return currentKey;
  if (rawKey.includes("****")) return currentKey;
  return rawKey.trim().slice(0, 2000);
}

export function modelEndpoint(apiUrl: string): string {
  const base = apiUrl.replace(/\/+$/, "");
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

export function extractSiteAIModels(data: unknown): Array<{ id: string; name: string }> {
  const value = data as any;
  const rows = Array.isArray(value)
    ? value
    : Array.isArray(value?.data)
      ? value.data
      : Array.isArray(value?.models)
        ? value.models
        : [];
  const seen = new Set<string>();
  const models: Array<{ id: string; name: string }> = [];
  for (const row of rows) {
    const id = typeof row === "string" ? row : String(row?.id || row?.name || row?.model || "").trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({ id, name: String(row?.display_name || row?.displayName || row?.name || id) });
  }
  return models.sort((a, b) => a.name.localeCompare(b.name));
}
