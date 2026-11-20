'use strict';
// =====================================================================
// J HABER — KALICI ARŞİV (destek mesajları)
// Kurallar:
//  • Yalnızca EKLER / BİRLEŞTİRİR; hiçbir mesaj veya talep bu dosyadan silinmez.
//  • Yönetici bir talebi "siler"se ana listeden kalkar ama arşivde durur.
//  • Her değişiklikte (varsa) GitHub db-backup dalına yedeklenir, açılışta geri yüklenir.
//  • Yönetici masaüstü uygulaması ve kullanıcı uygulamaları da kendi kopyalarını tutar;
//    sunucu diski silinirse onlardan geri doldurulur.
// =====================================================================
const fs = require('fs');
const path = require('path');
const central = require('./central-db');
const tracking = require('./tracking');

const FILE = 'archive.json';
const BACKUP_API = 'https://api.github.com/repos/aliveli75495075/jhaber-cloud-server/contents/data/archive-bundle.json';

let cache = null;
let saveTimer = null;
let ghTimer = null;
let lastSig = '';

const status = {
  ghConfigured: Boolean(process.env.GH_BACKUP_TOKEN),
  lastPushAt: 0, lastPushOk: null, lastPushErr: '',
  lastRestoreAt: 0, lastRestoreInfo: '',
  startedAt: Date.now()
};

function testPort() {
  const p = String(process.env.PORT || '');
  return p === '49123' || p === '49876' || p === '49877' || p === '49888';
}
function dataDir() {
  try { return central.getCentralDir(); } catch (_) { return path.join(__dirname, 'data'); }
}
function file() { return path.join(dataDir(), FILE); }

function load() {
  if (cache) return cache;
  try { cache = JSON.parse(fs.readFileSync(file(), 'utf8')); } catch (_) { cache = null; }
  if (!cache || typeof cache !== 'object') cache = {};
  if (!cache.tickets || typeof cache.tickets !== 'object') cache.tickets = {};
  if (!cache.deletedTickets || typeof cache.deletedTickets !== 'object') cache.deletedTickets = {};
  return cache;
}

function flushNow() {
  clearTimeout(saveTimer); saveTimer = null;
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
  if (!saveTimer) saveTimer = setTimeout(flushNow, 800);
  scheduleGh();
}

const msgKey = (m) => `${m.sender}|${m.time}|${m.text}`;
const clone = (o) => JSON.parse(JSON.stringify(o));

// Bir talebi arşivle birleştirir (mesajlar birleşim kümesi olur). Değişti mi -> true
function mergeTicket(t) {
  if (!t || typeof t.id !== 'string' || !t.id) return false;
  const a = load();
  const cur = a.tickets[t.id];
  if (!cur) {
    a.tickets[t.id] = clone(t);
    if (!Array.isArray(a.tickets[t.id].messages)) a.tickets[t.id].messages = [];
    return true;
  }
  if (!Array.isArray(cur.messages)) cur.messages = [];
  const keys = new Set(cur.messages.map(msgKey));
  let ch = false;
  for (const m of (Array.isArray(t.messages) ? t.messages : [])) {
    if (!m || !m.text) continue;
    const k = msgKey(m);
    if (!keys.has(k)) { cur.messages.push(clone(m)); keys.add(k); ch = true; }
  }
  if (ch) cur.messages.sort((x, y) => (x.time || 0) - (y.time || 0));
  if ((t.updatedAt || 0) > (cur.updatedAt || 0)) { cur.updatedAt = t.updatedAt; if (t.status) cur.status = t.status; ch = true; }
  return ch;
}

function ticketsSig(list) {
  let n = 0, last = 0;
  for (const t of list) { n += 1 + (t.messages ? t.messages.length : 0); if ((t.updatedAt || 0) > last) last = t.updatedAt || 0; }
  return list.length + ':' + n + ':' + last;
}

// Her saveCentralDb çağrısında: db.tickets -> arşive
function captureDb(db) {
  try {
    const list = Array.isArray(db && db.tickets) ? db.tickets : [];
    const sig = ticketsSig(list);
    if (sig === lastSig) return;
    lastSig = sig;
    let ch = false;
    for (const t of list) if (mergeTicket(t)) ch = true;
    if (ch) save();
  } catch (_) {}
}

// Arşivdeki (silinmemiş) talepleri db.tickets'a geri koyar; var olanlara eksik mesajları ekler
function applyToDb(db) {
  const a = load();
  if (!Array.isArray(db.tickets)) db.tickets = [];
  let changed = 0;
  const byId = new Map(db.tickets.map(t => [t.id, t]));
  for (const id of Object.keys(a.tickets)) {
    if (a.deletedTickets[id]) continue;
    const at = a.tickets[id];
    const ex = byId.get(id);
    if (!ex) {
      const c = clone(at);
      db.tickets.push(c); byId.set(id, c); changed++;
    } else {
      if (!Array.isArray(ex.messages)) ex.messages = [];
      const keys = new Set(ex.messages.map(msgKey));
      let ch = false;
      for (const m of (at.messages || [])) if (!keys.has(msgKey(m))) { ex.messages.push(clone(m)); keys.add(msgKey(m)); ch = true; }
      if (ch) { ex.messages.sort((x, y) => (x.time || 0) - (y.time || 0)); ex.updatedAt = Math.max(ex.updatedAt || 0, at.updatedAt || 0); changed++; }
    }
  }
  const before = db.tickets.length;
  db.tickets = db.tickets.filter(t => !a.deletedTickets[t.id]);
  if (db.tickets.length !== before) changed++;
  if (changed) db.tickets.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
  return changed;
}

function markDeleted(id) {
  const a = load();
  a.deletedTickets[id] = Date.now();
  if (a.tickets[id]) a.tickets[id].deleted = true;
  save();
}

// Kullanıcı uygulamasındaki yerel kopyadan geri yükleme (yalnızca kendi talepleri, yalnızca 'user' mesajları)
function restoreFromClient(db, user, tickets) {
  const a = load();
  if (!Array.isArray(db.tickets)) db.tickets = [];
  let added = 0, merged = 0;
  const uname = String(user.username || '').toLowerCase();
  for (const raw of (Array.isArray(tickets) ? tickets : []).slice(0, 300)) {
    if (!raw || typeof raw.id !== 'string' || !/^tkt_[A-Za-z0-9_]{3,40}$/.test(raw.id)) continue;
    if (a.deletedTickets[raw.id]) continue;
    const msgs = (Array.isArray(raw.messages) ? raw.messages : [])
      .filter(m => m && m.sender === 'user' && m.text)
      .slice(0, 500)
      .map(m => ({ sender: 'user', author: user.username, text: String(m.text).slice(0, 4000), time: Number(m.time) > 0 ? Number(m.time) : Date.now() }));
    if (!msgs.length) continue;
    const ex = db.tickets.find(t => t.id === raw.id);
    if (ex) {
      if (String(ex.username || '').toLowerCase() !== uname) continue;
      const keys = new Set((ex.messages || []).map(msgKey));
      let ch = false;
      for (const m of msgs) if (!keys.has(msgKey(m))) { ex.messages.push(m); ch = true; }
      if (ch) { ex.messages.sort((x, y) => (x.time || 0) - (y.time || 0)); merged++; }
      continue;
    }
    if (a.tickets[raw.id] && String(a.tickets[raw.id].username || '').toLowerCase() !== uname) continue;
    db.tickets.push({
      id: raw.id, userId: user.id, username: user.username, ipPort: '',
      category: String(raw.category || 'Talep / Özellik İsteği').slice(0, 80),
      subject: String(raw.subject || '(konu yok)').slice(0, 200),
      status: ['open', 'replied', 'closed'].includes(raw.status) ? raw.status : 'open',
      createdAt: Number(raw.createdAt) > 0 ? Number(raw.createdAt) : msgs[0].time,
      updatedAt: Number(raw.updatedAt) > 0 ? Number(raw.updatedAt) : msgs[msgs.length - 1].time,
      messages: msgs, restoredFromClient: true
    });
    added++;
  }
  if (added || merged) {
    db.tickets.sort((x, y) => (y.createdAt || 0) - (x.createdAt || 0));
    central.saveCentralDb(db);
  }
  return { added, merged };
}

// ---- Yönetici içe/dışa aktarma (güvenilir kaynak: yöneticinin masaüstü arşivi) ----
function exportAll() {
  const a = load();
  return {
    exportedAt: Date.now(),
    tickets: Object.values(a.tickets),
    deletedTickets: a.deletedTickets,
    news: tracking.dumpNews()
  };
}

function importAll(db, data) {
  let t = 0, n = 0, act = 0;
  if (data && Array.isArray(data.tickets)) for (const x of data.tickets.slice(0, 20000)) if (mergeTicket(x)) t++;
  if (data && data.deletedTickets && typeof data.deletedTickets === 'object') {
    const a = load();
    for (const id of Object.keys(data.deletedTickets)) if (!a.deletedTickets[id]) { a.deletedTickets[id] = data.deletedTickets[id]; t++; }
  }
  if (data && Array.isArray(data.news)) n = tracking.mergeNews(data.news.slice(0, 50000));
  if (data && Array.isArray(data.activity)) act = tracking.mergeActivity(data.activity.slice(0, 50000));
  const applied = applyToDb(db);
  if (t || applied) { save(); central.saveCentralDb(db); }
  return { tickets: t, news: n, activity: act, appliedToDb: applied };
}

// ---- GitHub db-backup dalına yedek (GH_BACKUP_TOKEN gerekli) ----
function ghHeaders(raw) {
  return {
    'Authorization': 'Bearer ' + process.env.GH_BACKUP_TOKEN,
    'Accept': raw ? 'application/vnd.github.raw+json' : 'application/vnd.github.v3+json',
    'User-Agent': 'JHaber-Cloud-Server'
  };
}

function scheduleGh() {
  status.ghConfigured = Boolean(process.env.GH_BACKUP_TOKEN);
  if (!status.ghConfigured || testPort()) return;
  clearTimeout(ghTimer);
  ghTimer = setTimeout(pushGh, 5000);
}

async function pushGh() {
  try {
    const g = await fetch(BACKUP_API + '?ref=db-backup', { headers: ghHeaders(false) });
    let sha;
    if (g.ok) sha = (await g.json()).sha;
    const bundle = { v: 1, savedAt: Date.now(), tickets: load().tickets, deletedTickets: load().deletedTickets, news: tracking.dumpNews() };
    const r = await fetch(BACKUP_API, {
      method: 'PUT',
      headers: { ...ghHeaders(false), 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Auto-persist archive', content: Buffer.from(JSON.stringify(bundle), 'utf8').toString('base64'), sha, branch: 'db-backup' })
    });
    status.lastPushAt = Date.now();
    status.lastPushOk = r.ok;
    status.lastPushErr = r.ok ? '' : ('HTTP ' + r.status);
    if (!r.ok) ghTimer = setTimeout(pushGh, 60000);
  } catch (e) {
    status.lastPushAt = Date.now(); status.lastPushOk = false; status.lastPushErr = String(e.message || e).slice(0, 120);
    ghTimer = setTimeout(pushGh, 60000);
  }
}

async function restoreFromGh() {
  status.ghConfigured = Boolean(process.env.GH_BACKUP_TOKEN);
  if (!status.ghConfigured || testPort()) return;
  try {
    const r = await fetch(BACKUP_API + '?ref=db-backup', { headers: ghHeaders(true) });
    if (!r.ok) { status.lastRestoreInfo = 'yedek yok (HTTP ' + r.status + ')'; return; }
    const b = JSON.parse(await r.text());
    let t = 0;
    for (const x of Object.values(b.tickets || {})) if (mergeTicket(x)) t++;
    const a = load();
    for (const id of Object.keys(b.deletedTickets || {})) if (!a.deletedTickets[id]) a.deletedTickets[id] = b.deletedTickets[id];
    const n = Array.isArray(b.news) ? tracking.mergeNews(b.news) : 0;
    status.lastRestoreAt = Date.now();
    status.lastRestoreInfo = `${t} talep, ${n} haber kaydı geri yüklendi`;
    if (t) flushNow();
    console.log('[J HABER CLOUD] Arşiv yedeğinden geri yüklendi: ' + status.lastRestoreInfo);
  } catch (e) { status.lastRestoreInfo = 'hata: ' + String(e.message || e).slice(0, 100); }
}

function getStatus() {
  const a = load();
  const news = tracking.dumpNews();
  return {
    ...status,
    ghConfigured: Boolean(process.env.GH_BACKUP_TOKEN),
    tickets: Object.keys(a.tickets).length,
    deletedTickets: Object.keys(a.deletedTickets).length,
    news: news.filter(r => !r.deleted).length,
    newsDeletedKept: news.filter(r => r.deleted).length,
    uptimeMs: Date.now() - status.startedAt
  };
}

function flushAll() { flushNow(); }
tracking.addFlushHook(flushNow);

module.exports = {
  captureDb, applyToDb, markDeleted, restoreFromClient,
  exportAll, importAll, restoreFromGh, getStatus, flushAll
};
