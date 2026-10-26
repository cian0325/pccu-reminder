const CACHE = "pccu-reminder-v2";
const ASSETS = ["./", "index.html", "style.css", "app.js", "data.js", "manifest.webmanifest", "icons/icon-192.png", "icons/icon-512.png"];

self.addEventListener("install", (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener("activate", (e) => {
  e.waitUntil(
    caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

// 離線優先：靜態檔先讀快取，API 一律走網路
self.addEventListener("fetch", (e) => {
  const url = new URL(e.request.url);
  if (e.request.method !== "GET" || url.pathname.startsWith("/api/")) return;
  e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request)));
});

// 後端 Web Push 送來的推播
self.addEventListener("push", (e) => {
  let p = { title: "課輔提醒", body: "" };
  try { p = { ...p, ...e.data.json() }; } catch (_) { if (e.data) p.body = e.data.text(); }
  e.waitUntil(self.registration.showNotification(p.title, {
    body: p.body, tag: p.tag, icon: "icons/icon-192.png", badge: "icons/icon-192.png", data: { url: p.url || "./" }
  }));
});

self.addEventListener("notificationclick", (e) => {
  e.notification.close();
  e.waitUntil(clients.matchAll({ type: "window" }).then((list) => {
    for (const c of list) if ("focus" in c) return c.focus();
    return clients.openWindow((e.notification.data && e.notification.data.url) || "./");
  }));
});
