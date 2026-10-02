import type { Config } from "@netlify/functions";
import {
  cfg, json, setCookie, loadSession, saveSession, ensureFresh, graph, rawGraph, graphBase, GraphError, cached, tokenStore, cacheStore, type Session,
} from "../lib/ig.mts";

const DAY = 864e5;
const RANGES = [7, 28, 90, 180, 365];
const TOTAL_METRICS = ["reach", "views", "total_interactions"];

// The user_id returned by the OAuth token exchange is app-scoped and can't be used for
// /insights or /media. The professional account ID comes from GET /me?fields=user_id.
async function accountId(s: Session, token: string) {
  if (s.igAccountId) return s.igAccountId;
  const me = await graph("/me", token, { fields: "user_id" });
  const id = String(me.user_id || me.id);
  s.igAccountId = id;
  try { await saveSession(s); } catch {}
  return id;
}

// ---- account totals over a window, split into <=30 day chunks (API limit) ----
async function totals(id: string, token: string, from: number, to: number) {
  const out: Record<string, number | null> = Object.fromEntries(TOTAL_METRICS.map((m) => [m, null]));
  const chunks: [number, number][] = [];
  for (let a = from; a < to; a += 30 * DAY) chunks.push([a, Math.min(to, a + 30 * DAY)]);
  for (const [a, b] of chunks) {
    const params = { period: "day", metric_type: "total_value", since: Math.floor(a / 1000), until: Math.floor(b / 1000) };
    let rows: any[] = [];
    try {
      rows = (await graph(`/${id}/insights`, token, { ...params, metric: TOTAL_METRICS.join(",") })).data || [];
    } catch (e) {
      if (e instanceof GraphError && (e.kind === "TOKEN_EXPIRED" || e.kind === "RATE_LIMITED")) throw e;
      // one metric may be unsupported for this account: fetch individually
      const res = await Promise.allSettled(TOTAL_METRICS.map((m) => graph(`/${id}/insights`, token, { ...params, metric: m })));
      rows = res.flatMap((r) => (r.status === "fulfilled" ? r.value.data || [] : []));
    }
    for (const row of rows) {
      const v = row?.total_value?.value;
      if (typeof v === "number") out[row.name] = (out[row.name] ?? 0) + v;
    }
  }
  return out;
}

async function daily(id: string, token: string, metric: string, days: number) {
  const until = Date.now();
  const since = until - Math.min(days, 30) * DAY;
  try {
    const r = await graph(`/${id}/insights`, token, {
      metric, period: "day", since: Math.floor(since / 1000), until: Math.floor(until / 1000),
    });
    const vals = r.data?.[0]?.values || [];
    return vals.map((v: any) => ({ date: v.end_time, value: Number(v.value) || 0 }));
  } catch (e) {
    if (e instanceof GraphError && (e.kind === "TOKEN_EXPIRED" || e.kind === "RATE_LIMITED")) throw e;
    return null; // unavailable (e.g. follower_count needs 100+ followers)
  }
}

async function insights(s: Session, token: string, range: number) {
  const id = await accountId(s, token);
  const now = Date.now();
  const [current, previous, reachDaily, followerDaily] = await Promise.all([
    totals(id, token, now - range * DAY, now),
    totals(id, token, now - 2 * range * DAY, now - range * DAY),
    daily(id, token, "reach", range),
    daily(id, token, "follower_count", range),
  ]);
  const followerGain = followerDaily && range <= 30 ? followerDaily.reduce((a: number, b: any) => a + b.value, 0) : null;
  return { range, current, previous, reachDaily, followerDaily, followerGain, fetchedAt: now };
}

// ---- media list + per-media insights ----
const FULL = "reach,views,likes,comments,shares,saved,total_interactions";
const BASIC = "reach,likes,comments,shares,saved,total_interactions";
async function mediaInsights(mid: string, token: string) {
  for (const metric of [FULL, BASIC]) {
    try {
      const r = await graph(`/${mid}/insights`, token, { metric });
      const o: Record<string, number> = {};
      for (const row of r.data || []) {
        const v = row?.values?.[0]?.value ?? row?.total_value?.value;
        if (typeof v === "number") o[row.name] = v;
      }
      return o;
    } catch (e) {
      if (e instanceof GraphError && (e.kind === "TOKEN_EXPIRED" || e.kind === "RATE_LIMITED")) throw e;
    }
  }
  return null;
}
async function media(s: Session, token: string) {
  const id = await accountId(s, token);
  const r = await graph(`/${id}/media`, token, {
    fields: "id,caption,media_type,media_product_type,thumbnail_url,media_url,permalink,timestamp,like_count,comments_count",
    limit: 30,
  });
  const list: any[] = r.data || [];
  const out: any[] = [];
  for (let i = 0; i < list.length; i += 5) {
    const batch = list.slice(i, i + 5);
    const ins = await Promise.all(batch.map((m) => mediaInsights(m.id, token)));
    batch.forEach((m, k) => {
      const x = ins[k] || {};
      const caption = (m.caption || "").split("\n")[0].trim();
      out.push({
        id: m.id,
        type: m.media_product_type === "REELS" ? "reel" : m.media_product_type === "STORY" ? "story" : "post",
        mediaType: m.media_type,
        title: caption ? (caption.length > 90 ? caption.slice(0, 87) + "…" : caption) : "Untitled post",
        timestamp: m.timestamp,
        permalink: m.permalink,
        thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null) || null,
        views: x.views ?? null,
        reach: x.reach ?? null,
        likes: x.likes ?? m.like_count ?? null,
        comments: x.comments ?? m.comments_count ?? null,
        shares: x.shares ?? null,
        saves: x.saved ?? null,
        interactions: x.total_interactions ?? null,
        insightsAvailable: !!ins[k],
      });
    });
  }
  return { items: out, fetchedAt: Date.now() };
}

// ---- audience ----
async function audience(s: Session, token: string) {
  const id = await accountId(s, token);
  const breakdown = async (b: string) => {
    try {
      const r = await graph(`/${id}/insights`, token, {
        metric: "follower_demographics", period: "lifetime", timeframe: "this_month", metric_type: "total_value", breakdown: b,
      });
      const res: any[] = r.data?.[0]?.total_value?.breakdowns?.[0]?.results || [];
      const total = res.reduce((a, x) => a + (x.value || 0), 0);
      if (!total) return null;
      return res
        .map((x) => [String(x.dimension_values?.[0] ?? "?"), +((x.value / total) * 100).toFixed(1)] as [string, number])
        .sort((a, b) => b[1] - a[1]);
    } catch (e) {
      if (e instanceof GraphError && (e.kind === "TOKEN_EXPIRED" || e.kind === "RATE_LIMITED")) throw e;
      return null;
    }
  };
  const [age, gender, country, city] = await Promise.all(["age", "gender", "country", "city"].map(breakdown));
  let hours: number[] | null = null;
  try {
    const r = await graph(`/${id}/insights`, token, { metric: "online_followers", period: "lifetime" });
    const vals = r.data?.[0]?.values || [];
    const last = vals[vals.length - 1]?.value;
    if (last && typeof last === "object") hours = Array.from({ length: 24 }, (_, h) => Number(last[h] ?? last[String(h)]) || 0);
    if (hours && !hours.some(Boolean)) hours = null;
  } catch (e) {
    if (e instanceof GraphError && (e.kind === "TOKEN_EXPIRED" || e.kind === "RATE_LIMITED")) throw e;
  }
  return { age, gender, country, city, hours, fetchedAt: Date.now() };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const resource = url.pathname.replace(/^\/api\/instagram\/?/, "").replace(/\/$/, "");
  const c = cfg();

  if (resource === "status") {
    const s = c.ok ? await loadSession(req) : null;
    return json({ configured: c.ok, connected: !!s, expiresAt: s?.expiresAt ?? null });
  }
  if (!c.ok) return json({ error: "NOT_CONFIGURED", message: "Instagram credentials are not configured on the server." }, 503);

  const s = await loadSession(req);
  if (!s) return json({ error: "NOT_CONNECTED", message: "Connect Instagram to continue." }, 401);

  if (resource === "debug") {
    // Safe diagnostics: never returns the token or secret.
    const t = s.token || "";
    const probe = async (base: string) => {
      try {
        const { r, j } = await rawGraph(base, "/me", t, { fields: "user_id,username,account_type" });
        return { status: r.status, ok: r.ok && !j.error, username: j.username ?? null, accountType: j.account_type ?? null,
          error: j.error ? { code: j.error.code, subcode: j.error.error_subcode ?? null, type: j.error.type ?? null, message: j.error.message } : null };
      } catch (e: any) { return { error: String(e?.message || e) }; }
    };
    return json({
      appIdLast4: c.id.slice(-4), redirectUri: c.redirect,
      token: { prefix: t.slice(0, 4), length: t.length, expiresInHours: Math.round((s.expiresAt - Date.now()) / 36e5) },
      permissions: s.permissions ?? null,
      versioned: { base: graphBase(), ...(await probe(graphBase())) },
      unversioned: await probe("https://graph.instagram.com"),
    });
  }

  if (resource === "disconnect") {
    if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
    const origin = req.headers.get("origin");
    if (origin && origin !== url.origin) return json({ error: "FORBIDDEN" }, 403);
    await tokenStore().delete(s.sid);
    const cs = cacheStore();
    try {
      const { blobs } = await cs.list({ prefix: s.sid });
      await Promise.all(blobs.map((b) => cs.delete(b.key)));
    } catch {}
    return json({ ok: true }, 200, { "Set-Cookie": setCookie("nx_sid", "", 0) });
  }

  try {
    const token = await ensureFresh(s);
    switch (resource) {
      case "profile": {
        const data = await cached(`${s.sid}:profile`, 15 * 60e3, () =>
          graph("/me", token, { fields: "user_id,username,name,account_type,profile_picture_url,followers_count,follows_count,media_count" }));
        return json(data);
      }
      case "media":
        return json(await cached(`${s.sid}:media`, 15 * 60e3, () => media(s, token)));
      case "insights": {
        const range = Number(url.searchParams.get("range"));
        if (!RANGES.includes(range)) return json({ error: "BAD_RANGE" }, 400);
        return json(await cached(`${s.sid}:ins:${range}`, 15 * 60e3, () => insights(s, token, range)));
      }
      case "audience":
        return json(await cached(`${s.sid}:aud`, 6 * 3600e3, () => audience(s, token)));
      default:
        return json({ error: "NOT_FOUND" }, 404);
    }
  } catch (e) {
    if (e instanceof GraphError) {
      if (e.kind === "TOKEN_EXPIRED") await tokenStore().delete(s.sid);
      console.error("Graph error", e.kind, e.metaCode, e.message);
      return json({ error: e.kind, message: e.message }, e.status);
    }
    console.error(e);
    return json({ error: "SERVER_ERROR", message: "Something went wrong while loading Instagram data." }, 500);
  }
};

export const config: Config = { path: "/api/instagram/*" };
