import type { Config } from "@netlify/functions";
import { cfg, cookies, setCookie, redirect, saveSession, newSid, validSid } from "../lib/ig.mts";

// Step 2 of OAuth: verify state, exchange the code for a long-lived token, store it encrypted.
export default async (req: Request) => {
  const url = new URL(req.url);
  const c = cfg();
  const clearState = setCookie("nx_oauth_state", "", 0);
  const fail = (code: string) => redirect(`/#/onboarding?ig_error=${encodeURIComponent(code)}`, [clearState]);

  if (!c.ok) return fail("not_configured");
  if (url.searchParams.get("error")) return fail(url.searchParams.get("error_reason") || "access_denied");

  const state = url.searchParams.get("state");
  if (!state || state !== cookies(req).nx_oauth_state) return fail("state_mismatch");
  const code = (url.searchParams.get("code") || "").replace(/#_$/, "");
  if (!code) return fail("missing_code");

  // short-lived token
  const r = await fetch("https://api.instagram.com/oauth/access_token", {
    method: "POST",
    body: new URLSearchParams({
      client_id: c.id,
      client_secret: c.secret,
      grant_type: "authorization_code",
      redirect_uri: c.redirect,
      code,
    }),
  });
  const j: any = await r.json().catch(() => ({}));
  const first = Array.isArray(j.data) ? j.data[0] : j;
  if (!r.ok || !first?.access_token) {
    console.error("Token exchange failed", r.status, j?.error_message || j?.error?.message);
    return fail("token_exchange");
  }

  // long-lived token (60 days)
  const lu = new URL("https://graph.instagram.com/access_token");
  lu.searchParams.set("grant_type", "ig_exchange_token");
  lu.searchParams.set("client_secret", c.secret);
  lu.searchParams.set("access_token", first.access_token);
  const lr = await fetch(lu);
  const lj: any = await lr.json().catch(() => ({}));
  if (!lr.ok || !lj.access_token) {
    console.error("Long-lived exchange failed", lr.status, lj?.error?.message);
    return fail("token_exchange");
  }

  const existing = cookies(req).nx_sid;
  const sid = validSid(existing) ? existing : newSid();
  await saveSession({
    sid,
    token: lj.access_token,
    userId: String(first.user_id || ""),
    expiresAt: Date.now() + (lj.expires_in || 5184000) * 1000,
    refreshedAt: Date.now(),
    permissions: typeof first.permissions === "string" ? first.permissions.split(",") : first.permissions,
  });

  return redirect("/#/app/dashboard?ig=connected", [clearState, setCookie("nx_sid", sid, 60 * 864e2)]);
};

export const config: Config = { path: "/api/oauth/instagram/callback" };
