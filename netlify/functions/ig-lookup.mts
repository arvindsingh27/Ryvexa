import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Public username lookup via Instagram Business Discovery (Graph API with Facebook Login).
// Uses ONE server-side token belonging to the site owner's Instagram professional account.
// Only public Business/Creator accounts can be looked up. No insights (reach, audience) here.

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MEDIA = "id,caption,media_type,media_product_type,like_count,comments_count,timestamp,permalink,media_url";
const PROFILE = "username,name,biography,website,profile_picture_url,followers_count,follows_count,media_count";

async function discover(u: string, token: string, igId: string, withThumb: boolean) {
  const base = `https://graph.facebook.com/${Netlify.env.get("FB_GRAPH_VERSION") || "v23.0"}/${igId}`;
  const fields = `business_discovery.username(${u}){${PROFILE},media.limit(12){${MEDIA}${withThumb ? ",thumbnail_url" : ""}}}`;
  const url = new URL(base);
  url.searchParams.set("fields", fields);
  url.searchParams.set("access_token", token);
  const r = await fetch(url);
  const j: any = await r.json().catch(() => ({}));
  return { ok: r.ok && !j.error, j };
}

export default async (req: Request, context: any) => {
  const token = Netlify.env.get("FB_LOOKUP_TOKEN");
  const igId = Netlify.env.get("FB_LOOKUP_IG_ID");
  if (!token || !igId) return json({ error: "NOT_CONFIGURED", message: "Username lookup isn’t set up on the server yet." }, 503);

  const username = (new URL(req.url).searchParams.get("username") || "").trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9._]{1,30}$/.test(username)) return json({ error: "BAD_USERNAME", message: "Enter a valid Instagram username." }, 400);

  const store = getStore("ig-lookup");

  // simple rate limit: 20 lookups per IP per hour (protects the shared Instagram quota)
  const ip = context?.ip || req.headers.get("x-nf-client-connection-ip") || "unknown";
  const hourKey = `rl:${ip}:${Math.floor(Date.now() / 3600e3)}`;
  try {
    const n = Number((await store.get(hourKey)) || 0);
    if (n >= 20) return json({ error: "RATE_LIMITED", message: "Too many lookups. Try again in an hour." }, 429);
    await store.set(hourKey, String(n + 1));
  } catch {}

  // cache each username for 30 minutes
  const cacheKey = `u:${username}`;
  try {
    const hit: any = await store.get(cacheKey, { type: "json" });
    if (hit && Date.now() - hit.at < 30 * 60e3) return json(hit.data);
  } catch {}

  let res = await discover(username, token, igId, true);
  if (!res.ok && res.j?.error?.code === 100 && /thumbnail_url/i.test(res.j?.error?.message || "")) {
    res = await discover(username, token, igId, false);
  }
  if (!res.ok) {
    const e = res.j?.error || {};
    console.error("business_discovery error", e.code, e.error_subcode, e.message);
    if (e.code === 190) return json({ error: "LOOKUP_TOKEN_EXPIRED", message: "The lookup token on the server has expired." }, 503);
    if ([4, 17, 32, 613].includes(e.code)) return json({ error: "RATE_LIMITED", message: "Instagram is limiting lookups. Try again later." }, 429);
    if (e.code === 110 || e.error_subcode === 2207013 || /cannot be found|does not exist|not.*business/i.test(e.message || ""))
      return json({ error: "NOT_FOUND", message: "No public Business or Creator account found with that username. Personal accounts can’t be looked up." }, 404);
    return json({ error: "LOOKUP_FAILED", message: e.message || "Lookup failed." }, 502);
  }

  const bd = res.j.business_discovery || {};
  const media = (bd.media?.data || []).map((m: any) => ({
    id: m.id,
    type: m.media_product_type === "REELS" ? "reel" : "post",
    title: ((m.caption || "").split("\n")[0].trim() || "Untitled post").slice(0, 90),
    likes: m.like_count ?? null,
    comments: m.comments_count ?? null,
    timestamp: m.timestamp,
    permalink: m.permalink,
    thumb: m.thumbnail_url || (m.media_type !== "VIDEO" ? m.media_url : null) || null,
  }));
  const data = {
    username: bd.username, name: bd.name || null, biography: bd.biography || "", website: bd.website || null,
    picture: bd.profile_picture_url || null, followers: bd.followers_count ?? null, following: bd.follows_count ?? null,
    posts: bd.media_count ?? null, media, fetchedAt: Date.now(),
  };
  try { await store.setJSON(cacheKey, { at: Date.now(), data }); } catch {}
  return json(data);
};

export const config: Config = { path: "/api/lookup" };
