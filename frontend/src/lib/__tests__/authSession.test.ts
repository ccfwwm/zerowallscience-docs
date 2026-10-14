import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchWithAuthRefresh, refreshAccessToken, storeAuthTokens } from "../authSession";

beforeEach(() => {
  vi.useFakeTimers();
  localStorage.clear();
  storeAuthTokens({ token: "old-access", refreshToken: "refresh" });
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe("login refresh over remote gateways", () => {
  it("bounds a stalled refresh, keeps credentials and permits a new attempt", async () => {
    const transport = vi.fn().mockImplementation(() => new Promise(() => {}));
    vi.stubGlobal("fetch", transport);
    const pending = refreshAccessToken("https://nas.example/api");
    const rejection = expect(pending).rejects.toMatchObject({ name: "RefreshUnavailableError" });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(localStorage.getItem("nowen-token")).toBe("old-access");
    expect(localStorage.getItem("nowen-refresh-token")).toBe("refresh");
    expect(transport.mock.calls[0][1].signal.aborted).toBe(true);
    transport.mockResolvedValueOnce(new Response(JSON.stringify({ token: "new-access" })));
    await expect(refreshAccessToken("https://nas.example/api")).resolves.toBe("new-access");
  });

  it("also bounds a stalled response body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: () => new Promise(() => {}) }));
    const rejection = expect(refreshAccessToken("https://nas.example/body/api"))
      .rejects.toMatchObject({ name: "RefreshUnavailableError" });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(localStorage.getItem("nowen-token")).toBe("old-access");
  });

  it("does not persist a response arriving after the timeout", async () => {
    let resolve!: (response: Response) => void;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise<Response>((done) => { resolve = done; })));
    const rejection = expect(refreshAccessToken("https://nas.example/late/api"))
      .rejects.toMatchObject({ name: "RefreshUnavailableError" });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    resolve(new Response(JSON.stringify({ token: "late-access" })));
    await vi.advanceTimersByTimeAsync(0);
    expect(localStorage.getItem("nowen-token")).toBe("old-access");
  });

  it("does not turn a timed-out refresh into a terminal 401 or retry the original request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockImplementation(() => new Promise(() => {})));
    const request = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    const rejection = expect(fetchWithAuthRefresh("https://nas.example/verify/api/me", {
      headers: { Authorization: "Bearer old-access" },
    }, "https://nas.example/verify/api", request)).rejects.toMatchObject({ name: "RefreshUnavailableError" });
    await vi.advanceTimersByTimeAsync(8_000);
    await rejection;
    expect(request).toHaveBeenCalledOnce();
    expect(localStorage.getItem("nowen-token")).toBe("old-access");
  });

  it("continues to clear credentials on a definitive refresh rejection", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 401 })));
    await expect(refreshAccessToken("https://nas.example/rejected/api")).rejects.toThrow("登录续期失败");
    expect(localStorage.getItem("nowen-token")).toBeNull();
    expect(localStorage.getItem("nowen-refresh-token")).toBeNull();
  });

  it("coalesces concurrent successful refreshes and releases the timeout timer", async () => {
    const transport = vi.fn().mockResolvedValue(new Response(JSON.stringify({ token: "new-access" })));
    vi.stubGlobal("fetch", transport);
    await expect(Promise.all([
      refreshAccessToken("https://nas.example/shared/api"), refreshAccessToken("https://nas.example/shared/api"),
    ])).resolves.toEqual(["new-access", "new-access"]);
    expect(transport).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(8_000);
    expect(transport.mock.calls[0][1].signal.aborted).toBe(false);
  });
});
