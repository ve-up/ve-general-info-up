/* VE General Information – service worker (offline + background sending) */
var VERSION = 've-geninfo-v1.8.0';
var FILES = ['./', './index.html', './manifest.json', './icon-192.png', './icon-512.png'];

self.addEventListener('install', function (e) {
  // cache:'reload' = always download fresh files from the server, never a copy the browser kept earlier
  e.waitUntil(caches.open(VERSION).then(function (c) {
    return c.addAll(FILES.map(function (f) { return new Request(f, { cache: 'reload' }); }));
  }));
});
self.addEventListener('activate', function (e) {
  e.waitUntil(caches.keys().then(function (ks) {
    return Promise.all(ks.filter(function (k) { return k !== VERSION; }).map(function (k) { return caches.delete(k); }));
  }).then(function () { return self.clients.claim(); }));
});
self.addEventListener('message', function (e) { if (e.data === 'skip') self.skipWaiting(); });

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;          // Apps Script calls go straight to network
  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(function (r) {
      return r || fetch(req);
    }));
    return;
  }
  e.respondWith(caches.match(req).then(function (r) { return r || fetch(req); }));
});

/* ---- background sending (Chrome on Android: runs when internet returns, even if app is closed) ---- */
function openDb() {
  return new Promise(function (res, rej) {
    var r = indexedDB.open('ve_geninfo', 1);
    r.onupgradeneeded = function () {
      var d = r.result;
      if (!d.objectStoreNames.contains('entries')) d.createObjectStore('entries', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('meta')) d.createObjectStore('meta');
    };
    r.onsuccess = function () { res(r.result); };
    r.onerror = function () { rej(r.error); };
  });
}
function getAll(db, store) {
  return new Promise(function (res) {
    var out = [], x = db.transaction(store, 'readonly'), c = x.objectStore(store).openCursor();
    c.onsuccess = function () { var cu = c.result; if (cu) { out.push({ k: cu.key, v: cu.value }); cu.continue(); } };
    x.oncomplete = function () { res(out); }; x.onerror = function () { res(out); };
  });
}
function put(db, store, v, k) {
  return new Promise(function (res) {
    var x = db.transaction(store, 'readwrite');
    if (k !== undefined) x.objectStore(store).put(v, k); else x.objectStore(store).put(v);
    x.oncomplete = res; x.onerror = res;
  });
}
function stamp() {
  var d = new Date(), z = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + z(d.getMonth() + 1) + '-' + z(d.getDate()) + ' ' + z(d.getHours()) + ':' + z(d.getMinutes()) + ':' + z(d.getSeconds());
}
function sendQueue() {
  return openDb().then(function (db) {
    return Promise.all([getAll(db, 'entries'), getAll(db, 'meta')]).then(function (r) {
      var meta = {}; r[1].forEach(function (m) { meta[m.k] = m.v; });
      var url = (meta.scriptUrl || meta.scriptUrlDefault || '').trim();
      var q = r[0].map(function (x) { return x.v; }).filter(function (e) { return e.status === 'queued' && e.payload; });
      if (!url || !q.length) return 0;
      var sent = 0, failed = 0, p = Promise.resolve();
      q.forEach(function (e) {
        p = p.then(function () {
          return fetch(url, { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify({ action: 'submit', record: e.payload }), redirect: 'follow' })
            .then(function (res) { return res.json(); })
            .then(function (j) {
              if (j && j.ok) { e.status = 'sent'; e.sentAt = stamp(); sent++; return put(db, 'entries', e); }
              failed++;
            }).catch(function () { failed++; });
        });
      });
      return p.then(function () {
        if (sent) put(db, 'meta', stamp(), 'lastSync');
        return self.clients.matchAll().then(function (cs) { cs.forEach(function (c) { c.postMessage('synced'); }); });
      }).then(function () { if (failed) throw new Error('retry'); return sent; });
    });
  });
}
self.addEventListener('sync', function (e) {
  if (e.tag === 'send-queue') e.waitUntil(sendQueue());
});
