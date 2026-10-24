/* My Race – Service Worker: offline + Web Push */
var V = "myrace-v104";
/* Ảnh bài bổ trợ được lưu vào cache khi người dùng mở bài; không tải cả bộ khi cài app. */
var ASSETS = ["./", "index.html", "push-config.js", "manifest.webmanifest", "apple-touch-icon-v1-2-72.png", "icon-192-v1-2-72.png", "icon-512-v1-2-72.png", "assets/myrace-logo.png", "assets/optimus-head.jpg", "assets/bumblebee-head.jpg", "assets/kirito-head.png", "assets/ironman-hero.jpg", "assets/avengers-team.jpg", "assets/naruto-banner.webp", "assets/chelsea-banner.jpg", "assets/jujutsu-banner.jpg", "assets/myrace-icon.png", "assets/myrace-wordmark.png", "assets/myrace-wordmark-only.png", "assets/myrace-tagline.png", "assets/myrace-banner.png"];

self.addEventListener("install", function (e) {
  e.waitUntil(caches.open(V).then(function (c) { return c.addAll(ASSETS); }).catch(function () {}).then(function () { return self.skipWaiting(); }));
});
self.addEventListener("activate", function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k.indexOf("myrace-") === 0 && k !== V; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
/* Dùng bản đã lưu trước, tải bản mới ngầm để app mở nhanh khi mạng yếu. */
self.addEventListener("fetch", function (e) {
  var r = e.request;
  var u = new URL(r.url);
  if (r.method !== "GET" || u.origin !== self.location.origin) return;
  /* version.json luôn đi thẳng ra mạng để biết chính xác có bản mới hay không (mất mạng thì báo lỗi, không dùng bản cũ) */
  if (/\/version\.json$/.test(u.pathname)) return;
  function network() {
    return fetch(r).then(function (res) {
      if (res && res.ok) return caches.open(V).then(function (c) { return c.put(r, res.clone()).then(function () { return res; }); });
      return res;
    }).catch(function () { return null; });
  }
  /* cache:reload được dùng chủ động khi app phát hiện bản mới; cập nhật cache trước khi tải lại trang. */
  if (r.cache === "reload") {
    /* Không trả cache cũ trong luồng cập nhật: nếu mạng lỗi, để fetch thất bại để app báo và không tải lại nhầm bản. */
    e.respondWith(fetch(r).then(function (res) {
      if (!res || !res.ok) throw new Error("Update fetch failed");
      return caches.open(V).then(function (c) { return c.put(r, res.clone()).then(function () { return res; }); });
    }));
    return;
  }
  var fresh = network();
  e.respondWith(caches.match(r).then(function (cached) {
    if (cached) return cached;
    return fresh.then(function (res) { return res || caches.match("./"); });
  }));
  e.waitUntil(fresh.then(function () {}));
});

/* Nhận thông báo đẩy từ Worker */
self.addEventListener("push", function (e) {
  var d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil(self.registration.showNotification(d.title || "My Race", {
    body: d.body || "",
    tag: d.tag || "myrace",
    icon: "apple-touch-icon-v1-2-72.png",
    badge: "apple-touch-icon-v1-2-72.png",
    data: { url: d.url || "./" }
  }));
});
self.addEventListener("notificationclick", function (e) {
  e.notification.close();
  var u = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(function (cs) {
    for (var i = 0; i < cs.length; i++) if ("focus" in cs[i]) return cs[i].focus();
    return self.clients.openWindow(u);
  }));
});
