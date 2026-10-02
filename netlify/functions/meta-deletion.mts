import type { Config } from "@netlify/functions";
import { createHmac, timingSafeEqual, randomBytes } from "node:crypto";
import { cfg, json, tokenStore, cacheStore } from "../lib/ig.mts";

// Meta "Deauthorize callback" and "Data deletion request" callback.
// Meta POSTs a form field `signed_request` = base64url(signature).base64url(payload),
// signed with HMAC-SHA256 using the Instagram app secret.
function parseSignedRequest(sr: string, secret: string): any | null {
  const [sig, payload] = sr.split(".");
  if (!sig || !payload) return null;
  const expected = createHmac("sha256", secret).update(payload).digest();
  const given = Buffer.from(sig.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (data.algorithm && String(data.algorithm).toUpperCase() !== "HMAC-SHA256") return null;
    return data;
  } catch { return null; }
}

async function deleteUser(userId: string) {
  const store = tokenStore();
  const sid = await store.get(`uid:${userId}`);
  if (sid) {
    await store.delete(sid);
    const cs = cacheStore();
    try {
      const { blobs } = await cs.list({ prefix: sid });
      await Promise.all(blobs.map((b) => cs.delete(b.key)));
    } catch {}
  }
  await store.delete(`uid:${userId}`);
}

export default async (req: Request) => {
  if (req.method !== "POST") return json({ error: "METHOD_NOT_ALLOWED" }, 405);
  const c = cfg();
  if (!c.secret) return json({ error: "NOT_CONFIGURED" }, 503);
  const form = await req.formData().catch(() => null);
  const sr = form?.get("signed_request");
  const data = typeof sr === "string" ? parseSignedRequest(sr, c.secret) : null;
  if (!data?.user_id) return json({ error: "INVALID_SIGNED_REQUEST" }, 400);

  await deleteUser(String(data.user_id));
  const url = new URL(req.url);
  if (url.pathname.endsWith("/deauthorize")) return json({ ok: true });

  const code = randomBytes(8).toString("hex");
  return json({ url: `${url.origin}/data-deletion.html?code=${code}`, confirmation_code: code });
};

export const config: Config = { path: ["/api/meta/data-deletion", "/api/meta/deauthorize"] };
