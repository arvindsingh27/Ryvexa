import type { Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Live cricket via CricketData.org (api.cricapi.com). The API key stays on the server.
// Every response is cached in Netlify Blobs, so the API is called at most once per
// cache window no matter how many people have the page open (free plan = 100 hits/day).

const BASE = "https://api.cricapi.com/v1";
const store = () => getStore({ name: "cricket-cache", consistency: "strong" });
const json = (body: unknown, status = 200, maxAge = 30) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": `public, max-age=${maxAge}` },
  });

function minutes(name: string, def: number) {
  const v = Number(Netlify.env.get(name));
  return Number.isFinite(v) && v > 0 ? v : def;
}

async function callApi(endpoint: string, params: Record<string, string>) {
  const key = Netlify.env.get("CRICKET_API_KEY") || "";
  const qs = new URLSearchParams({ apikey: key, ...params });
  const res = await fetch(`${BASE}/${endpoint}?${qs}`, { headers: { accept: "application/json" } });
  const body: any = await res.json().catch(() => null);
  if (!res.ok || !body || body.status !== "success") {
    const reason = String(body?.reason || body?.message || `HTTP ${res.status}`).replace(key, "***");
    throw new Error(reason);
  }
  return body;
}

async function cached(cacheKey: string, ttlMin: number, load: () => Promise<any>) {
  const s = store();
  const hit: any = await s.get(cacheKey, { type: "json" }).catch(() => null);
  if (hit && Date.now() - hit.at < ttlMin * 60_000) return { ...hit, cached: true };
  try {
    const body = await load();
    const rec = { at: Date.now(), data: body.data, info: body.info ?? null };
    await s.setJSON(cacheKey, rec);
    return rec;
  } catch (e: any) {
    if (hit) return { ...hit, stale: true, error: e.message };
    throw e;
  }
}

const sc = (x: any) => ({ inning: String(x?.inning ?? ""), r: Number(x?.r ?? 0), w: Number(x?.w ?? 0), o: x?.o ?? null });

function slimMatch(m: any) {
  return {
    id: m.id,
    name: m.name,
    type: String(m.matchType || "").toLowerCase(),
    status: m.status,
    venue: m.venue,
    start: m.dateTimeGMT ? m.dateTimeGMT + (String(m.dateTimeGMT).endsWith("Z") ? "" : "Z") : m.date,
    teams: m.teams || [],
    teamInfo: (m.teamInfo || []).map((t: any) => ({ name: t.name, short: t.shortname })),
    score: (m.score || []).map(sc),
    started: Boolean(m.matchStarted),
    ended: Boolean(m.matchEnded),
  };
}

function slimCard(d: any) {
  return {
    ...slimMatch(d),
    tossWinner: d.tossWinner || null,
    tossChoice: d.tossChoice || null,
    winner: d.matchWinner || null,
    innings: (d.scorecard || []).map((inn: any) => ({
      title: inn.inning,
      batting: (inn.batting || []).map((b: any) => ({
        name: b.batsman?.name ?? "", dis: b["dismissal-text"] ?? "", r: +b.r || 0, b: +b.b || 0, f: +b["4s"] || 0, s: +b["6s"] || 0,
      })),
      bowling: (inn.bowling || []).map((b: any) => ({
        name: b.bowler?.name ?? "", o: b.o, m: +b.m || 0, r: +b.r || 0, w: +b.w || 0, eco: +b.eco || 0, wd: +b.wd || 0, nb: +b.nb || 0,
      })),
      extras: inn.extras ? { r: +inn.extras.r || 0 } : null,
    })),
  };
}

export default async (req: Request) => {
  const url = new URL(req.url);
  const route = url.pathname.replace(/^\/api\/cricket\/?/, "");
  if (!Netlify.env.get("CRICKET_API_KEY")) return json({ configured: false }, 200, 60);

  try {
    if (route === "matches") {
      const rec = await cached("current", minutes("CRICKET_LIST_TTL_MIN", 15), () => callApi("currentMatches", { offset: "0" }));
      return json({
        configured: true, updatedAt: rec.at, stale: Boolean(rec.stale),
        quota: rec.info ? { used: rec.info.hitsToday ?? rec.info.hitsUsed ?? null, limit: rec.info.hitsLimit ?? null } : null,
        matches: (rec.data || []).map(slimMatch),
      });
    }
    if (route === "scorecard") {
      const id = url.searchParams.get("id") || "";
      if (!/^[a-zA-Z0-9-]{8,64}$/.test(id)) return json({ error: "BAD_ID" }, 400);
      const rec = await cached(`card:${id}`, minutes("CRICKET_CARD_TTL_MIN", 10), () => callApi("match_scorecard", { id }));
      return json({ configured: true, updatedAt: rec.at, stale: Boolean(rec.stale), match: slimCard(rec.data || {}) });
    }
    return json({ error: "NOT_FOUND" }, 404);
  } catch (e: any) {
    return json({ configured: true, error: "UPSTREAM", message: String(e.message).slice(0, 200) }, 502, 0);
  }
};

export const config: Config = { path: ["/api/cricket/matches", "/api/cricket/scorecard"] };
