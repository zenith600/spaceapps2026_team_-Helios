import { afterEach, describe, expect, it, vi } from "vitest";
import { LIVE_API_LABEL, probeLiveApi, resetLiveApiProbe } from "./liveApi";

const res = (status: number, body: unknown) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

describe("live API probe (header badge)", () => {
  afterEach(() => resetLiveApiProbe());

  it("is live only when /health answers ok: true", async () => {
    const f = vi.fn(async () => res(200, { ok: true }));
    expect(await probeLiveApi(f as unknown as typeof fetch)).toBe(true);
    expect(f).toHaveBeenCalledWith(expect.stringMatching(/\/health$/), expect.anything());
  });

  it("is not live on an HTTP error, a non-ok body, or a network failure", async () => {
    expect(await probeLiveApi((async () => res(502, {})) as unknown as typeof fetch)).toBe(false);
    expect(await probeLiveApi((async () => res(200, { ok: false })) as unknown as typeof fetch)).toBe(false);
    expect(await probeLiveApi((async () => { throw new TypeError("failed to fetch"); }) as unknown as typeof fetch)).toBe(false);
  });

  it("shares one successful probe, but retries after a failure", async () => {
    const good = vi.fn(async () => res(200, { ok: true }));
    await probeLiveApi(good as unknown as typeof fetch);
    await probeLiveApi(good as unknown as typeof fetch);
    expect(good).toHaveBeenCalledTimes(1);

    resetLiveApiProbe();
    const bad = vi.fn(async () => res(500, {}));
    await probeLiveApi(bad as unknown as typeof fetch);
    await probeLiveApi(bad as unknown as typeof fetch);
    expect(bad).toHaveBeenCalledTimes(2);
  });

  it("never claims live access in demo mode", () => {
    expect(LIVE_API_LABEL.demo).toBe("ready-made views");
    expect(LIVE_API_LABEL.unreachable).not.toMatch(/live NASA access/);
  });
});
