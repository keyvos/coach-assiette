// =====================================================================
// Coach Assiette : rappels de repas (Supabase Edge Function "remind")
// © 2026 Sébastien Bassous (github.com/keyvos) — Tous droits réservés.
// - GET  ?vapid=1      -> clé publique pour s'abonner aux notifications
// - POST {"run":true}  -> appelé toutes les 15 min par Supabase Cron :
//                         envoie les rappels dus (un seul par repas et par jour)
// - POST {"test":true} -> envoie une notification de test à la personne connectée
// Les clés de notification (VAPID) sont créées automatiquement au premier appel
// et rangées dans la table app_secrets (jamais lisible depuis l'application).
// Réglage facultatif : VAPID_SUBJECT (adresse du site ou mailto:)
// =====================================================================
import { createClient } from "jsr:@supabase/supabase-js@2";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...CORS, "Content-Type": "application/json" } });

function serverKey(): string {
  try {
    const all = JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS") || "{}");
    const k = all.default || Object.values(all)[0];
    if (typeof k === "string" && k) return k;
  } catch (_) { /* ignore */ }
  return Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") || "";
}
const admin = createClient(Deno.env.get("SUPABASE_URL")!, serverKey(), { auth: { persistSession: false } });

// ==== crypto (Web Push: RFC 8291 aes128gcm + RFC 8292 VAPID) ====
const enc = new TextEncoder();
function b64u(buf: ArrayBuffer | Uint8Array): string {
  const b = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let s = "";
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function fromB64u(str: string): Uint8Array {
  const pad = "=".repeat((4 - (str.length % 4)) % 4);
  const bin = atob((str + pad).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function concat(...arrs: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(arrs.reduce((n, a) => n + a.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
async function hmac(key: Uint8Array, data: Uint8Array): Promise<Uint8Array> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return new Uint8Array(await crypto.subtle.sign("HMAC", k, data));
}
// deno-lint-ignore no-explicit-any
async function encryptPayload(keys: { p256dh: string; auth: string }, payload: Uint8Array, fixed?: any): Promise<Uint8Array> {
  const uaPub = fromB64u(keys.p256dh);
  const authSecret = fromB64u(keys.auth);
  const as = fixed?.asKeys || await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", as.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", uaPub, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, as.privateKey, 256));
  const prkKey = await hmac(authSecret, shared);
  const ikm = (await hmac(prkKey, concat(enc.encode("WebPush: info\u0000"), uaPub, asPub, new Uint8Array([1])))).slice(0, 32);
  const salt: Uint8Array = fixed?.salt || crypto.getRandomValues(new Uint8Array(16));
  const prk = await hmac(salt, ikm);
  const cek = (await hmac(prk, concat(enc.encode("Content-Encoding: aes128gcm\u0000"), new Uint8Array([1])))).slice(0, 16);
  const nonce = (await hmac(prk, concat(enc.encode("Content-Encoding: nonce\u0000"), new Uint8Array([1])))).slice(0, 12);
  const key = await crypto.subtle.importKey("raw", cek, { name: "AES-GCM" }, false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, concat(payload, new Uint8Array([2]))));
  const header = new Uint8Array(21 + asPub.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = asPub.length;
  header.set(asPub, 21);
  return concat(header, ct);
}
// deno-lint-ignore no-explicit-any
async function vapidHeader(endpoint: string, v: { jwk: any; pub: string }, subject: string): Promise<string> {
  const head = b64u(enc.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const body = b64u(enc.encode(JSON.stringify({ aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject })));
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc.encode(head + "." + body)));
  return "vapid t=" + head + "." + body + "." + b64u(sig) + ", k=" + v.pub;
}
// ==== end crypto ====

// deno-lint-ignore no-explicit-any
async function vapid(): Promise<{ jwk: any; pub: string }> {
  const { data } = await admin.from("app_secrets").select("value").eq("name", "vapid").maybeSingle();
  if (data?.value?.jwk) return data.value;
  const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
  const value = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
  const ins = await admin.from("app_secrets").insert({ name: "vapid", value });
  if (ins.error) {
    const again = await admin.from("app_secrets").select("value").eq("name", "vapid").maybeSingle();
    if (again.data?.value?.jwk) return again.data.value;
    throw ins.error;
  }
  return value;
}

// deno-lint-ignore no-explicit-any
async function sendPush(row: any, msg: Record<string, string>): Promise<number> {
  const v = await vapid();
  const body = await encryptPayload(row.sub.keys, enc.encode(JSON.stringify(msg)));
  const r = await fetch(row.sub.endpoint, {
    method: "POST",
    headers: {
      "TTL": "3600",
      "Urgency": "normal",
      "Content-Encoding": "aes128gcm",
      "Content-Type": "application/octet-stream",
      "Authorization": await vapidHeader(row.sub.endpoint, v, Deno.env.get("VAPID_SUBJECT") || "https://keyvos.github.io/coach-assiette/"),
    },
    body,
  });
  if (r.status === 404 || r.status === 410) await admin.from("push_subs").delete().eq("user_id", row.user_id);
  return r.status;
}

// ---- local time of each person (their own time zone)
function localParts(tz: string, d = new Date()) {
  const f = new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(d)) p[x.type] = x.value;
  const hh = p.hour === "24" ? 0 : Number(p.hour);
  return { day: `${p.year}-${p.month}-${p.day}`, min: hh * 60 + Number(p.minute) };
}
function slotOfLocal(iso: string, tz: string): string {
  const h = localParts(tz, new Date(iso)).min / 60;
  if (h >= 4 && h < 9.5) return "breakfast";
  if (h >= 9.5 && h < 11.5) return "snack10";
  if (h >= 11.5 && h < 15) return "lunch";
  if (h >= 15 && h < 18.5) return "snack16";
  if (h >= 18.5 && h < 22.5) return "dinner";
  return "extra";
}

const MSG: Record<string, { t: string; body: string; water: string; test: string; weigh: string; meal: Record<string, string> }> = {
  fr: { t: "Coach Assiette", body: "Tu as pris {m} ? Une photo et c’est noté 📸", water: "Petite pause hydratation ? Un verre d’eau 💧", test: "Les rappels fonctionnent sur ce téléphone 👍", weigh: "Pesée du matin ⚖️ Si tu le souhaites : à jeun, même tenue, même balance. Ce n’est qu’un repère.",
    meal: { breakfast: "ton petit-déjeuner", snack10: "ta collation de 10 h", lunch: "ton déjeuner", snack16: "ton goûter", dinner: "ton dîner" } },
  en: { t: "Coach Assiette", body: "Did you have {m}? Snap a photo and it’s logged 📸", water: "Time for a water break? A glass of water 💧", test: "Reminders work on this phone 👍", weigh: "Morning weigh-in ⚖️ If you wish: empty stomach, same outfit, same scale. It is only a reference point.",
    meal: { breakfast: "breakfast", snack10: "your 10 am snack", lunch: "lunch", snack16: "your 4 pm snack", dinner: "dinner" } },
  pt: { t: "Coach Assiette", body: "Já tomaste {m}? Uma foto e fica registado 📸", water: "Pausa para hidratar? Um copo de água 💧", test: "Os lembretes funcionam neste telemóvel 👍", weigh: "Pesagem da manhã ⚖️ Se quiseres: em jejum, mesma roupa, mesma balança. É apenas uma referência.",
    meal: { breakfast: "o pequeno-almoço", snack10: "o lanche das 10 h", lunch: "o almoço", snack16: "o lanche", dinner: "o jantar" } },
  es: { t: "Coach Assiette", body: "¿Ya tomaste {m}? Una foto y queda anotado 📸", water: "¿Pausa para hidratarte? Un vaso de agua 💧", test: "Los recordatorios funcionan en este teléfono 👍", weigh: "Pesaje de la mañana ⚖️ Si quieres: en ayunas, misma ropa, misma báscula. Solo es una referencia.",
    meal: { breakfast: "el desayuno", snack10: "el tentempié de las 10", lunch: "la comida", snack16: "la merienda", dinner: "la cena" } },
};
const SKIP: Record<string, string> = { breakfast: "morning", lunch: "noon", dinner: "evening" };
const NOKEY: Record<string, string> = { breakfast: "morning", snack10: "snack10", lunch: "noon", snack16: "snack16", dinner: "evening" };
const WATER: [string, number, number][] = [["water1", 11 * 60, 0.35], ["water2", 16 * 60, 0.7]];
const ML: Record<string, number> = { water: 250, hot: 150, juice: 250, soda: 330 };

async function run() {
  const { data: lr } = await admin.from("app_secrets").select("value").eq("name", "last_run").maybeSingle();
  if (lr?.value?.at && Date.now() - Date.parse(lr.value.at) < 5 * 60 * 1000) return { skipped: true };
  await admin.from("app_secrets").upsert({ name: "last_run", value: { at: new Date().toISOString() } });
  const { data: rows } = await admin.from("push_subs").select("*");
  let sent = 0, checked = 0;
  for (const row of rows || []) {
    try {
      const tz = row.tz || "Europe/Paris";
      const now = localParts(tz);
      const prefs = row.prefs || {};
      const L = MSG[row.lang] || MSG.fr;
      const due: { kind: string; slot?: string; share?: number }[] = [];
      for (const [slot, hhmm] of Object.entries(prefs.meals || {})) {
        const [h, m] = String(hhmm).split(":").map(Number);
        if (!Number.isFinite(h)) continue;
        const at = h * 60 + (m || 0);
        if (now.min >= at && now.min < at + 120) due.push({ kind: slot, slot });
      }
      if (prefs.water) for (const [kind, at, share] of WATER) if (now.min >= at && now.min < at + 120) due.push({ kind, share });
      if (prefs.weigh) {
        const [h, m] = String(prefs.weigh).split(":").map(Number);
        const at = h * 60 + (m || 0);
        if (Number.isFinite(at) && now.min >= at && now.min < at + 120) due.push({ kind: "weigh" });
      }
      if (!due.length) continue;
      const { data: logs } = await admin.from("push_log").select("kind").eq("user_id", row.user_id).eq("day", now.day);
      const done = new Set((logs || []).map((x: { kind: string }) => x.kind));
      const todo = due.filter((d) => !done.has(d.kind));
      if (!todo.length) continue;
      const { data: kv } = await admin.from("kv").select("key,value").eq("user_id", row.user_id).in("key", ["day-" + now.day, "profile", "body"]);
      const day = (kv || []).find((x: { key: string }) => x.key === "day-" + now.day)?.value || {};
      const nm = (kv || []).find((x: { key: string }) => x.key === "profile")?.value?.noMeal || {};
      const body = (kv || []).find((x: { key: string }) => x.key === "body")?.value || {};
      for (const d of todo) {
        checked++;
        let msg: Record<string, string> | null = null;
        if (d.kind === "weigh") {
          // deno-lint-ignore no-explicit-any
          const weighed = (body.entries || []).some((e: any) => e.wi && e.date === now.day);
          if (!weighed) msg = { title: L.t, body: L.weigh, tag: "weigh", url: "./?slot=weigh" };
        } else if (d.slot) {
          // deno-lint-ignore no-explicit-any
          const eaten = (day.meals || []).some((m: any) => (m.slot || slotOfLocal(m.at, tz)) === d.slot);
          const skipped = SKIP[d.slot] && (day.skipped || []).includes(SKIP[d.slot]);
          if (!eaten && !skipped && !nm[NOKEY[d.slot]]) msg = { title: L.t, body: L.body.replace("{m}", L.meal[d.slot] || d.slot), tag: "meal-" + d.slot, url: "./?slot=" + d.slot };
        } else {
          // deno-lint-ignore no-explicit-any
          const ml = (day.drinks || []).filter((x: any) => x.type !== "alcohol").reduce((a: number, x: any) => a + (ML[x.type] || 250), 0);
          if (ml < (Number(prefs.goal) || 1500) * (d.share || 0.5)) msg = { title: L.t, body: L.water, tag: "water", url: "./?slot=water" };
        }
        await admin.from("push_log").insert({ user_id: row.user_id, day: now.day, kind: d.kind });
        if (msg) {
          const st = await sendPush(row, msg);
          if (st >= 200 && st < 300) sent++;
        }
      }
    } catch (e) {
      console.error("remind", row.user_id, e);
    }
  }
  return { sent, checked };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  try {
    const url = new URL(req.url);
    if (req.method === "GET" && url.searchParams.get("vapid")) return reply({ publicKey: (await vapid()).pub });
    if (req.method !== "POST") return reply({ error: "Méthode non autorisée" }, 405);
    const body = await req.json().catch(() => ({}));
    if (body.run) return reply(await run());
    if (body.test) {
      const token = (req.headers.get("Authorization") || "").replace(/^Bearer\s+/i, "");
      const { data: who } = await admin.auth.getUser(token);
      if (!who?.user) return reply({ error: "Session invalide" }, 401);
      const { data: row } = await admin.from("push_subs").select("*").eq("user_id", who.user.id).maybeSingle();
      if (!row) return reply({ error: "Aucun abonnement" }, 404);
      const L = MSG[row.lang] || MSG.fr;
      return reply({ status: await sendPush(row, { title: L.t, body: L.test, tag: "test", url: "./" }) });
    }
    return reply({ error: "Requête inconnue" }, 400);
  } catch (e) {
    console.error(e);
    return reply({ error: "Erreur serveur" }, 500);
  }
});
