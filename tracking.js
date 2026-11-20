'use strict';
// =====================================================================
// J HABER — Etkinlik Günlüğü (Excel) ve Haber Takip Excel'i veri deposu
// Ana veritabanından (central-db.json) AYRI dosyalarda tutulur; böylece her
// istekte büyük kayıtlar okunmaz ve mevcut sistem yavaşlamaz.
// =====================================================================
const fs = require('fs');
const path = require('path');
const central = require('./central-db');

const MAX_ACTIVITY = 50000;
const MAX_NEWS_TRACK = 50000;

function dataDir() {
  try { return central.getCentralDir(); } catch (_) { return path.join(__dirname, 'data'); }
}

function makeStore(fileName, max) {
  let cache = null;
  let timer = null;
  const file = () => path.join(dataDir(), fileName);

  function load() {
    if (cache) return cache;
    try {
      const raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
      cache = Array.isArray(raw) ? raw : [];
    } catch (_) {
      cache = [];
    }
    return cache;
  }

  function flushNow() {
    clearTimeout(timer);
    timer = null;
    if (!cache) return;
    const fp = file();
    try {
      const tmp = fp + '.tmp.' + process.pid;
      fs.writeFileSync(tmp, JSON.stringify(cache), 'utf8');
      fs.renameSync(tmp, fp);
    } catch (_) {
      try { fs.writeFileSync(fp, JSON.stringify(cache), 'utf8'); } catch (_) {}
    }
  }

  function save() {
    if (timer) return;
    timer = setTimeout(flushNow, 1500);
  }

  function trim() {
    const arr = load();
    if (arr.length > max) arr.length = max;
  }

  return { load, save, flushNow, trim, replace(arr) { cache = Array.isArray(arr) ? arr : []; } };
}

const activityStore = makeStore('activity-log.json', MAX_ACTIVITY);
const newsStore = makeStore('news-tracker.json', MAX_NEWS_TRACK);

function uid(prefix) {
  return prefix + '_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 7);
}

function clip(v, n) {
  return String(v == null ? '' : v).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
}

function hostOf(u) {
  try { return new URL(u).hostname.replace(/^www\./, ''); } catch (_) { return ''; }
}

function cleanUrl(u) {
  const s = clip(u, 2000);
  return /^https?:\/\//i.test(s) ? s : '';
}

const ACTIVITY_TYPES = new Set([
  'screenshot_news', 'screenshot_tweet', 'screenshot_x_detail', 'link_open', 'tweet_open', 'search_open'
]);

// ---------------------------------------------------------------------
// Etkinlik Günlüğü
// ---------------------------------------------------------------------
function addActivity(user, ev, ip) {
  const type = ACTIVITY_TYPES.has(ev.type) ? ev.type : 'link_open';
  const url = cleanUrl(ev.url);
  const at = Number(ev.at) > 0 && Number(ev.at) <= Date.now() + 60000 ? Number(ev.at) : Date.now();
  const rec = {
    id: uid('act'),
    time: at,
    userId: user.id,
    username: user.username,
    fullName: user.fullName || '',
    type,
    title: clip(ev.title, 400),
    author: clip(ev.author, 120),
    url,
    source: clip(ev.source, 120) || hostOf(url),
    detail: clip(ev.detail, 400),
    ip: clip(ip, 64)
  };
  const arr = activityStore.load();
  arr.unshift(rec);
  activityStore.trim();
  activityStore.save();
  return rec;
}

function listActivity(q = {}) {
  let arr = activityStore.load();
  const since = Number(q.since) || 0;
  const until = Number(q.until) || 0;
  const user = clip(q.username, 80).toLowerCase();
  const type = clip(q.type, 40);
  const text = clip(q.q, 120).toLowerCase();
  if (since || until || user || type || text) {
    arr = arr.filter(r => {
      if (since && r.time < since) return false;
      if (until && r.time > until) return false;
      if (user && r.username.toLowerCase() !== user) return false;
      if (type && r.type !== type) return false;
      if (text && !(`${r.username} ${r.title} ${r.url} ${r.author} ${r.source} ${r.detail}`.toLowerCase().includes(text))) return false;
      return true;
    });
  }
  const total = arr.length;
  const limit = Math.min(Math.max(Number(q.limit) || 1000, 1), 50000);
  return { total, items: arr.slice(0, limit) };
}

function clearActivity(beforeTs) {
  const arr = activityStore.load();
  if (beforeTs) {
    const keep = arr.filter(r => r.time >= beforeTs);
    activityStore.replace(keep);
  } else {
    activityStore.replace([]);
  }
  activityStore.flushNow();
}

// ---------------------------------------------------------------------
// Haber Takip Excel'i
// ---------------------------------------------------------------------
function sanitizeNews(body, user, existing) {
  const url = cleanUrl(body.url);
  const sharedAt = Number(body.sharedAt) > 0 ? Number(body.sharedAt) : (existing ? existing.sharedAt : Date.now());
  return {
    title: clip(body.title, 500),
    url,
    topic: clip(body.topic, 120),
    medium: clip(body.medium, 80),
    status: clip(body.status, 40) || 'Paylaşıldı',
    note: clip(body.note, 1000),
    summary: clip(body.summary, 800),
    kind: clip(body.kind, 20),
    source: clip(body.source, 120) || hostOf(url),
    sharedAt
  };
}

function newsAction(db, body, user) {
  const action = String(body.action || 'list');
  const arr = newsStore.load();
  const mine = () => arr.filter(r => r.userId === user.id || r.username.toLowerCase() === user.username.toLowerCase());

  if (action === 'list') {
    return { ok: true, items: mine().slice(0, 5000) };
  }
  if (action === 'add') {
    const f = sanitizeNews(body, user, null);
    if (!f.title) return { ok: false, error: 'Haber başlığı zorunludur.' };
    if (body.auto && f.url) {
      // Ekran görüntüsünden otomatik eklenen kayıt: aynı kullanıcı + aynı link 12 saat içinde tekrar eklenmez
      const dup = arr.find(r => r.auto && r.userId === user.id && r.url === f.url && Date.now() - r.createdAt < 12 * 3600 * 1000);
      if (dup) return { ok: true, item: dup, dup: true };
    }
    const rec = {
      id: uid('nt'),
      userId: user.id,
      username: user.username,
      fullName: user.fullName || '',
      ...f,
      auto: Boolean(body.auto),
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    arr.unshift(rec);
    newsStore.trim();
    newsStore.save();
    scheduleBackup();
    return { ok: true, item: rec };
  }
  const rec = arr.find(r => r.id === body.id && (r.userId === user.id || r.username.toLowerCase() === user.username.toLowerCase()));
  if (!rec) return { ok: false, error: 'Kayıt bulunamadı.' };
  if (action === 'update') {
    const f = sanitizeNews(body, user, rec);
    if (!f.title) return { ok: false, error: 'Haber başlığı zorunludur.' };
    Object.assign(rec, f, { updatedAt: Date.now() });
    newsStore.save();
    scheduleBackup();
    return { ok: true, item: rec };
  }
  if (action === 'delete') {
    const idx = arr.indexOf(rec);
    arr.splice(idx, 1);
    newsStore.save();
    scheduleBackup();
    return { ok: true };
  }
  return { ok: false, error: 'Geçersiz işlem.' };
}

function listNewsAdmin(q = {}) {
  let arr = newsStore.load();
  const user = clip(q.username, 80).toLowerCase();
  const text = clip(q.q, 120).toLowerCase();
  const since = Number(q.since) || 0;
  const until = Number(q.until) || 0;
  if (user || text || since || until) {
    arr = arr.filter(r => {
      if (user && r.username.toLowerCase() !== user) return false;
      if (since && r.sharedAt < since) return false;
      if (until && r.sharedAt > until) return false;
      if (text && !(`${r.username} ${r.title} ${r.url} ${r.topic} ${r.medium} ${r.note} ${r.source} ${r.summary || ''}`.toLowerCase().includes(text))) return false;
      return true;
    });
  }
  return { total: arr.length, items: arr.slice(0, Math.min(Math.max(Number(q.limit) || 2000, 1), 50000)) };
}

function deleteNewsAdmin(ids) {
  const set = new Set(Array.isArray(ids) ? ids : [ids]);
  const arr = newsStore.load();
  const keep = arr.filter(r => !set.has(r.id));
  newsStore.replace(keep);
  newsStore.flushNow();
  scheduleBackup();
  return arr.length - keep.length;
}

// ---------------------------------------------------------------------
// Kalıcılık: Render ücretsiz planda disk silinebilir. GH_BACKUP_TOKEN varsa
// Haber Takip kayıtları mevcut db-backup dalına da yedeklenir ve açılışta geri yüklenir.
// ---------------------------------------------------------------------
const BACKUP_API = 'https://api.github.com/repos/aliveli75495075/jhaber-cloud-server/contents/data/news-tracker.json';
let backupTimer = null;

function testPort() {
  const p = String(process.env.PORT || '');
  return p === '49123' || p === '49876' || p === '49877' || p === '49888';
}

function scheduleBackup() {
  if (!process.env.GH_BACKUP_TOKEN || testPort()) return;
  clearTimeout(backupTimer);
  backupTimer = setTimeout(async () => {
    try {
      const tok = process.env.GH_BACKUP_TOKEN;
      const headers = { 'Authorization': 'Bearer ' + tok, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'JHaber-Cloud-Server' };
      const g = await fetch(BACKUP_API + '?ref=db-backup', { headers });
      let sha;
      if (g.ok) sha = (await g.json()).sha;
      await fetch(BACKUP_API, {
        method: 'PUT',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: 'Auto-persist news tracker',
          content: Buffer.from(JSON.stringify(newsStore.load()), 'utf8').toString('base64'),
          sha,
          branch: 'db-backup'
        })
      });
    } catch (_) {}
  }, 4000);
}

async function restoreFromBackup() {
  if (!process.env.GH_BACKUP_TOKEN || testPort()) return;
  try {
    if (newsStore.load().length) return;
    const res = await fetch(BACKUP_API + '?ref=db-backup', {
      headers: { 'Authorization': 'Bearer ' + process.env.GH_BACKUP_TOKEN, 'Accept': 'application/vnd.github.v3+json', 'User-Agent': 'JHaber-Cloud-Server' }
    });
    if (!res.ok) return;
    const d = await res.json();
    const arr = JSON.parse(Buffer.from(d.content || '', 'base64').toString('utf8'));
    if (Array.isArray(arr) && arr.length) {
      newsStore.replace(arr);
      newsStore.flushNow();
      console.log(`[J HABER CLOUD] Haber Takip yedeğinden ${arr.length} kayıt geri yüklendi.`);
    }
  } catch (_) {}
}

function flushAll() {
  activityStore.flushNow();
  newsStore.flushNow();
}
process.on('SIGTERM', () => { flushAll(); process.exit(0); });
process.on('SIGINT', () => { flushAll(); process.exit(0); });

module.exports = {
  addActivity, listActivity, clearActivity,
  newsAction, listNewsAdmin, deleteNewsAdmin,
  restoreFromBackup, flushAll
};
