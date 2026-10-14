// =====================================================================
// Coach Assiette : messages de Stripe (Supabase Edge Function "stripe-webhook")
// © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
// Stripe prévient ici à chaque paiement, échec de paiement ou résiliation :
// l'état de l'abonnement est mis à jour tout seul.
// Secrets obligatoires : STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET (whsec_…)
// "Verify JWT" : désactivé (Stripe n'est pas un utilisateur ; on vérifie
// à la place la signature de chaque message avec STRIPE_WEBHOOK_SECRET)
// Événements à cocher dans Stripe : checkout.session.completed,
//   customer.subscription.created, customer.subscription.updated,
//   customer.subscription.deleted
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

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

// ==== signature
function sameText(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyStripe(payload: string, header: string, secret: string, nowSec = Math.floor(Date.now() / 1000), tolerance = 300): Promise<boolean> {
  const parts = header.split(",").map((p) => p.trim().split("="));
  const t = parts.find((p) => p[0] === "t")?.[1];
  const sigs = parts.filter((p) => p[0] === "v1").map((p) => p[1] || "");
  if (!t || !sigs.length || !/^\d+$/.test(t)) return false;
  if (Math.abs(nowSec - Number(t)) > tolerance) return false;
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(t + "." + payload)));
  const hex = Array.from(mac, (b) => b.toString(16).padStart(2, "0")).join("");
  return sigs.some((s) => sameText(s, hex));
}
// ==== end signature

async function stripe(path: string): Promise<Any> {
  const r = await fetch("https://api.stripe.com/v1/" + path, { headers: { Authorization: "Bearer " + (Deno.env.get("STRIPE_SECRET_KEY") || "") } });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw { status: r.status, message: j?.error?.message || "Stripe" };
  return j;
}

// ==== subscription state (même code dans billing)
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

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

Deno.serve(async (req) => {
  if (req.method !== "POST") return new Response("ok");
  const secret = Deno.env.get("STRIPE_WEBHOOK_SECRET") || "";
  const payload = await req.text();
  if (!secret || !(await verifyStripe(payload, req.headers.get("Stripe-Signature") || "", secret))) {
    return new Response("Signature invalide", { status: 400 });
  }
  let ev: Any;
  try { ev = JSON.parse(payload); } catch (_) { return new Response("Message illisible", { status: 400 }); }
  const obj = ev?.data?.object || {};
  const type = String(ev?.type || "");
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });

  try {
    if (type === "checkout.session.completed" || type === "checkout.session.async_payment_succeeded") {
      const uid = String(obj.client_reference_id || obj.metadata?.user_id || "");
      const subId = typeof obj.subscription === "string" ? obj.subscription : obj.subscription?.id;
      if (UUID.test(uid) && subId) await saveSub(admin, uid, subState(await stripe("subscriptions/" + subId)));
    } else if (type.startsWith("customer.subscription.")) {
      let uid = String(obj.metadata?.user_id || "");
      if (!UUID.test(uid) && obj.id) {
        const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_sub", obj.id).maybeSingle();
        uid = data?.user_id || "";
      }
      if (!UUID.test(uid) && typeof obj.customer === "string") {
        const { data } = await admin.from("subscriptions").select("user_id").eq("stripe_customer", obj.customer).maybeSingle();
        uid = data?.user_id || "";
      }
      if (UUID.test(uid)) {
        // always re-read the subscription from Stripe: messages can arrive out of order
        const sub = type === "customer.subscription.deleted" ? obj : await stripe("subscriptions/" + obj.id).catch(() => obj);
        await saveSub(admin, uid, subState(sub));
      }
    }
  } catch (e) {
    const err = e as { status?: number; message?: string };
    console.error("webhook", type, err?.status, err?.message);
    return new Response("Erreur temporaire", { status: 500 }); // Stripe renverra le message plus tard
  }
  return new Response(JSON.stringify({ received: true }), { headers: { "Content-Type": "application/json" } });
});
