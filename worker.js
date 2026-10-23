/* My Race – Web Push worker (Cloudflare Workers, module syntax)
   Bindings cần có: KV (KV namespace), API_KEY (secret).  Tùy chọn: VAPID_SUB (https:// hoặc mailto:).
   Cron Trigger: * * * * *  (mỗi phút) */
const TE = new TextEncoder();
const B = {
  enc(buf) { let s = ""; for (const x of new Uint8Array(buf)) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""); },
  dec(str) { str = str.replace(/-/g, "+").replace(/_/g, "/"); while (str.length % 4) str += "="; const s = atob(str), a = new Uint8Array(s.length); for (let i = 0; i < s.length; i++) a[i] = s.charCodeAt(i); return a; }
};
const cat = (...a) => { let n = 0; for (const x of a) n += x.length; const o = new Uint8Array(n); let p = 0; for (const x of a) { o.set(x, p); p += x.length; } return o; };
async function hkdf(salt, ikm, info, len) {
  const k = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, k, len * 8));
}

/* ---- khóa VAPID: tự tạo lần đầu, lưu trong KV ---- */
let VAPID = null;
async function vapid(env) {
  if (VAPID) return VAPID;
  let rec = await env.KV.get("vapid", "json");
  if (!rec) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    rec = { priv: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: B.enc(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.KV.put("vapid", JSON.stringify(rec));
  }
  const key = await crypto.subtle.importKey("jwk", rec.priv, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  return (VAPID = { key, pub: rec.pub });
}
async function jwt(env, aud) {
  const v = await vapid(env);
  const h = B.enc(TE.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const p = B.enc(TE.encode(JSON.stringify({ aud, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: env.VAPID_SUB || "https://haviethung1088-lgtm.github.io/HMSub140/" })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, v.key, TE.encode(h + "." + p));
  return h + "." + p + "." + B.enc(sig);
}

/* ---- mã hóa nội dung theo RFC 8291 (aes128gcm) ---- */
async function encrypt(sub, text) {
  const ua = B.dec(sub.keys.p256dh), auth = B.dec(sub.keys.auth);
  const kp = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"]);
  const asPub = new Uint8Array(await crypto.subtle.exportKey("raw", kp.publicKey));
  const uaKey = await crypto.subtle.importKey("raw", ua, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const secret = new Uint8Array(await crypto.subtle.deriveBits({ name: "ECDH", public: uaKey }, kp.privateKey, 256));
  const ikm = await hkdf(auth, secret, cat(TE.encode("WebPush: info\0"), ua, asPub), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, TE.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, TE.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, key, cat(TE.encode(text), new Uint8Array([2]))));
  return cat(salt, new Uint8Array([0, 0, 16, 0, 65]), asPub, ct);
}
async function push(env, sub, obj) {
  const body = await encrypt(sub, JSON.stringify(obj));
  const v = await vapid(env), t = await jwt(env, new URL(sub.endpoint).origin);
  const r = await fetch(sub.endpoint, { method: "POST", headers: { Authorization: "vapid t=" + t + ", k=" + v.pub, "Content-Encoding": "aes128gcm", "Content-Type": "application/octet-stream", TTL: "3600", Urgency: "high" }, body });
  return r.status;
}

/* ---- nội dung nhắc ---- */
async function weather(r, loc) {
  try {
    const m = (r.am || "04:45").split(":").map(Number), hr = Math.floor((m[0] * 60 + m[1] + 15) / 60) % 24;
    const u = "https://api.open-meteo.com/v1/forecast?latitude=" + (r.lat || 21.3227) + "&longitude=" + (r.lon || 105.4019) + "&hourly=temperature_2m,precipitation_probability&timezone=auto&forecast_days=1";
    const j = await (await fetch(u, { signal: AbortSignal.timeout(3000) })).json();
    return hr + "h: " + Math.round(j.hourly.temperature_2m[hr]) + "°, mưa " + Math.round(j.hourly.precipitation_probability[hr] || 0) + "%";
  } catch (e) { return ""; }
}
async function build(kind, r, ymd, loc) {
  if (kind === "am") {
    const d = r.days && r.days[ymd]; if (!d) return null;
    const w = await weather(r, loc);
    return { title: "Hôm nay · " + d.t, body: (w ? w + " · " : "") + d.s, tag: "am-" + ymd, url: "./" };
  }
  const tm = new Date(loc.getTime() + 864e5).toISOString().slice(0, 10), d = r.days && r.days[tm];
  if (!d) return null;
  return { title: "Ngày mai · " + d.t, body: d.s + ". Chuẩn bị đồ, ăn nhẹ và ngủ sớm.", tag: "pm-" + tm, url: "./" };
}
async function run(env, now = Date.now()) {
  const subs = (await env.KV.get("subs", "json")) || {}; let dirty = false;
  for (const id of Object.keys(subs)) {
    const r = subs[id], loc = new Date(now + (r.tz == null ? 420 : r.tz) * 6e4);
    const ymd = loc.toISOString().slice(0, 10), mins = loc.getUTCHours() * 60 + loc.getUTCMinutes();
    r.last = r.last || {};
    for (const kind of ["am", "pm"]) {
      if (!r[kind]) continue;
      const p = r[kind].split(":").map(Number), tm = p[0] * 60 + p[1];
      if (mins >= tm && mins < tm + 30 && r.last[kind] !== ymd) {
        const msg = await build(kind, r, ymd, loc);
        if (!msg) { r.last[kind] = ymd; dirty = true; continue; }
        let st = 0; try { st = await push(env, r.sub, msg); } catch (e) {}
        if (st === 404 || st === 410) { delete subs[id]; dirty = true; break; }
        if (st >= 200 && st < 300) { r.last[kind] = ymd; dirty = true; }
      }
    }
  }
  if (dirty) await env.KV.put("subs", JSON.stringify(subs));
}

/* ---- HTTP ---- */
const sid = async (ep) => B.enc(await crypto.subtle.digest("SHA-256", TE.encode(ep))).slice(0, 22);
function same(a, b) { if (a.length !== b.length) return false; let x = 0; for (let i = 0; i < a.length; i++) x |= a.charCodeAt(i) ^ b.charCodeAt(i); return x === 0; }
export default {
  async fetch(req, env) {
    const url = new URL(req.url), cors = { "Access-Control-Allow-Origin": env.ALLOW_ORIGIN || "*", "Access-Control-Allow-Headers": "content-type,x-api-key", "Access-Control-Allow-Methods": "GET,POST,OPTIONS" };
    const J = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname === "/" || url.pathname === "/health") return J({ ok: true, name: "my-race-push" });
    if (!env.API_KEY) return J({ error: "Chưa đặt biến API_KEY trong Worker" }, 500);
    if (!same(req.headers.get("x-api-key") || "", env.API_KEY)) return J({ error: "Sai mã bí mật" }, 401);
    try {
      if (url.pathname === "/config" && req.method === "GET") return J({ pub: (await vapid(env)).pub });
      if (req.method !== "POST") return J({ error: "not found" }, 404);
      const b = await req.json(), subs = (await env.KV.get("subs", "json")) || {};
      if (url.pathname === "/subscribe") {
        const s = b.sub; if (!s || !s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return J({ error: "subscription không hợp lệ" }, 400);
        const id = await sid(s.endpoint), old = subs[id];
        subs[id] = { sub: s, am: b.am || "", pm: b.pm || "", lat: b.lat, lon: b.lon, tz: b.tz, days: b.days || {}, name: b.name || "", last: old ? old.last : {} };
        if (Object.keys(subs).length > 5) return J({ error: "quá nhiều thiết bị" }, 400);
        await env.KV.put("subs", JSON.stringify(subs)); return J({ ok: true });
      }
      if (url.pathname === "/unsubscribe") { delete subs[await sid(b.endpoint || "")]; await env.KV.put("subs", JSON.stringify(subs)); return J({ ok: true }); }
      if (url.pathname === "/test") {
        const id = await sid(b.endpoint || ""), r = subs[id]; if (!r) return J({ error: "Thiết bị chưa đăng ký" }, 404);
        const status = await push(env, r.sub, { title: "My Race", body: "Thông báo đẩy đã hoạt động.", tag: "test", url: "./" });
        if (status === 404 || status === 410) { delete subs[id]; await env.KV.put("subs", JSON.stringify(subs)); return J({ status, error: "Đăng ký thiết bị đã hết hạn. Hãy bật nhắc lại trên thiết bị." }); }
        return J({ status, error: status < 200 || status >= 300 ? "Dịch vụ thông báo từ chối yêu cầu (HTTP " + status + ")." : undefined });
      }
    } catch (e) { return J({ error: String(e && e.message || e) }, 500); }
    return J({ error: "not found" }, 404);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};
export { run, encrypt };
