const DEFAULT_BRANDING = {
  adminBrandTitle: 'J HABER YÖNETİM',
  adminBrandSubtitle: 'Merkez Sunucu Aktif',
  clientAppTitle: 'J HABER',
  clientWelcomeMsg: 'Merkez Haber & İstihbarat Portalı',
  accentColor: 'gold',
  sidebarLabels: {
    users: 'Kullanıcılar & Canlı Trafik',
    distro: 'Dış Ağ & WhatsApp Dağıtım',
    sports: 'Spor, Fikstür & Maç Linkleri',
    killswitch: 'Acil Durum & Sistemi Kilitle',
    navmgr: 'Sol Panel & Sekme Yönetimi',
    content: "J HABER'e Yazı & Not Ekle",
    tickets: 'Gelen Şikayet & Talepler',
    security: 'Güvenlik Radarı & Loglar',
    creds: 'ID / Şifre & Sunucu Ayarları',
    branding: 'Görünüm & Marka Özelleştirme'
  },
  updatedAt: Date.now()
};

'use strict';
// J HABER Cloud Server - Merkezi Veri Tabanı Modülü
// Bağımsız ve 7/24 çalışır. Verileri JSON dosyasında kalıcı olarak saklar.
const fs = require('fs');
const path = require('path');
const os = require('os');

function getCentralDir() {
  if (process.env.DATA_DIR) {
    try { fs.mkdirSync(process.env.DATA_DIR, { recursive: true }); } catch {}
    return process.env.DATA_DIR;
  }
  const dir = path.join(__dirname, 'data');
  try { fs.mkdirSync(dir, { recursive: true }); } catch {}
  return dir;
}

function getCentralFilePath() {
  return path.join(getCentralDir(), 'central-db.json');
}

const DEFAULT_SIDEBAR_ITEMS = [
  { id: 'news', sec: 'Akış & Sütunlar', ico: '📰', label: 'Haberler', badge: 'news', visible: true, builtin: true, paid: false },
  { id: 'x', sec: 'Akış & Sütunlar', ico: '𝕏', label: 'X Takibi & Kelimeler', badge: 'x', visible: true, builtin: true, paid: false },
  { id: 'starkw', sec: 'Akış & Sütunlar', ico: '🌟', label: 'Yıldızlı Anahtar Kelimeler', badge: 'starkw', orange: true, visible: true, builtin: true, paid: false },
  { id: 'activenotifs', sec: 'Akış & Sütunlar', ico: '🔔', label: 'Açık Bildirimler', badge: 'activenotifs', visible: true, builtin: true, paid: false },
  { id: 'intel', sec: 'Akış & Sütunlar', ico: '⚡', label: 'Özel Analiz & Dosya Merkezi', badge: 'intel', visible: true, builtin: true, paid: false },
  { id: 'agenda', sec: 'Akış & Sütunlar', ico: '📅', label: 'Son 1 Ay X Gündemi', visible: true, builtin: true, paid: false },
  { id: 'sports', sec: 'Akış & Sütunlar', ico: '⚽', label: 'Spor & Canlı Skor / Fikstür', visible: true, builtin: true, paid: false, minRole: 'normal' },
  { id: 'keywords', sec: 'Akış & Sütunlar', ico: '🔑', label: 'Anahtar Kelimeler', badge: 'keywords', visible: true, builtin: true, paid: false },
  { id: 'groups', sec: 'Akış & Sütunlar', ico: '🗂', label: 'Kaynak Grupları', visible: true, builtin: true, paid: false },
  { id: 'starred', sec: 'Akış & Sütunlar', ico: '⭐', label: 'Favoriler', badge: 'starred', visible: true, builtin: true, paid: false },
  { id: 'saved', sec: 'Akış & Sütunlar', ico: '🔖', label: 'Kaydedilenler', badge: 'saved', visible: true, builtin: true, paid: false },
  { id: 'search', sec: 'Araçlar', ico: '🔍', label: 'Görsel & Birleşik Arama', visible: true, builtin: true, paid: false },
  { id: 'trends', sec: 'Araçlar', ico: '📈', label: 'Kelime Yoğunluk Grafiği', visible: true, builtin: true, paid: false },
  { id: 'arindir', sec: 'Araçlar', ico: '🧹', label: 'Arındır Filtresi', visible: true, builtin: true, paid: false },
  { id: 'notes', sec: 'Araçlar', ico: '📝', label: 'Notlar', badge: 'notes', visible: true, builtin: true, paid: false },
  { id: 'calc', sec: 'Araçlar', ico: '🧮', label: 'Hesap Makinesi', visible: true, builtin: true, paid: false },
  { id: 'sources', sec: 'Yönetim', ico: '📡', label: 'Kaynaklar & Sağlık', badge: 'sources', visible: true, builtin: true, paid: false },
  { id: 'notify', sec: 'Yönetim', ico: '🔊', label: 'Bildirim Sesleri & Ayarlar', visible: true, builtin: true, paid: false },
  { id: 'settings', sec: 'Yönetim', ico: '⚙', label: 'Görünüm & Yedek', visible: true, builtin: true, paid: false },
  { id: 'adminposts', sec: 'Yönetim', ico: '📢', label: 'Yönetici Duyuru & Yazıları', badge: 'adminposts', visible: true, builtin: true, paid: false },
  { id: 'support', sec: 'Yönetim', ico: '💬', label: 'Yöneticiyle İletişime Geç', badge: 'support', visible: true, builtin: true, paid: false }
];

const DEFAULT_SUB_TABS = {
  news_grid: { id: 'news_grid', parent: 'Haberler', label: '📰 Canlı Izgara Görünümü (12-14 Kart)', visible: true, paid: false },
  news_deck: { id: 'news_deck', parent: 'Haberler', label: '▥ TweetDeck Sütunları (10 Sütun)', visible: true, paid: false },
  x_deck: { id: 'x_deck', parent: 'X Takibi', label: '▥ X TweetDeck Sütunları', visible: true, paid: false },
  x_single: { id: 'x_single', parent: 'X Takibi', label: '⚙ X Oturum & Tekli Akış', visible: true, paid: false },
  star_single: { id: 'star_single', parent: 'Yıldızlı Kelimeler', label: '🔥 Tek Sütun (Birleşik Akış)', visible: true, paid: false },
  star_deck: { id: 'star_deck', parent: 'Yıldızlı Kelimeler', label: '▥ Sütunlara Böl (TweetDeck)', visible: true, paid: false },
  intel_combo: { id: 'intel_combo', parent: 'Özel Analiz', label: '🔗 Birlikte Geçen Kelimeler (VE)', visible: true, paid: false },
  intel_surge: { id: 'intel_surge', parent: 'Özel Analiz', label: '🚨 Anormal Gündem Patlaması', visible: true, paid: false },
  intel_dossier: { id: 'intel_dossier', parent: 'Özel Analiz', label: '📁 Özel Dosya & Kronolojik Rapor', visible: true, paid: false },
  intel_ticker: { id: 'intel_ticker', parent: 'Özel Analiz', label: '📌 Alt Kayan Canlı Bant', visible: true, paid: false }
};

const PAID_FEATURE_CATALOG = [
  { id: 'starkw', label: '🌟 Yıldızlı Anahtar Kelimeler (Haber+X)' },
  { id: 'intel', label: '⚡ Özel Analiz & Dosya Merkezi' },
  { id: 'x', label: '𝕏 X Takibi & TweetDeck Sütunları' },
  { id: 'agenda', label: '📅 Son 1 Ay X Gündem Arşivi' },
  { id: 'search', label: '🔍 Görsel & Birleşik Arama' },
  { id: 'trends', label: '📈 Kelime Yoğunluk Grafiği' },
  { id: 'export', label: '⬇ Dışa Aktarma (CSV / HTML / Rapor)' }
];

function createDefaultDb() {
  return {
    adminAuth: {
      adminId: 'J Haber',
      password: '123456',
      serverPort: 47850,
      updatedAt: Date.now()
    },
    securitySettings: {
      requireApproval: true,
      watchKeywords: ['şifre', 'sızıntı', 'hack', 'kopyala', 'veritabanı'],
      announcementBanner: '',
      systemLock: { enabled: false, message: 'Sistem bakım nedeniyle geçici olarak durdurulmuştur.' },
      lockedUsers: {}
    },
    branding: JSON.parse(JSON.stringify(DEFAULT_BRANDING)),
    sportsData: {
      matches: [
        { id: 'm1', league: 'Trendyol Süper Lig', home: 'Fenerbahçe', away: 'Galatasaray', score: '2 - 1', time: 'MS', date: 'Dün', links: [{ title: '📺 FB - GS Maç Özeti İzle', url: 'https://beinsports.com.tr' }] },
        { id: 'm2', league: 'Trendyol Süper Lig', home: 'Beşiktaş', away: 'Trabzonspor', score: '1 - 1', time: 'MS', date: 'Dün', links: [{ title: '📺 BJK - TS Maç Özeti İzle', url: 'https://beinsports.com.tr' }] }
      ],
      standings: [
        { rank: 1, team: 'Galatasaray', p: 12, pts: 31 },
        { rank: 2, team: 'Fenerbahçe', p: 12, pts: 29 },
        { rank: 3, team: 'Samsunspor', p: 12, pts: 25 },
        { rank: 4, team: 'Beşiktaş', p: 12, pts: 21 }
      ],
      updatedAt: Date.now()
    },
    navConfig: {
      sidebarItems: JSON.parse(JSON.stringify(DEFAULT_SIDEBAR_ITEMS)),
      subTabs: JSON.parse(JSON.stringify(DEFAULT_SUB_TABS)),
      updatedAt: Date.now()
    },
    adminContent: {
      posts: [
        {
          id: 'post_welcome',
          title: 'J HABER Merkez Yönetim Sistemi Aktif',
          category: 'Duyuru',
          body: 'J HABER Yönetim Paneli üzerinden gönderilen anlık duyurular, özel haberler ve yönetici yazıları burada ve haber akışında görüntülenir.',
          important: true,
          pinnedBanner: false,
          showInNewsFeed: true,
          targetUser: '',
          createdAt: Date.now()
        }
      ],
      pushedNotes: [],
      pushedFeeds: [],
      pushedStarKeywords: [],
      broadcastPopup: null
    },
    users: [],
    tickets: [],
    trafficLogs: []
  };
}

function loadCentralDb() {
  const fp = getCentralFilePath();
  let db = null;
  try {
    if (fs.existsSync(fp)) {
      db = JSON.parse(fs.readFileSync(fp, 'utf8'));
    }
  } catch {}

  const def = createDefaultDb();
  if (!db || typeof db !== 'object') {
    db = def;
    saveCentralDb(db);
    return db;
  }
  db.adminAuth = { ...def.adminAuth, ...(db.adminAuth || {}) };
  db.securitySettings = { ...def.securitySettings, ...(db.securitySettings || {}) };
  if (!db.navConfig || !Array.isArray(db.navConfig.sidebarItems)) {
    db.navConfig = def.navConfig;
  } else {
    const existingIds = new Set(db.navConfig.sidebarItems.map(x => x.id));
    for (const item of DEFAULT_SIDEBAR_ITEMS) {
      if (!existingIds.has(item.id)) db.navConfig.sidebarItems.push({ ...item });
    }
    db.navConfig.subTabs = { ...DEFAULT_SUB_TABS, ...(db.navConfig.subTabs || {}) };
  }
  db.adminContent = { ...def.adminContent, ...(db.adminContent || {}) };
  if (!Array.isArray(db.adminContent.posts)) db.adminContent.posts = def.adminContent.posts;
  if (!Array.isArray(db.adminContent.pushedNotes)) db.adminContent.pushedNotes = [];
  if (!Array.isArray(db.adminContent.pushedFeeds)) db.adminContent.pushedFeeds = [];
  if (!Array.isArray(db.adminContent.pushedStarKeywords)) db.adminContent.pushedStarKeywords = [];
  if (!Array.isArray(db.users)) db.users = [];
  if (!Array.isArray(db.tickets)) db.tickets = [];
  if (!Array.isArray(db.trafficLogs)) db.trafficLogs = [];
  db.branding = { ...DEFAULT_BRANDING, ...(db.branding || {}) };
  if (!db.sportsData) db.sportsData = def.sportsData;
  if (!db.securitySettings.systemLock) db.securitySettings.systemLock = { enabled: false, message: 'Sistem bakım nedeniyle geçici olarak durdurulmuştur.' };
  if (!db.securitySettings.lockedUsers) db.securitySettings.lockedUsers = {};

  const now = Date.now();
  for (const u of db.users) {
    if (u.status === 'active' && u.expiresAt && u.expiresAt !== 'unlimited' && Number(u.expiresAt) > 0 && now > Number(u.expiresAt)) {
      u.status = 'expired';
    }
  }
  return db;
}

function saveCentralDb(db) {
  const fp = getCentralFilePath();
  try {
    const tmp = fp + '.tmp.' + process.pid;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
    fs.renameSync(tmp, fp);
  } catch {
    try { fs.writeFileSync(fp, JSON.stringify(db, null, 2), 'utf8'); } catch {}
  }
}

function addTrafficLog(db, entry) {
  db.trafficLogs = db.trafficLogs || [];
  db.trafficLogs.unshift({
    id: 'log_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
    time: Date.now(),
    type: entry.type || 'info',
    username: entry.username || 'Anonim',
    ipPort: entry.ipPort || '127.0.0.1:0',
    detail: entry.detail || ''
  });
  if (db.trafficLogs.length > 500) db.trafficLogs.length = 500;
}

function computeDurationMs(durationKey, customDays) {
  const DAY = 24 * 3600 * 1000;
  switch (durationKey) {
    case '1h': return 3600 * 1000;
    case '1d': return 1 * DAY;
    case '3d': return 3 * DAY;
    case '1w': return 7 * DAY;
    case '2w': return 14 * DAY;
    case '1m': return 30 * DAY;
    case '3m': return 90 * DAY;
    case '6m': return 180 * DAY;
    case '1y': return 365 * DAY;
    case 'custom': return Math.max(1, Number(customDays) || 1) * DAY;
    case 'unlimited': return null;
    default: return 0;
  }
}

function durationLabel(durationKey, customDays) {
  const map = {
    '1h': '1 Saat',
    '1d': '1 Gün',
    '3d': '3 Gün',
    '1w': '1 Hafta',
    '2w': '2 Hafta',
    '1m': '1 Ay (30 Gün)',
    '3m': '3 Ay (90 Gün)',
    '6m': '6 Ay',
    '1y': '1 Yıl',
    'custom': `${Math.max(1, Number(customDays) || 1)} Gün`,
    'unlimited': 'Sınırsız (Ömür Boyu)'
  };
  return map[durationKey] || 'Tanımlanmadı';
}

module.exports = {
  DEFAULT_SIDEBAR_ITEMS,
  DEFAULT_BRANDING,
  DEFAULT_SUB_TABS,
  PAID_FEATURE_CATALOG,
  getCentralDir,
  getCentralFilePath,
  loadCentralDb,
  saveCentralDb,
  addTrafficLog,
  computeDurationMs,
  durationLabel
};
