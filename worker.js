/* My Race – Web Push worker dùng chung.
   Cloudflare bindings: KV (KV namespace); APP_ORIGIN là biến tùy chọn.
   Secret tùy chọn: VAPID_SUB. Cron Trigger: * * * * * (mỗi phút). */
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

/* ---- lịch nhắc theo giờ địa phương từng thiết bị ---- */
function ymd(d) { return d.toISOString().slice(0, 10); }
function label(d) { return d && (d.t || d.s) || ""; }
async function weatherBrief(env, loc, dateKey) {
  if (!loc || !Number.isFinite(Number(loc.lat)) || !Number.isFinite(Number(loc.lon))) return "";
  const lat = Math.round(Number(loc.lat) * 100) / 100, lon = Math.round(Number(loc.lon) * 100) / 100;
  const cacheKey = "weather:" + dateKey + ":" + lat.toFixed(2) + ":" + lon.toFixed(2);
  try {
    const cached = await env.KV.get(cacheKey, "json");
    if (cached && cached.text) return cached.text;
    const u = new URL("https://api.open-meteo.com/v1/forecast");
    u.searchParams.set("latitude", String(lat)); u.searchParams.set("longitude", String(lon));
    u.searchParams.set("daily", "weather_code,temperature_2m_min,temperature_2m_max,precipitation_probability_max,wind_speed_10m_max");
    u.searchParams.set("forecast_days", "1"); u.searchParams.set("timezone", "auto");
    const res = await fetch(u.toString()); if (!res.ok) return "";
    const j = await res.json(), d = j.daily || {};
    const code = Number(d.weather_code && d.weather_code[0]), min = Number(d.temperature_2m_min && d.temperature_2m_min[0]);
    const max = Number(d.temperature_2m_max && d.temperature_2m_max[0]), rain = Number(d.precipitation_probability_max && d.precipitation_probability_max[0]);
    const wind = Number(d.wind_speed_10m_max && d.wind_speed_10m_max[0]);
    if (![min, max].every(Number.isFinite)) return "";
    let sky = "trời nhiều mây";
    if (code === 0) sky = "trời quang"; else if (code === 1) sky = "ít mây"; else if (code === 2) sky = "mây rải rác";
    else if (code === 45 || code === 48) sky = "sương mù"; else if (code >= 51 && code <= 57) sky = "mưa phùn";
    else if (code >= 61 && code <= 67) sky = "mưa"; else if (code >= 71 && code <= 77) sky = "có tuyết";
    else if (code >= 80 && code <= 82) sky = "mưa rào"; else if (code >= 85 && code <= 86) sky = "mưa tuyết";
    else if (code >= 95) sky = "dông";
    const text = sky + ", " + Math.round(min) + "–" + Math.round(max) + "°C" +
      (Number.isFinite(rain) ? " · mưa " + Math.round(rain) + "%" : "") +
      (Number.isFinite(wind) ? " · gió tối đa " + Math.round(wind) + " km/h" : "");
    await env.KV.put(cacheKey, JSON.stringify({ text }), { expirationTtl: 3600 });
    return text;
  } catch (_) { return ""; }
}
async function build(kind, today, tomorrow, weather) {
  const d = kind === "eve" ? tomorrow : today;
  if (kind !== "hello" && !d) return null;
  if (kind === "eve") return { title: d.race ? "Ngày mai thi đấu 🏁" : "Nhắc buổi tập ngày mai 🏃", body: label(d) + " · Chuẩn bị trang phục, giày và nghỉ ngơi tốt nhé!", tag: "eve-" + ymd(tomorrow._date), url: "./" };
  if (kind === "today") return { title: d.race ? "Hôm nay thi đấu 🏁" : "Hôm nay có buổi tập 🏃", body: label(d), tag: "today-" + ymd(today._date), url: "./" };
  let body = today ? (today.race ? "Hôm nay là ngày thi đấu. Chúc anh bứt phá và tận hưởng đường chạy!" : "Hôm nay có lịch " + (label(today) || "tập luyện") + ". Chúc anh khởi đầu ngày mới đầy năng lượng!") : "Chúc anh một ngày mới nhiều năng lượng và luôn vui với mỗi bước chạy!";
  if (weather) body += " Thời tiết: " + weather + ".";
  return { title: "Chào ngày mới ☀️", body, tag: "hello-" + ymd(today._date), url: "./" };
}
async function run(env, now = Date.now()) {
  const subs = (await env.KV.get("subs", "json")) || {}; let dirty = false;
  for (const id of Object.keys(subs)) {
    const r = subs[id], local = new Date(now + (Number.isFinite(r.tz) ? r.tz : 420) * 60000);
    const key = ymd(local), mins = local.getUTCHours() * 60 + local.getUTCMinutes();
    const today = Object.assign({}, (r.days || {})[key], { _date: local });
    const nextDate = new Date(local.getTime() + 86400000), nextKey = ymd(nextDate);
    const tomorrow = Object.assign({}, (r.days || {})[nextKey], { _date: nextDate });
    r.last = r.last || {};
    for (const [kind, target, dateKey] of [["eve",1200,nextKey],["today",0,key],["hello",480,key]]) {
      if (mins < target || mins >= target + 2 || r.last[kind] === dateKey) continue;
      const wx = kind === "hello" && r.weatherLoc ? await weatherBrief(env, r.weatherLoc, key) : "";
      const msg = await build(kind, today, tomorrow, wx);
      if (!msg) { r.last[kind] = dateKey; dirty = true; continue; }
      let status = 0; try { status = await push(env, r.sub, msg); } catch (_) {}
      if (status === 404 || status === 410) { delete subs[id]; dirty = true; break; }
      if (status >= 200 && status < 300) { r.last[kind] = dateKey; dirty = true; }
    }
  }
  if (dirty) await env.KV.put("subs", JSON.stringify(subs));
}

/* ---- API dùng chung, CORS giới hạn vào GitHub Pages và giới hạn tần suất ---- */
const sid = async (ep) => B.enc(await crypto.subtle.digest("SHA-256", TE.encode(ep))).slice(0, 22);
function allowedOrigin(req, env) { const o = req.headers.get("Origin"); return !!o && o === (env.APP_ORIGIN || "https://haviethung1088-lgtm.github.io"); }
function response(obj, status, origin) { const h = { "Content-Type":"application/json", "Cache-Control":"no-store" }; if (origin) { h["Access-Control-Allow-Origin"] = origin; h.Vary = "Origin"; } return new Response(JSON.stringify(obj), { status, headers:h }); }
async function limited(req, env, route, max) {
  const ip = req.headers.get("CF-Connecting-IP") || "unknown", hash = B.enc(await crypto.subtle.digest("SHA-256", TE.encode(ip))).slice(0,24), key = "rl:" + route + ":" + hash;
  const n = Number(await env.KV.get(key) || 0); if (n >= max) return false;
  await env.KV.put(key, String(n + 1), { expirationTtl:60 }); return true;
}
export default {
  async fetch(req, env) {
    const url = new URL(req.url), origin = req.headers.get("Origin"), allowed = allowedOrigin(req, env);
    const cors = allowed ? { "Access-Control-Allow-Origin":origin, "Access-Control-Allow-Headers":"content-type", "Access-Control-Allow-Methods":"GET,POST,OPTIONS", Vary:"Origin" } : {};
    if (req.method === "OPTIONS") return new Response(null, { status:allowed ? 204 : 403, headers:cors });
    if (url.pathname === "/" || url.pathname === "/health") return response({ ok:true, name:"my-race-push" }, 200, allowed ? origin : null);
    if (!allowed) return response({ error:"Nguồn truy cập không được phép." }, 403);
    if (!env.KV) return response({ error:"Worker chưa được gắn KV namespace (binding KV)." }, 500, origin);
    try {
      if (url.pathname === "/config" && req.method === "GET") return response({ pub:(await vapid(env)).pub }, 200, origin);
      if (req.method !== "POST") return response({ error:"not found" }, 404, origin);
      const b = await req.json(), route = url.pathname.slice(1), max = route === "subscribe" ? 30 : 60;
      if (!(await limited(req, env, route, max))) return response({ error:"Thao tác quá nhanh. Hãy thử lại sau một phút." }, 429, origin);
      const subs = (await env.KV.get("subs", "json")) || {};
      if (url.pathname === "/subscribe") {
        const s = b.sub; if (!s || !s.endpoint || !/^https:\/\//.test(s.endpoint) || !s.keys || !s.keys.p256dh || !s.keys.auth) return response({ error:"subscription không hợp lệ" }, 400, origin);
        if (!b.days || typeof b.days !== "object" || Array.isArray(b.days) || !Number.isFinite(Number(b.tz)) || Math.abs(Number(b.tz)) > 840) return response({ error:"Lịch hoặc múi giờ không hợp lệ." }, 400, origin);
        const id = await sid(s.endpoint), old = subs[id]; if (!old && Object.keys(subs).length >= 1000) return response({ error:"Dịch vụ đang đủ số thiết bị đăng ký." }, 503, origin);
        let weatherLoc = old && old.weatherLoc || null;
        if (Object.prototype.hasOwnProperty.call(b, "weatherLoc")) {
          if (b.weatherLoc === null) weatherLoc = null;
          else {
            const lat = Number(b.weatherLoc && b.weatherLoc.lat), lon = Number(b.weatherLoc && b.weatherLoc.lon);
            if (!Number.isFinite(lat) || lat < -90 || lat > 90 || !Number.isFinite(lon) || lon < -180 || lon > 180) return response({ error:"Tọa độ thời tiết không hợp lệ." }, 400, origin);
            weatherLoc = { lat:Math.round(lat * 100) / 100, lon:Math.round(lon * 100) / 100 };
          }
        }
        subs[id] = { sub:s, days:b.days, tz:Number(b.tz), name:String(b.name || "").slice(0,80), weatherLoc, last:old ? old.last : {} };
        await env.KV.put("subs", JSON.stringify(subs)); return response({ ok:true }, 200, origin);
      }
      if (url.pathname === "/unsubscribe") { if (b.endpoint) delete subs[await sid(b.endpoint)]; await env.KV.put("subs", JSON.stringify(subs)); return response({ ok:true }, 200, origin); }
      if (url.pathname === "/test") {
        const id = await sid(b.endpoint || ""), r = subs[id]; if (!r) return response({ error:"Thiết bị chưa đăng ký" }, 404, origin);
        const status = await push(env, r.sub, { title:"My Race", body:"Thông báo đẩy đã hoạt động.", tag:"test", url:"./" });
        if (status === 404 || status === 410) { delete subs[id]; await env.KV.put("subs", JSON.stringify(subs)); return response({ status, error:"Đăng ký thiết bị đã hết hạn. Hãy bật nhắc lại trên thiết bị." }, 200, origin); }
        return response({ status, error:status < 200 || status >= 300 ? "Dịch vụ thông báo từ chối yêu cầu (HTTP " + status + ")." : undefined }, 200, origin);
      }
    } catch (e) { return response({ error:String(e && e.message || e) }, 500, origin); }
    return response({ error:"not found" }, 404, origin);
  },
  async scheduled(event, env, ctx) { ctx.waitUntil(run(env)); }
};
export { run, encrypt };
