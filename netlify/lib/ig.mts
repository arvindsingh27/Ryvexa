// Server-only helpers for the Instagram integration (Instagram API with Instagram Login).
// Secrets are read from Netlify environment variables and never sent to the browser.
import { getStore } from "@netlify/blobs";
import { randomBytes, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";

export function cfg() {
  const id = Netlify.env.get("INSTAGRAM_APP_ID") || "";
  const secret = Netlify.env.get("INSTAGRAM_APP_SECRET") || "";
  const redirect = Netlify.env.get("INSTAGRAM_REDIRECT_URI") || "";
  return { id, secret, redirect, ok: Boolean(id && secret && redirect) };
}

export { rawGraph };
export function graphBase() {
  return `https://graph.instagram.com/${Netlify.env.get("IG_GRAPH_VERSION") || "v23.0"}`;
}

// ---------- encryption (AES-256-GCM, key derived from a server secret) ----------
function key(): Buffer {
  const base = Netlify.env.get("TOKEN_ENCRYPTION_KEY") || Netlify.env.get("INSTAGRAM_APP_SECRET") || "";
  if (!base) throw new Error("No encryption key material configured");
  return Buffer.from(hkdfSync("sha256", base, "nexlytics", "ig-token-v1", 32));
}
export function encrypt(obj: unknown): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key(), iv);
  const enc = Buffer.concat([c.update(JSON.stringify(obj), "utf8"), c.final()]);
  return [iv, c.getAuthTag(), enc].map((b) => b.toString("base64url")).join(".");
}
export function decrypt<T = any>(s: string): T {
  const [iv, tag, enc] = s.split(".").map((x) => Buffer.from(x, "base64url"));
  const d = createDecipheriv("aes-256-gcm", key(), iv);
  d.setAuthTag(tag);
  return JSON.parse(Buffer.concat([d.update(enc), d.final()]).toString("utf8"));
}

// ---------- storage ----------
export const tokenStore = () => getStore({ name: "ig-tokens", consistency: "strong" });
export const cacheStore = () => getStore("ig-cache");

export interface Session {
  sid: string;
  token: string;
  userId: string;
  igAccountId?: string;
  expiresAt: number;
  refreshedAt: number;
  permissions?: string[];
}

// ---------- cookies / responses ----------
export function cookies(req: Request): Record<string, string> {
  const out: Record<string, string> = {};
  (req.headers.get("cookie") || "").split(/;\s*/).forEach((p) => {
    const i = p.indexOf("=");
    if (i > 0) out[p.slice(0, i)] = decodeURIComponent(p.slice(i + 1));
  });
  return out;
}
export function setCookie(name: string, val: string, maxAge: number) {
  return `${name}=${encodeURIComponent(val)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}
export function json(data: unknown, status = 200, extra: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...extra },
  });
}
export function redirect(location: string, setCookies: string[] = []) {
  const h = new Headers({ Location: location, "cache-control": "no-store" });
  setCookies.forEach((c) => h.append("Set-Cookie", c));
  return new Response(null, { status: 302, headers: h });
}
export const newSid = () => randomBytes(32).toString("hex");
export const validSid = (s?: string) => !!s && /^[a-f0-9]{64}$/.test(s);

export async function loadSession(req: Request): Promise<Session | null> {
  const sid = cookies(req).nx_sid;
  if (!validSid(sid)) return null;
  const raw = await tokenStore().get(sid);
  if (!raw) return null;
  try {
    return { sid, ...decrypt<Omit<Session, "sid">>(raw) };
  } catch {
    return null;
  }
}
export async function saveSession(s: Session) {
  const { sid, ...rest } = s;
  await tokenStore().set(sid, encrypt(rest));
  // index by Instagram user id so Meta deauthorize / data-deletion callbacks can find the session
  for (const uid of [s.userId, s.igAccountId]) {
    if (uid) { try { await tokenStore().set(`uid:${uid}`, sid); } catch {} }
  }
}

// ---------- Graph API ----------
export class GraphError extends Error {
  constructor(public kind: string, public status: number, message: string, public metaCode?: number) {
    super(message);
  }
}
async function rawGraph(base: string, path: string, token: string, params: Record<string, string | number>) {
  const u = new URL(base + path);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, String(v));
  u.searchParams.set("access_token", token);
  const r = await fetch(u);
  const j: any = await r.json().catch(() => ({}));
  return { r, j };
}
export async function graph(path: string, token: string, params: Record<string, string | number> = {}) {
  let { r, j } = await rawGraph(graphBase(), path, token, params);
  // Some tokens are rejected on the versioned host with "Unsupported request"; retry unversioned.
  if ((!r.ok || j.error) && /unsupported request/i.test(j?.error?.message || "")) {
    ({ r, j } = await rawGraph("https://graph.instagram.com", path, token, params));
  }
  if (!r.ok || j.error) {
    const e = j.error || {};
    const c: number | undefined = e.code;
    let kind = "API_ERROR";
    if (c === 190) kind = "TOKEN_EXPIRED";
    else if ([4, 17, 32, 613].includes(c as number) || r.status === 429) kind = "RATE_LIMITED";
    else if (c === 10 || c === 3 || (c !== undefined && c >= 200 && c < 300)) kind = "PERMISSION_MISSING";
    const status = { TOKEN_EXPIRED: 401, RATE_LIMITED: 429, PERMISSION_MISSING: 403 }[kind] || 502;
    throw new GraphError(kind, status, e.message || `Instagram returned HTTP ${r.status}`, c);
  }
  return j;
}

// Long-lived tokens last 60 days; refresh when fewer than 10 days remain (min. 24 h after issue).
export async function ensureFresh(s: Session): Promise<string> {
  const day = 864e5;
  if (s.expiresAt - Date.now() > 10 * day || Date.now() - s.refreshedAt < day) return s.token;
  const u = new URL("https://graph.instagram.com/refresh_access_token");
  u.searchParams.set("grant_type", "ig_refresh_token");
  u.searchParams.set("access_token", s.token);
  const r = await fetch(u);
  const j: any = await r.json().catch(() => ({}));
  if (r.ok && j.access_token) {
    s.token = j.access_token;
    s.expiresAt = Date.now() + (j.expires_in || 5184000) * 1000;
    s.refreshedAt = Date.now();
    await saveSession(s);
  }
  return s.token;
}

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const store = cacheStore();
  try {
    const hit: any = await store.get(key, { type: "json" });
    if (hit && Date.now() - hit.at < ttlMs) return hit.data as T;
  } catch {}
  const data = await fn();
  try { await store.setJSON(key, { at: Date.now(), data }); } catch {}
  return data;
}
