import type { Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { cfg, setCookie, redirect } from "../lib/ig.mts";

// Step 1 of OAuth: send the user to Instagram's consent screen with a CSRF state value.
export default async (req: Request) => {
  const c = cfg();
  if (!c.ok) return redirect("/#/onboarding?ig_error=not_configured");
  const state = randomBytes(16).toString("hex");
  const u = new URL("https://www.instagram.com/oauth/authorize");
  u.search = new URLSearchParams({
    enable_fb_login: "0",
    force_authentication: "1",
    client_id: c.id,
    redirect_uri: c.redirect,
    response_type: "code",
    scope: "instagram_business_basic,instagram_business_manage_insights",
    state,
  }).toString();
  return redirect(u.toString(), [setCookie("nx_oauth_state", state, 600)]);
};

export const config: Config = { path: "/api/oauth/instagram/start" };
