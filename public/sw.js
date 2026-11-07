/* No fetch handler or offline cache: appointments and letters stay out of caches. */
const APPOINTMENTS_URL = "/?screen=appointments";

function notificationText(value, limit, fallback) {
  return typeof value === "string"
    ? value.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, limit) || fallback
    : fallback;
}

self.addEventListener("push", (event) => {
  let payload = {};
  try {
    const parsed = event.data?.json();
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) payload = parsed;
  } catch {
    // Even an unreadable push must produce a visible notification in Safari.
  }
  event.waitUntil(self.registration.showNotification(
    notificationText(payload.title, 100, "ਸਾਥੀ · ਮੁਲਾਕਾਤ ਦੀ ਯਾਦ"),
    {
      body: notificationText(payload.body, 600, "ਤੁਹਾਡੀ ਮੁਲਾਕਾਤ ਆ ਰਹੀ ਹੈ। ਵੇਰਵੇ ਵੇਖਣ ਲਈ ਸਾਥੀ ਖੋਲ੍ਹੋ।"),
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      tag: notificationText(payload.tag, 100, "saathi-appointment"),
      // Always open our appointment screen; push payloads cannot choose a URL.
      data: { url: APPOINTMENTS_URL },
    },
  ));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL(APPOINTMENTS_URL, self.location.origin).href;
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      try {
        const opened = await client.navigate(target);
        if (opened) return await opened.focus();
      } catch {
        // A closing tab can race notification activation; try the next window.
      }
    }
    return self.clients.openWindow(target);
  })());
});
