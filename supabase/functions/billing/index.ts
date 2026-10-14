// =====================================================================
// Coach Assiette : abonnements (Supabase Edge Function "billing")
// © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
// Ouvre la page de paiement Stripe, l'espace « Gérer mon abonnement »,
// et met à jour l'abonnement au retour du paiement.
// Secrets obligatoires (Supabase > Edge Functions > Secrets) :
//   STRIPE_SECRET_KEY (sk_test_… pour les essais, sk_live_… ensuite)
//   STRIPE_PRICE_ID   (price_… : le prix mensuel créé dans Stripe)
// Réglage facultatif : ALLOWED_ORIGINS (défaut https://keyvos.github.io)
// "Verify JWT" : désactivé (la fonction vérifie elle-même la connexion)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

// ==== origin (même code dans ai)
function allowedOrigins(): string[] {
  return (Deno.env.get("ALLOWED_ORIGINS") || "https://keyvos.github.io").split(",").map((s) => s.trim().replace(/\/+$/, "")).filter(Boolean);
}
function originOk(req: Request): boolean {
  const list = allowedOrigins();
  if (list.includes("*")) return true;
  return list.includes(req.headers.get("Origin") || "");
}
function corsFor(req: Request): Record<string, string> {
  const o = req.headers.get("Origin") || "";
  const list = allowedOrigins();
  return {
    "Access-Control-Allow-Origin": list.includes("*") ? "*" : (list.includes(o) ? o : list[0]),
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Vary": "Origin",
  };
}
// ==== end origin

function serverKey(): string {
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const k = all.default || Object.values(all)[0];
    if (typeof k === "string" && k) return k;
  } catch (_) { /* ignore */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}

// deno-lint-ignore no-explicit-any
type Any = any;

async function stripe(path: string, method = "GET", params?: Record<string, string>): Promise<Any> {
  const r = await fetch("https://api.stripe.com/v1/" + path, {
    method,
    headers: {
      Authorization: "Bearer " + (Deno.env.get("STRIPE_SECRET_KEY") || ""),
      ...(params ? { "Content-Type": "application/x-www-form-urlencoded" } : {}),
    },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, message: j?.error?.message || "Stripe" };
  return j;
}

// ==== subscription state (même code dans stripe-webhook)
const LIVE = ["active", "trialing", "past_due"];
function subState(sub: Any) {
  const item = sub?.items?.data?.[0];
  const end = sub?.current_period_end ?? item?.current_period_end ?? null;
  return {
    stripe_customer: typeof sub?.customer === "string" ? sub.customer : (sub?.customer?.id || null),
    stripe_sub: String(sub?.id || ""),
    status: String(sub?.status || "none"),
    period_end: end ? new Date(Number(end) * 1000).toISOString() : null,
    cancel_at_end: !!(sub?.cancel_at_period_end || sub?.cancel_at),
  };
}
async function saveSub(admin: Any, uid: string, st: ReturnType<typeof subState>) {
  const { data: prev } = await admin.from("subscriptions").select("stripe_sub,status,status_since").eq("user_id", uid).maybeSingle();
  // an old, ended subscription must never overwrite a newer one that is still running
  if (prev && prev.stripe_sub && prev.stripe_sub !== st.stripe_sub && LIVE.includes(prev.status) && !LIVE.includes(st.status)) return { skipped: true };
  const now = new Date().toISOString();
  const { error } = await admin.from("subscriptions").upsert({
    user_id: uid, ...st,
    status_since: prev && prev.status === st.status && prev.status_since ? prev.status_since : now,
    updated_at: now,
  });
  if (error) console.error("subscriptions", error.message);
  return { error };
}
// ==== end subscription state

function returnUrlOk(u: string): boolean {
  const list = allowedOrigins();
  return !!u && !/[?#]/.test(u) && list.some((o) => o !== "*" && (u === o || u.startsWith(o + "/")));
}

Deno.serve(async (req) => {
  const CORS = corsFor(req);
  const reply = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  if (!originOk(req)) return reply({ error: "Site non autorisé", code: "origin" }, 403);
  if (req.method !== "POST") return reply({ error: "Méthode non autorisée", code: "bad_request" }, 405);
  const PRICE = Deno.env.get("STRIPE_PRICE_ID") || "";
  if (!Deno.env.get("STRIPE_SECRET_KEY") || !PRICE) return reply({ error: "Paiement pas encore configuré", code: "not_configured" }, 503);

  const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });
  const { data: who, error: authErr } = await admin.auth.getUser(token);
  if (authErr || !who?.user) return reply({ error: "Session invalide", code: "session_expired" }, 401);
  const uid: string = who.user.id;
  const email: string = String(who.user.email || "");

  let body: Any = {};
  try { body = await req.json(); } catch (_) { /* empty body */ }
  const action = String(body.action || "");
  const ret = String(body.return_url || "");

  try {
    if (action === "price") {
      const p = await stripe("prices/" + encodeURIComponent(PRICE));
      return reply({ amount: p.unit_amount, currency: p.currency, interval: p.recurring?.interval || "month" });
    }

    const { data: row } = await admin.from("subscriptions").select("*").eq("user_id", uid).maybeSingle();

    if (action === "checkout") {
      if (!returnUrlOk(ret)) return reply({ error: "Adresse de retour refusée", code: "bad_request" }, 400);
      if (row && ["active", "trialing"].includes(row.status)) return reply({ error: "Déjà abonné", code: "already" }, 409);
      const lang = ["fr", "en", "pt", "es"].includes(body.lang) ? body.lang : "auto";
      const params: Record<string, string> = {
        mode: "subscription",
        "line_items[0][price]": PRICE,
        "line_items[0][quantity]": "1",
        client_reference_id: uid,
        "metadata[user_id]": uid,
        "subscription_data[metadata][user_id]": uid,
        success_url: ret + "?billing=ok&session_id={CHECKOUT_SESSION_ID}",
        cancel_url: ret + "?billing=cancel",
        locale: lang,
        allow_promotion_codes: "true",
      };
      if (row?.stripe_customer) params.customer = row.stripe_customer;
      else if (email) params.customer_email = email;
      const s = await stripe("checkout/sessions", "POST", params);
      return reply({ url: s.url });
    }

    if (action === "portal") {
      if (!returnUrlOk(ret)) return reply({ error: "Adresse de retour refusée", code: "bad_request" }, 400);
      if (!row?.stripe_customer) return reply({ error: "Aucun abonnement", code: "no_customer" }, 404);
      const s = await stripe("billing_portal/sessions", "POST", { customer: row.stripe_customer, return_url: ret });
      return reply({ url: s.url });
    }

    if (action === "sync") {
      // back from the payment page: read the result straight from Stripe (no need to wait for the webhook)
      const sid = String(body.session_id || "");
      if (/^cs_[A-Za-z0-9_]+$/.test(sid)) {
        const s = await stripe("checkout/sessions/" + sid);
        if (s.client_reference_id !== uid) return reply({ error: "Paiement d'un autre compte", code: "forbidden" }, 403);
        const subId = typeof s.subscription === "string" ? s.subscription : s.subscription?.id;
        if (subId) await saveSub(admin, uid, subState(await stripe("subscriptions/" + subId)));
      } else if (row?.stripe_sub) {
        await saveSub(admin, uid, subState(await stripe("subscriptions/" + row.stripe_sub)));
      }
      const { data: acc } = await admin.rpc("access_for", { uid });
      return reply({ ok: true, access: acc || null });
    }

    if (action === "cancel_now") {
      // used just before an account is deleted, so that nobody keeps paying for a deleted account
      if (row?.stripe_sub && ["active", "trialing", "past_due", "incomplete", "unpaid"].includes(row.status)) {
        await stripe("subscriptions/" + row.stripe_sub, "DELETE");
      }
      return reply({ ok: true });
    }

    return reply({ error: "Action inconnue", code: "bad_request" }, 400);
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.error("stripe", err?.status, err?.message);
    return reply({ error: err?.message || "Erreur Stripe", code: "stripe" }, 502);
  }
});
