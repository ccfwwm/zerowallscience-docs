import { Hono } from "hono";
import { isSystemAdmin } from "../middleware/acl";
import { getUserAISetting, setGuardedUserAISettings, setUserAISetting } from "../services/user-ai-settings";
import {
  extractSiteAIModels,
  maskSiteAIProfile,
  MAX_SITE_AI_PROFILES,
  modelEndpoint,
  normalizeSiteAIProfile,
  readSiteAIDefaultProfileId,
  readSiteAIProfiles,
  resolveSiteAIProfileKey,
  type SiteAIProfile,
  writeSiteAIProfiles,
  USER_SITE_AI_PROFILE_KEY,
} from "../services/site-ai-models";

const app = new Hono();

function requireUser(c: any): string | null {
  const userId = c.req.header("X-User-Id") || "";
  return userId || null;
}

function adminOnly(c: any): string | null {
  const userId = requireUser(c);
  if (!userId) return null;
  return isSystemAdmin(userId) ? userId : null;
}

function userState(userId: string, profiles: SiteAIProfile[]) {
  const defaultProfileId = readSiteAIDefaultProfileId(profiles);
  const configuredActiveProfileId = getUserAISetting(userId, USER_SITE_AI_PROFILE_KEY);
  let activeProfileId = configuredActiveProfileId;
  if (!profiles.some((profile) => profile.id === activeProfileId)) activeProfileId = defaultProfileId;

  // 旧用户没有个人 AI 配置时，首次进入即可使用管理员设定的默认渠道；
  // 已有个人设置的用户保持兼容，不被站点目录覆盖。
  const needsDefaultSync = activeProfileId && (
    !getUserAISetting(userId, "ai_api_url")
    || (!!configuredActiveProfileId && configuredActiveProfileId !== activeProfileId)
  );
  if (needsDefaultSync) {
    const profile = profiles.find((item) => item.id === activeProfileId);
    if (profile) {
      setUserAISetting(userId, USER_SITE_AI_PROFILE_KEY, activeProfileId);
      setGuardedUserAISettings(userId, [
        { key: "ai_provider", value: profile.provider },
        { key: "ai_api_url", value: profile.apiUrl },
        { key: "ai_api_key", value: profile.apiKey },
        { key: "ai_model", value: profile.model },
      ]);
    }
  }
  return { defaultProfileId, activeProfileId };
}

app.get("/", (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const profiles = readSiteAIProfiles();
  const state = userState(userId, profiles);
  return c.json({
    profiles: profiles.map(maskSiteAIProfile),
    defaultProfileId: state.defaultProfileId,
    activeProfileId: state.activeProfileId,
  });
});

app.post("/", async (c) => {
  const userId = adminOnly(c);
  if (!userId) return c.json({ error: "仅管理员可配置 AI 模型", code: "FORBIDDEN" }, 403);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const profiles = readSiteAIProfiles();
  if (profiles.length >= MAX_SITE_AI_PROFILES) return c.json({ error: `最多保存 ${MAX_SITE_AI_PROFILES} 个 AI 渠道` }, 400);
  let profile: SiteAIProfile;
  try { profile = normalizeSiteAIProfile({ ...body, id: undefined }); }
  catch (error) { return c.json({ error: (error as Error).message }, 400); }
  const nextProfiles = [...profiles, profile];
  const defaultProfileId = readSiteAIDefaultProfileId(profiles) || profile.id;
  writeSiteAIProfiles(nextProfiles, defaultProfileId);
  return c.json({ profile: maskSiteAIProfile(profile), defaultProfileId }, 201);
});

app.post("/discover-models", async (c) => {
  const userId = adminOnly(c);
  if (!userId) return c.json({ error: "仅管理员可获取 AI 模型", models: [] }, 403);
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const profiles = readSiteAIProfiles();
  const stored = typeof body.profileId === "string" ? profiles.find((profile) => profile.id === body.profileId) : undefined;
  let profile: SiteAIProfile;
  try {
    profile = normalizeSiteAIProfile({ ...stored, ...body, id: stored?.id, apiKey: resolveSiteAIProfileKey(body.apiKey, stored?.apiKey || "") }, stored, false);
  } catch (error) { return c.json({ error: (error as Error).message, models: [] }, 400); }
  if (!profile.apiUrl) return c.json({ error: "请先填写 AI API 地址", models: [] }, 400);
  if (profile.provider !== "ollama" && !profile.apiKey) return c.json({ error: "请先填写 API Key", models: [] }, 400);
  const headers: Record<string, string> = { Accept: "application/json" };
  if (profile.apiKey) headers.Authorization = `Bearer ${profile.apiKey}`;
  const candidates = profile.provider === "ollama"
    ? [`${profile.apiUrl.replace(/\/+$/, "").replace(/\/v1$/i, "")}/api/tags`, modelEndpoint(profile.apiUrl)]
    : [modelEndpoint(profile.apiUrl)];
  const failures: string[] = [];
  for (const endpoint of Array.from(new Set(candidates))) {
    try {
      const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(12_000) });
      if (!response.ok) { failures.push(`${response.status} ${(await response.text().catch(() => "")).slice(0, 160)}`.trim()); continue; }
      const models = extractSiteAIModels(await response.json());
      if (models.length) return c.json({ models, source: endpoint });
      failures.push("接口返回成功，但没有可识别的模型列表");
    } catch (error) { failures.push((error as Error)?.message || "模型接口请求失败"); }
  }
  return c.json({ error: failures.join("；") || "无法获取模型列表", models: [] }, 502);
});

app.put("/default", async (c) => {
  const userId = adminOnly(c);
  if (!userId) return c.json({ error: "仅管理员可设置默认 AI 渠道", code: "FORBIDDEN" }, 403);
  const body = await c.req.json().catch(() => ({})) as { profileId?: string };
  const profiles = readSiteAIProfiles();
  if (!profiles.some((profile) => profile.id === body.profileId)) return c.json({ error: "AI 渠道不存在" }, 404);
  writeSiteAIProfiles(profiles, body.profileId!);
  return c.json({ defaultProfileId: body.profileId });
});

app.put("/:profileId/activate", (c) => {
  const userId = requireUser(c);
  if (!userId) return c.json({ error: "Unauthorized" }, 401);
  const profile = readSiteAIProfiles().find((item) => item.id === c.req.param("profileId"));
  if (!profile) return c.json({ error: "AI 渠道不存在" }, 404);
  setUserAISetting(userId, USER_SITE_AI_PROFILE_KEY, profile.id);
  setGuardedUserAISettings(userId, [
    { key: "ai_provider", value: profile.provider },
    { key: "ai_api_url", value: profile.apiUrl },
    { key: "ai_api_key", value: profile.apiKey },
    { key: "ai_model", value: profile.model },
  ]);
  return c.json({ profile: maskSiteAIProfile(profile), activeProfileId: profile.id });
});

app.put("/:profileId", async (c) => {
  const userId = adminOnly(c);
  if (!userId) return c.json({ error: "仅管理员可配置 AI 模型", code: "FORBIDDEN" }, 403);
  const profileId = c.req.param("profileId");
  const body = await c.req.json().catch(() => ({})) as Record<string, unknown>;
  const profiles = readSiteAIProfiles();
  const index = profiles.findIndex((profile) => profile.id === profileId);
  if (index < 0) return c.json({ error: "AI 渠道不存在" }, 404);
  try {
    profiles[index] = normalizeSiteAIProfile({ ...body, id: profileId, apiKey: resolveSiteAIProfileKey(body.apiKey, profiles[index].apiKey) }, profiles[index]);
  } catch (error) { return c.json({ error: (error as Error).message }, 400); }
  writeSiteAIProfiles(profiles, readSiteAIDefaultProfileId(profiles));
  return c.json({ profile: maskSiteAIProfile(profiles[index]), defaultProfileId: readSiteAIDefaultProfileId(profiles) });
});

app.delete("/:profileId", (c) => {
  const userId = adminOnly(c);
  if (!userId) return c.json({ error: "仅管理员可配置 AI 模型", code: "FORBIDDEN" }, 403);
  const profileId = c.req.param("profileId");
  const profiles = readSiteAIProfiles();
  if (profiles.length <= 1) return c.json({ error: "至少需要保留一个 AI 渠道" }, 400);
  if (!profiles.some((profile) => profile.id === profileId)) return c.json({ error: "AI 渠道不存在" }, 404);
  const nextProfiles = profiles.filter((profile) => profile.id !== profileId);
  const defaultProfileId = readSiteAIDefaultProfileId(profiles) === profileId ? nextProfiles[0].id : readSiteAIDefaultProfileId(profiles);
  writeSiteAIProfiles(nextProfiles, defaultProfileId);
  return c.json({ success: true, defaultProfileId });
});

export default app;
