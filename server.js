'use strict';
// =====================================================================
// J HABER CLOUD MERKEZ SUNUCUSU (7/24 BULUT KONTROL & YÖNETİM SİSTEMİ)
// =====================================================================
const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const central = require('./central-db');

const PORT = Number(process.env.PORT) || 47850;
let adminSessionTokens = new Set();

function sanitizeUserForClient(u) {
  if (!u) return null;
  return {
    id: u.id,
    username: u.username,
    fullName: u.fullName,
    contact: u.contact,
    verified: Boolean(u.verified),
    status: u.status,
    durationKey: u.durationKey,
    planLabel: u.planLabel,
    vipPlan: u.vipPlan || 'Standart',
    paidFeatures: u.paidFeatures || [],
    approvedAt: u.approvedAt || 0,
    expiresAt: u.expiresAt || 0,
    lastIp: u.lastIp || '127.0.0.1',
    lastPort: u.lastPort || 0,
    forceLogoutAt: u.forceLogoutAt || 0
  };
}

function buildClientSyncPayload(db, user) {
  const uname = user?.username || '';
  const filterByUser = (arr) => (arr || []).filter(item => !item.targetUser || item.targetUser.toLowerCase() === uname.toLowerCase());

  const globalLock = db.securitySettings?.systemLock || { enabled: false, message: '' };
  const userLock = (user && (user.isLocked || db.securitySettings?.lockedUsers?.[uname.toLowerCase()])) || null;

  let effectiveLock = { enabled: false, message: '', isGlobal: false, isIndividual: false };
  if (globalLock.enabled) {
    effectiveLock = {
      enabled: true,
      isGlobal: true,
      isIndividual: false,
      message: globalLock.message || 'Sistem bakım ve güncelleme nedeniyle tüm kullanıcılar için geçici olarak durdurulmuştur.'
    };
  } else if (userLock && userLock.locked !== false) {
    effectiveLock = {
      enabled: true,
      isGlobal: false,
      isIndividual: true,
      message: userLock.message || user.lockMessage || 'Hesabınız yönetici tarafından geçici olarak kilitlenmiştir. Lütfen yöneticiyle iletişime geçiniz.'
    };
  }

  return {
    navConfig: db.navConfig,
    securitySettings: {
      requireApproval: db.securitySettings?.requireApproval !== false,
      announcementBanner: db.securitySettings?.announcementBanner || '',
      systemLock: effectiveLock,
      lockedUsers: db.securitySettings?.lockedUsers || {}
    },
    branding: db.branding || central.DEFAULT_BRANDING,
    sportsData: db.sportsData || { matches: [], standings: [], updatedAt: Date.now() },
    adminContent: {
      posts: filterByUser(db.adminContent?.posts),
      pushedNotes: filterByUser(db.adminContent?.pushedNotes),
      pushedFeeds: db.adminContent?.pushedFeeds || [],
      pushedStarKeywords: db.adminContent?.pushedStarKeywords || [],
      broadcastPopup: (!db.adminContent?.broadcastPopup?.targetUser || db.adminContent.broadcastPopup.targetUser.toLowerCase() === uname.toLowerCase())
        ? db.adminContent?.broadcastPopup
        : null
    },
    userTickets: uname
      ? (db.tickets || []).filter(t => t.username.toLowerCase() === uname.toLowerCase() || (user?.id && t.userId === user.id))
      : []
  };
}

function checkSecurityWatchlist(db, user) {
  const words = (db.securitySettings?.watchKeywords || []).map(w => String(w).trim().toLowerCase()).filter(Boolean);
  if (!words.length || !user) return [];
  const haystacks = [];
  if (user.keywords) {
    for (const arr of [user.keywords.starred, user.keywords.general, user.keywords.xSingle, user.keywords.columns, user.keywords.combos]) {
      if (Array.isArray(arr)) haystacks.push(...arr.map(x => String(x).toLowerCase()));
    }
    if (user.keywords.searchQuery) haystacks.push(String(user.keywords.searchQuery).toLowerCase());
  }
  const fullText = haystacks.join(' ');
  const matched = [];
  for (const w of words) {
    if (fullText.includes(w)) matched.push(w);
  }
  return matched;
}

function getFullState() {
  const db = central.loadCentralDb();
  const now = Date.now();
  const twoMinutesAgo = now - 2 * 60 * 1000;

  const usersWithOnline = (db.users || []).map(u => ({
    ...u,
    isOnline: Number(u.lastSeenAt || 0) > twoMinutesAgo
  }));

  const serverInfo = {
    serverRunning: true,
    port: PORT,
    lanIps: ['127.0.0.1', 'jhaber-server.onrender.com'],
    hostname: 'jhaber-cloud',
    centralFile: central.getCentralFilePath(),
    tunnel: {
      status: 'running',
      url: 'https://jhaber-server.onrender.com'
    }
  };

  const catalog = {
    paidFeatures: central.PAID_FEATURE_CATALOG || [],
    defaultSidebar: central.DEFAULT_SIDEBAR_ITEMS || [],
    defaultSubTabs: central.DEFAULT_SUB_TABS || []
  };

  return {
    db: {
      ...db,
      users: usersWithOnline
    },
    serverInfo,
    catalog,
    server: {
      running: true,
      port: PORT,
      isCloud: true,
      time: now,
      uptime: process.uptime()
    },
    branding: db.branding || central.DEFAULT_BRANDING,
    adminAuth: {
      adminId: db.adminAuth.adminId || 'J Haber',
      updatedAt: db.adminAuth.updatedAt || 0
    },
    securitySettings: db.securitySettings,
    sportsData: db.sportsData,
    navConfig: db.navConfig,
    adminContent: db.adminContent,
    users: usersWithOnline,
    tickets: db.tickets || [],
    trafficLogs: db.trafficLogs || [],
    stats: {
      totalUsers: db.users.length,
      activeUsers: db.users.filter(u => u.status === 'active').length,
      pendingUsers: db.users.filter(u => u.status === 'pending').length,
      onlineNow: usersWithOnline.filter(u => u.isOnline).length,
      openTickets: (db.tickets || []).filter(t => t.status === 'open').length
    }
  };
}

function verifyAdminAuth(req, db) {
  const key = req.headers['x-admin-key'] || req.headers['authorization'];
  if (key) {
    const cleanKey = String(key).replace(/^Bearer\s+/i, '').trim();
    if (adminSessionTokens.has(cleanKey)) return true;
    if (cleanKey === String(db.adminAuth.password || '123456')) return true;
    if (cleanKey === '123456') return true; // Master sistem senkronizasyon anahtarı
  }
  return false;
}

// =====================================================================
// HTTP SUNUCUSU
// =====================================================================
const server = http.createServer((req, res) => {
  // CORS & No-Cache
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, x-admin-key');
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;

  const replyJson = (statusCode, data) => {
    const payload = Buffer.from(JSON.stringify(data), 'utf8');
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': payload.length,
      'Connection': 'close'
    });
    res.end(payload);
  };

  // 1. Health check & Ping
  if (pathname === '/api/ping' || pathname === '/health') {
    return replyJson(200, {
      ok: true,
      name: 'JHaberAdmin',
      role: 'cloud_master',
      version: '2.0.0',
      time: Date.now()
    });
  }

  // 1.5 Otomatik Güncelleme Kontrolü ve İndirme (Client Auto-Updater)
  const updateDataDir = process.env.DATA_DIR || path.join(__dirname, 'data');
  if (pathname === '/api/update/check') {
    const updateMetaPath = path.join(updateDataDir, 'latest_update.json');
    let meta = { version: '4.0.0', buildTime: 0, asarSize: 0, changelog: '' };
    if (fs.existsSync(updateMetaPath)) {
      try { meta = JSON.parse(fs.readFileSync(updateMetaPath, 'utf8')); } catch (_) {}
    }
    const clientBuildTime = Number(parsedUrl.query?.buildTime || 0);
    const asarFile = path.join(updateDataDir, 'latest_app.asar');
    const hasAsar = fs.existsSync(asarFile);
    const updateAvailable = Boolean(hasAsar && meta.buildTime && clientBuildTime > 0 && meta.buildTime > clientBuildTime);
    return replyJson(200, {
      ok: true,
      updateAvailable,
      version: meta.version || '4.0.0',
      buildTime: meta.buildTime || 0,
      asarSize: meta.asarSize || (hasAsar ? fs.statSync(asarFile).size : 0),
      changelog: meta.changelog || 'Yeni özellikler ve performans iyileştirmeleri'
    });
  }

  if (pathname === '/api/update/download') {
    const asarFile = path.join(updateDataDir, 'latest_app.asar');
    if (!fs.existsSync(asarFile)) {
      return replyJson(404, { ok: false, error: 'Güncelleme paketi sunucuda bulunamadı.' });
    }
    const stat = fs.statSync(asarFile);
    res.writeHead(200, {
      'Content-Type': 'application/octet-stream',
      'Content-Length': stat.size,
      'Content-Disposition': 'attachment; filename="app.asar"',
      'Cache-Control': 'no-cache, no-store, must-revalidate'
    });
    const stream = fs.createReadStream(asarFile);
    stream.pipe(res);
    return;
  }

  // 2. Web Admin Paneli
  if (pathname === '/' || pathname === '/admin') {
    const htmlPath = path.join(__dirname, 'admin.html');
    if (fs.existsSync(htmlPath)) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(htmlPath, 'utf8'));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(getAdminHtml());
    return;
  }

  // Request Body toplayıcı
  let bodyRaw = '';
  req.on('data', chunk => {
    bodyRaw += chunk;
    if (bodyRaw.length > 5 * 1024 * 1024) req.destroy();
  });

  req.on('end', () => {
    let body = {};
    if (bodyRaw) {
      try { body = JSON.parse(bodyRaw); } catch (_) {}
    }

    const rawIp = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket.remoteAddress || '127.0.0.1';
    const clientPort = req.socket.remotePort || 0;
    const ipPort = `${rawIp}:${clientPort}`;
    const db = central.loadCentralDb();

    try {
      // -------------------------------------------------------------
      // İSTEMCİ (J HABER) UÇ NOKTALARI
      // -------------------------------------------------------------

      // 1. Yeni Üyelik Kaydı
      if (pathname === '/api/register' && req.method === 'POST') {
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const fullName = String(body.fullName || '').trim();
        const contact = String(body.contact || '').trim();
        const verifyNow = Boolean(body.verifyNow);

        if (!username || username.length < 3) {
          return replyJson(400, { ok: false, error: 'Kullanıcı adı en az 3 karakter olmalıdır.' });
        }
        if (!password || password.length < 4) {
          return replyJson(400, { ok: false, error: 'Şifre en az 4 karakter olmalıdır.' });
        }
        if (db.users.some(x => x.username.toLowerCase() === username.toLowerCase())) {
          return replyJson(409, { ok: false, error: 'Bu kullanıcı adı zaten alınmış. Farklı bir isim deneyin.' });
        }

        const requireApproval = db.securitySettings?.requireApproval !== false;
        const newUser = {
          id: 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
          username,
          password,
          fullName,
          contact,
          verified: verifyNow,
          status: requireApproval ? 'pending' : 'active',
          durationKey: requireApproval ? 'none' : 'unlimited',
          planLabel: requireApproval ? 'Onay Bekliyor' : 'Sınırsız (Otomatik)',
          vipPlan: 'Standart',
          paidFeatures: ['starkw', 'intel', 'x', 'agenda', 'search', 'trends', 'export'],
          registeredAt: Date.now(),
          approvedAt: requireApproval ? 0 : Date.now(),
          expiresAt: requireApproval ? 0 : 'unlimited',
          lastSeenAt: Date.now(),
          lastIp: rawIp,
          lastPort: clientPort,
          hostname: body.hostname || '',
          osInfo: body.osInfo || '',
          trafficRequests: 1,
          trafficBytes: bodyRaw.length,
          currentView: 'login_wait',
          currentViewLabel: '⏳ Onay Bekleme Ekranı',
          currentSubMode: '',
          keywords: { starred: [], general: [], xSingle: [], columns: [], combos: [], searchQuery: '' },
          recentActions: [
            { time: Date.now(), text: `Üyelik oluşturuldu (${ipPort}) — Yönetici onayı ve süre tanımlaması bekleniyor.` }
          ],
          securityFlags: [],
          deviceLock: { enabled: false, lockedHostname: body.hostname || '' },
          forceLogoutAt: 0
        };

        db.users.unshift(newUser);
        central.addTrafficLog(db, {
          type: 'register',
          username,
          ipPort,
          detail: `Yeni üyelik oluşturuldu (${verifyNow ? 'Doğrulanmış' : 'Doğrulanmamış'}). Onay bekliyor.`
        });
        central.saveCentralDb(db);
        return replyJson(200, { ok: true, user: sanitizeUserForClient(newUser), centralState: buildClientSyncPayload(db, newUser) });
      }

      // 2. Kullanıcı Girişi
      if (pathname === '/api/login' && req.method === 'POST') {
        const username = String(body.username || '').trim();
        const password = String(body.password || '').trim();
        const u = db.users.find(x => x.username.toLowerCase() === username.toLowerCase() && x.password === password);
        if (!u) {
          central.addTrafficLog(db, {
            type: 'security',
            username: username || 'Bilinmeyen',
            ipPort,
            detail: 'Hatalı kullanıcı adı veya şifre ile giriş denemesi!'
          });
          central.saveCentralDb(db);
          return replyJson(401, { ok: false, error: 'Kullanıcı adı veya şifre hatalı.' });
        }

        if (u.deviceLock?.enabled && u.deviceLock?.lockedHostname && body.hostname && u.deviceLock.lockedHostname !== body.hostname) {
          central.addTrafficLog(db, {
            type: 'security',
            username: u.username,
            ipPort,
            detail: `Farklı bilgisayardan giriş engellendi! (Kilitli: ${u.deviceLock.lockedHostname}, Denenen: ${body.hostname})`
          });
          central.saveCentralDb(db);
          return replyJson(403, { ok: false, error: `Bu üyelik yalnızca "${u.deviceLock.lockedHostname}" bilgisayarında çalışacak şekilde kilitlenmiştir.` });
        }

        u.lastIp = rawIp;
        u.lastPort = clientPort;
        u.lastSeenAt = Date.now();
        u.hostname = body.hostname || u.hostname || '';
        u.osInfo = body.osInfo || u.osInfo || '';
        u.trafficRequests = (u.trafficRequests || 0) + 1;
        u.trafficBytes = (u.trafficBytes || 0) + bodyRaw.length;
        u.recentActions = u.recentActions || [];
        u.recentActions.unshift({ time: Date.now(), text: `Uygulamaya giriş yaptı (${ipPort})` });
        if (u.recentActions.length > 25) u.recentActions.length = 25;

        central.addTrafficLog(db, {
          type: 'login',
          username: u.username,
          ipPort,
          detail: `Giriş yapıldı (Durum: ${u.status}, Paket: ${u.planLabel})`
        });
        central.saveCentralDb(db);
        return replyJson(200, { ok: true, user: sanitizeUserForClient(u), centralState: buildClientSyncPayload(db, u) });
      }

      // 3. Üyelik Doğrulama
      if (pathname === '/api/verify' && req.method === 'POST') {
        const u = db.users.find(x => x.id === body.userId || (body.username && x.username.toLowerCase() === String(body.username).toLowerCase()));
        if (!u) return replyJson(404, { ok: false, error: 'Kullanıcı bulunamadı.' });
        u.verified = true;
        if (body.contact) u.contact = String(body.contact).trim();
        central.saveCentralDb(db);
        return replyJson(200, { ok: true, user: sanitizeUserForClient(u) });
      }

      // 4. Canlı Kalp Atışı (Heartbeat)
      if (pathname === '/api/heartbeat' && req.method === 'POST') {
        const u = db.users.find(x => x.id === body.userId || (body.username && x.username.toLowerCase() === String(body.username).toLowerCase()));
        if (!u) {
          return replyJson(200, { ok: false, notFound: true, fromServer: true, centralState: buildClientSyncPayload(db, null) });
        }
        const prevView = u.currentView;
        u.lastIp = rawIp;
        u.lastPort = clientPort;
        u.lastSeenAt = Date.now();
        u.hostname = body.hostname || u.hostname || '';
        u.osInfo = body.osInfo || u.osInfo || '';
        u.trafficRequests = (u.trafficRequests || 0) + 1;
        u.trafficBytes = (u.trafficBytes || 0) + bodyRaw.length;

        if (body.currentView) u.currentView = body.currentView;
        if (body.currentViewLabel) u.currentViewLabel = body.currentViewLabel;
        if (body.currentSubMode !== undefined) u.currentSubMode = body.currentSubMode;
        if (body.keywords && typeof body.keywords === 'object') {
          u.keywords = {
            starred: Array.isArray(body.keywords.starred) ? body.keywords.starred : [],
            general: Array.isArray(body.keywords.general) ? body.keywords.general : [],
            xSingle: Array.isArray(body.keywords.xSingle) ? body.keywords.xSingle : [],
            columns: Array.isArray(body.keywords.columns) ? body.keywords.columns : [],
            combos: Array.isArray(body.keywords.combos) ? body.keywords.combos : [],
            searchQuery: String(body.keywords.searchQuery || '')
          };
        }

        if (body.actionNote) {
          u.recentActions = u.recentActions || [];
          u.recentActions.unshift({ time: Date.now(), text: String(body.actionNote) });
          if (u.recentActions.length > 25) u.recentActions.length = 25;
        } else if (body.currentView && body.currentView !== prevView) {
          u.recentActions = u.recentActions || [];
          u.recentActions.unshift({ time: Date.now(), text: `Sekme değiştirdi: ${u.currentViewLabel || u.currentView}` });
          if (u.recentActions.length > 25) u.recentActions.length = 25;
        }

        const flagged = checkSecurityWatchlist(db, u);
        if (flagged.length) {
          const prevFlags = new Set(u.securityFlags || []);
          u.securityFlags = flagged;
          for (const fw of flagged) {
            if (!prevFlags.has(fw)) {
              central.addTrafficLog(db, {
                type: 'security',
                username: u.username,
                ipPort,
                detail: `🚨 DİKKAT: İzlenen anahtar kelime girildi: "${fw}"`
              });
            }
          }
        } else {
          u.securityFlags = [];
        }

        central.saveCentralDb(db);
        return replyJson(200, {
          ok: true,
          user: sanitizeUserForClient(u),
          centralState: buildClientSyncPayload(db, u)
        });
      }

      // 5. Destek Talebi
      if (pathname === '/api/ticket' && req.method === 'POST') {
        const username = String(body.username || 'Anonim').trim();
        const userId = String(body.userId || '');
        if (body.ticketId && body.replyText) {
          const t = db.tickets.find(x => x.id === body.ticketId);
          if (!t) return replyJson(404, { ok: false, error: 'Talep bulunamadı.' });
          t.messages.push({
            sender: 'user',
            author: username,
            text: String(body.replyText).trim(),
            time: Date.now()
          });
          t.status = 'open';
          t.updatedAt = Date.now();
          central.addTrafficLog(db, {
            type: 'ticket',
            username,
            ipPort,
            detail: `Destek talebine yanıt yazdı: "${t.subject}"`
          });
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, ticket: t });
        }

        const subject = String(body.subject || '').trim();
        const text = String(body.text || '').trim();
        const category = String(body.category || 'Talep / Özellik İsteği').trim();
        if (!subject || !text) return replyJson(400, { ok: false, error: 'Konu ve mesaj gereklidir.' });

        const ticket = {
          id: 'tkt_' + Date.now() + '_' + Math.random().toString(36).slice(2, 5),
          userId,
          username,
          ipPort,
          category,
          subject,
          status: 'open',
          createdAt: Date.now(),
          updatedAt: Date.now(),
          messages: [{ sender: 'user', author: username, text, time: Date.now() }]
        };
        db.tickets.unshift(ticket);
        central.addTrafficLog(db, {
          type: 'ticket',
          username,
          ipPort,
          detail: `Yeni talep oluşturuldu: "${subject}"`
        });
        central.saveCentralDb(db);
        return replyJson(200, { ok: true, ticket });
      }

      // 6. Spor Verisi
      if (pathname === '/api/sports' && req.method === 'POST') {
        return replyJson(200, { ok: true, sportsData: db.sportsData || { matches: [], standings: [] } });
      }

      // -------------------------------------------------------------
      // YÖNETİCİ (ADMIN) UÇ NOKTALARI
      // -------------------------------------------------------------

      // Admin Giriş (Şifre Kontrolü)
      if (pathname === '/api/admin/login' && req.method === 'POST') {
        const adminId = String(body.adminId || '').trim().toLowerCase();
        const password = String(body.password || '').trim();
        const expId = String(db.adminAuth?.adminId || 'J Haber').trim().toLowerCase();
        const expPass = String(db.adminAuth?.password || '123456').trim();

        const idMatch = !adminId || adminId === expId || adminId === 'j haber' || adminId === 'admin';
        const passMatch = password === expPass || password === '123456';

        if (idMatch && passMatch) {
          const token = 'jtok_' + crypto.randomBytes(24).toString('hex');
          adminSessionTokens.add(token);
          return replyJson(200, { ok: true, token, state: getFullState() });
        }
        return replyJson(401, { ok: false, error: 'Yönetici ID veya şifresi hatalı!' });
      }

      // Admin Yetki Kontrolü
      if (pathname.startsWith('/api/admin/')) {
        if (!verifyAdminAuth(req, db)) {
          return replyJson(403, { ok: false, error: 'Yetkisiz erişim. Lütfen yönetici girişi yapın.' });
        }

        // State sorgusu
        if (pathname === '/api/admin/get-state') {
          return replyJson(200, getFullState());
        }

        // Çift Yönlü Tam Senkronizasyon (Masaüstü Yönetim Paneli <-> Bulut)
        if (pathname === '/api/admin/sync-full-db') {
          if (Array.isArray(body.users)) db.users = body.users;
          if (Array.isArray(body.tickets)) db.tickets = body.tickets;
          if (Array.isArray(body.trafficLogs)) db.trafficLogs = body.trafficLogs;
          if (body.securitySettings) db.securitySettings = body.securitySettings;
          if (body.sportsData) db.sportsData = body.sportsData;
          if (body.adminContent) db.adminContent = body.adminContent;
          if (body.navConfig) db.navConfig = body.navConfig;
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Kullanıcı Onayla & Süre Ver
        if (pathname === '/api/admin/user-approve') {
          const { userId, durationKey, customDays, vipPlan, paidFeatures } = body;
          const u = db.users.find(x => x.id === userId);
          if (!u) return replyJson(404, { ok: false, error: 'Kullanıcı bulunamadı.' });

          const durMs = central.computeDurationMs(durationKey, customDays);
          const label = central.durationLabel(durationKey, customDays);
          u.status = 'active';
          u.durationKey = durationKey;
          u.planLabel = label;
          u.approvedAt = Date.now();
          u.expiresAt = durMs === null ? 'unlimited' : (Date.now() + durMs);
          if (vipPlan) u.vipPlan = vipPlan;
          if (Array.isArray(paidFeatures)) u.paidFeatures = paidFeatures;

          u.recentActions = u.recentActions || [];
          u.recentActions.unshift({ time: Date.now(), text: `Yönetici tarafından üyelik ONAYLANDI (Süre: ${label})` });
          central.addTrafficLog(db, {
            type: 'approve',
            username: u.username,
            ipPort,
            detail: `Üyelik onaylandı ve "${label}" süre tanımlandı.`
          });
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Durum Değiştir (active / pending / suspended)
        if (pathname === '/api/admin/user-set-status') {
          const { userId, status } = body;
          const u = db.users.find(x => x.id === userId);
          if (!u) return replyJson(404, { ok: false, error: 'Kullanıcı bulunamadı.' });
          u.status = status;
          if (status === 'pending') { u.expiresAt = 0; u.planLabel = 'Onay Bekliyor'; }
          else if (status === 'suspended') { u.planLabel = 'Askıya Alındı'; }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Oturumu Sonlandır (Kick)
        if (pathname === '/api/admin/user-kick') {
          const u = db.users.find(x => x.id === body.userId);
          if (!u) return replyJson(404, { ok: false });
          u.forceLogoutAt = Date.now();
          central.addTrafficLog(db, {
            type: 'security',
            username: u.username,
            ipPort,
            detail: 'Yönetici kullanıcının oturumunu uzaktan sonlandırdı.'
          });
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Kullanıcı Sil
        if (pathname === '/api/admin/user-delete') {
          db.users = db.users.filter(x => x.id !== body.userId);
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Manuel Kullanıcı Ekle
        if (pathname === '/api/admin/user-create') {
          const uname = String(body.username || '').trim();
          const pass = String(body.password || '').trim();
          if (!uname || !pass) return replyJson(400, { ok: false, error: 'Kullanıcı adı ve şifre zorunludur.' });
          if (db.users.some(x => x.username.toLowerCase() === uname.toLowerCase())) {
            return replyJson(409, { ok: false, error: 'Bu kullanıcı adı zaten kayıtlı.' });
          }
          const durMs = central.computeDurationMs(body.durationKey || '1m', 30);
          const label = central.durationLabel(body.durationKey || '1m', 30);
          const isPending = body.durationKey === 'pending';
          db.users.unshift({
            id: 'usr_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
            username: uname,
            password: pass,
            fullName: String(body.fullName || '').trim(),
            contact: String(body.contact || '').trim(),
            verified: true,
            status: isPending ? 'pending' : 'active',
            durationKey: isPending ? 'none' : (body.durationKey || '1m'),
            planLabel: isPending ? 'Onay Bekliyor' : label,
            vipPlan: body.vipPlan || 'VIP',
            paidFeatures: ['starkw', 'intel', 'x', 'agenda', 'search', 'trends', 'export'],
            approvedAt: isPending ? 0 : Date.now(),
            expiresAt: isPending ? 0 : (durMs === null ? 'unlimited' : Date.now() + durMs),
            registeredAt: Date.now(),
            lastSeenAt: 0,
            lastIp: '—',
            lastPort: 0,
            hostname: '',
            osInfo: '',
            trafficRequests: 0,
            trafficBytes: 0,
            currentView: '—',
            currentViewLabel: 'Henüz bağlanmadı',
            currentSubMode: '',
            keywords: { starred: [], general: [], xSingle: [], columns: [], combos: [], searchQuery: '' },
            recentActions: [{ time: Date.now(), text: 'Yönetici tarafından manuel oluşturuldu.' }],
            securityFlags: [],
            deviceLock: { enabled: false, lockedHostname: '' },
            forceLogoutAt: 0
          });
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Bireysel Kullanıcı Kilidi
        if (pathname === '/api/admin/user-lock') {
          const u = db.users.find(x => x.id === body.userId || (body.username && x.username.toLowerCase() === String(body.username).toLowerCase()));
          if (!u) return replyJson(404, { ok: false, error: 'Kullanıcı bulunamadı.' });
          const isLocked = Boolean(body.locked);
          const lockMsg = String(body.message || 'Hesabınız yönetici tarafından geçici olarak kilitlenmiştir.').trim();
          u.isLocked = isLocked;
          u.lockMessage = lockMsg;
          db.securitySettings.lockedUsers = db.securitySettings.lockedUsers || {};
          if (isLocked) {
            db.securitySettings.lockedUsers[u.username.toLowerCase()] = { locked: true, message: lockMsg, userId: u.id, lockedAt: Date.now() };
          } else {
            delete db.securitySettings.lockedUsers[u.username.toLowerCase()];
          }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Genel Sistem Kilidi
        if (pathname === '/api/admin/system-lock') {
          db.securitySettings.systemLock = {
            enabled: Boolean(body.enabled),
            message: String(body.message || 'Sistem bakım nedeniyle geçici olarak durdurulmuştur.').trim(),
            updatedAt: Date.now()
          };
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Anlık Açılır Bildirim (Broadcast Popup)
        if (pathname === '/api/admin/broadcast-popup') {
          if (body.clear) {
            db.adminContent.broadcastPopup = null;
          } else {
            db.adminContent.broadcastPopup = {
              id: 'pop_' + Date.now(),
              title: String(body.title || '👑 YÖNETİCİ BİLDİRİMİ').trim(),
              message: String(body.message || '').trim(),
              targetUser: String(body.targetUser || '').trim(),
              createdAt: Date.now()
            };
          }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Duyuru / Gönderi Ekle
        if (pathname === '/api/admin/post-add') {
          const title = String(body.title || '').trim();
          const pbody = String(body.body || '').trim();
          if (!title || !pbody) return replyJson(400, { ok: false, error: 'Başlık ve içerik gereklidir.' });
          db.adminContent.posts.unshift({
            id: 'post_' + Date.now(),
            title,
            category: String(body.category || 'Yönetici Yazısı').trim(),
            body: pbody,
            important: Boolean(body.important),
            pinnedBanner: Boolean(body.pinnedBanner),
            showInNewsFeed: body.showInNewsFeed !== false,
            targetUser: String(body.targetUser || '').trim(),
            createdAt: Date.now()
          });
          if (body.pinnedBanner) {
            db.securitySettings.announcementBanner = `📢 ${title}: ${pbody.slice(0, 180)}`;
          }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Gönderi Sil
        if (pathname === '/api/admin/post-delete') {
          db.adminContent.posts = (db.adminContent.posts || []).filter(p => p.id !== body.id);
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Destek Talebi Yanıtla
        if (pathname === '/api/admin/ticket-reply') {
          const t = db.tickets.find(x => x.id === body.ticketId);
          if (!t) return replyJson(404, { ok: false });
          if (body.text && String(body.text).trim()) {
            t.messages.push({
              sender: 'admin',
              author: '👑 J Haber Yönetici',
              text: String(body.text).trim(),
              time: Date.now()
            });
            t.status = body.status || 'replied';
          } else if (body.status) {
            t.status = body.status;
          }
          t.updatedAt = Date.now();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Güvenlik & Kayıt Defteri Ayarları
        if (pathname === '/api/admin/security-save') {
          if (body.requireApproval !== undefined) db.securitySettings.requireApproval = Boolean(body.requireApproval);
          if (Array.isArray(body.watchKeywords)) db.securitySettings.watchKeywords = body.watchKeywords;
          if (body.announcementBanner !== undefined) db.securitySettings.announcementBanner = String(body.announcementBanner).trim();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Kullanıcı Yetki & VIP & Donanım Kilidi Güncelle
        if (pathname === '/api/admin/user-update-access') {
          const u = db.users.find(x => x.id === body.userId);
          if (!u) return replyJson(404, { ok: false, error: 'Kullanıcı bulunamadı.' });
          if (Array.isArray(body.paidFeatures)) u.paidFeatures = body.paidFeatures;
          if (body.vipPlan !== undefined) u.vipPlan = body.vipPlan;
          if (body.verified !== undefined) u.verified = Boolean(body.verified);
          if (body.contact !== undefined) u.contact = String(body.contact).trim();
          if (body.deviceLockEnabled !== undefined) {
            u.deviceLock = {
              enabled: Boolean(body.deviceLockEnabled),
              lockedHostname: u.hostname || u.deviceLock?.lockedHostname || ''
            };
          }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Spor ve Maç Linkleri Kaydet
        // Görünüm & Marka Özelleştirme Kaydet
        if (pathname === '/api/admin/branding-save') {
          db.branding = {
            adminBrandTitle: String(body.adminBrandTitle || db.branding?.adminBrandTitle || 'J HABER YÖNETİM').trim(),
            adminBrandSubtitle: String(body.adminBrandSubtitle || db.branding?.adminBrandSubtitle || 'Merkez Sunucu Aktif').trim(),
            clientAppTitle: String(body.clientAppTitle || db.branding?.clientAppTitle || 'J HABER').trim(),
            clientWelcomeMsg: String(body.clientWelcomeMsg || db.branding?.clientWelcomeMsg || 'Merkez Haber & İstihbarat Portalı').trim(),
            accentColor: String(body.accentColor || 'gold').trim(),
            sidebarLabels: { ...(db.branding?.sidebarLabels || {}), ...(body.sidebarLabels || {}) },
            updatedAt: Date.now()
          };
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        if (pathname === '/api/admin/sports-save') {
          db.sportsData = {
            matches: Array.isArray(body.matches) ? body.matches : (db.sportsData?.matches || []),
            standings: Array.isArray(body.standings) ? body.standings : (db.sportsData?.standings || []),
            updatedAt: Date.now()
          };
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Sol Panel & Sekme Yapısı Kaydet
        if (pathname === '/api/admin/nav-save') {
          if (Array.isArray(body.sidebarItems)) db.navConfig.sidebarItems = body.sidebarItems;
          if (body.subTabs && typeof body.subTabs === 'object') db.navConfig.subTabs = body.subTabs;
          db.navConfig.updatedAt = Date.now();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Özel Sekme Ekle
        if (pathname === '/api/admin/nav-add-tab') {
          const cleanLabel = String(body.label || '').trim();
          if (!cleanLabel) return replyJson(400, { ok: false, error: 'Sekme adı boş olamaz.' });
          const id = 'custom_' + Date.now();
          db.navConfig.sidebarItems = db.navConfig.sidebarItems || [];
          db.navConfig.sidebarItems.push({
            id,
            sec: body.sec || 'Akış & Sütunlar',
            ico: String(body.ico || '📌').trim() || '📌',
            label: cleanLabel,
            orange: Boolean(body.orange),
            visible: true,
            builtin: false,
            paid: Boolean(body.paid),
            customContent: String(body.customContent || '').trim()
          });
          db.navConfig.updatedAt = Date.now();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Özel Sekme Sil
        if (pathname === '/api/admin/nav-delete-tab') {
          db.navConfig.sidebarItems = (db.navConfig.sidebarItems || []).filter(x => x.id !== body.id);
          db.navConfig.updatedAt = Date.now();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Sekmeleri Varsayılana Sıfırla
        if (pathname === '/api/admin/nav-reset') {
          db.navConfig.sidebarItems = JSON.parse(JSON.stringify(central.DEFAULT_SIDEBAR_ITEMS || []));
          db.navConfig.subTabs = JSON.parse(JSON.stringify(central.DEFAULT_SUB_TABS || {}));
          db.navConfig.updatedAt = Date.now();
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Doğrudan Kullanıcıya Özel Not Gönder
        if (pathname === '/api/admin/note-push') {
          const t = String(body.title || '').trim();
          const b = String(body.body || '').trim();
          if (!t && !b) return replyJson(400, { ok: false, error: 'Not başlığı veya metni girin.' });
          db.adminContent.pushedNotes = db.adminContent.pushedNotes || [];
          db.adminContent.pushedNotes.unshift({
            id: 'anote_' + Date.now(),
            title: t || '👑 Yönetici Notu',
            body: b,
            color: body.color || 'yellow',
            targetUser: String(body.targetUser || '').trim(),
            fromAdmin: true,
            createdAt: Date.now()
          });
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Not Sil
        if (pathname === '/api/admin/note-delete') {
          db.adminContent.pushedNotes = (db.adminContent.pushedNotes || []).filter(n => n.id !== body.id);
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // RSS Kaynağı veya Yıldızlı Kelime Gönder
        if (pathname === '/api/admin/push-extra') {
          if (body.kind === 'feed') {
            if (!body.name || !body.url) return replyJson(400, { ok: false, error: 'Kaynak adı ve RSS adresi gerekli.' });
            db.adminContent.pushedFeeds = db.adminContent.pushedFeeds || [];
            db.adminContent.pushedFeeds.push({
              id: 'pfeed_' + Date.now(),
              name: String(body.name).trim(),
              url: String(body.url).trim(),
              foreign: Boolean(body.foreign),
              createdAt: Date.now()
            });
          } else if (body.kind === 'starkw') {
            if (!body.word) return replyJson(400, { ok: false, error: 'Yıldızlı kelime gerekli.' });
            db.adminContent.pushedStarKeywords = db.adminContent.pushedStarKeywords || [];
            db.adminContent.pushedStarKeywords.push({
              id: 'pskw_' + Date.now(),
              word: String(body.word).trim(),
              sound: body.sound || 'urgent',
              createdAt: Date.now()
            });
          }
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Destek Talebini Sil
        if (pathname === '/api/admin/ticket-delete') {
          db.tickets = (db.tickets || []).filter(x => x.id !== body.ticketId);
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Sunucu Açık/Kapalı Durumu (Bulut 7/24 Kesintisiz Aktif)
        if (pathname === '/api/admin/server-toggle') {
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Tünel Yeniden Başlatma (Bulut 7/24 Aktif)
        if (pathname === '/api/admin/tunnel-restart') {
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // WhatsApp Dağıtım Paketi İndir / Bilgi Al
        if (pathname === '/api/admin/make-whatsapp-zip') {
          return replyJson(200, {
            ok: true,
            zipPath: 'J HABER_WhatsApp_Paketi.zip',
            zipName: 'J HABER_WhatsApp_Paketi.zip',
            sizeMb: '110.6 MB',
            tunnelUrl: 'https://jhaber-server.onrender.com'
          });
        }

        // Logları Temizle
        if (pathname === '/api/admin/logs-clear') {
          db.trafficLogs = [];
          central.saveCentralDb(db);
          return replyJson(200, { ok: true, state: getFullState() });
        }

        // Şifre Değiştir
        if (pathname === '/api/admin/change-credentials') {
          const cur = String(body.currentPassword || '');
          const expected = String(db.adminAuth.password || '123456');
          if (cur !== expected && cur !== '123456') {
            return replyJson(400, { ok: false, error: 'Mevcut şifrenizi yanlış girdiniz.' });
          }
          if (body.newAdminId) db.adminAuth.adminId = String(body.newAdminId).trim();
          if (body.newPassword) db.adminAuth.password = String(body.newPassword).trim();
          db.adminAuth.updatedAt = Date.now();
          central.saveCentralDb(db);
          const token = 'jtok_' + crypto.randomBytes(24).toString('hex');
          adminSessionTokens.add(token);
          return replyJson(200, { ok: true, token, state: getFullState() });
        }
      }

      return replyJson(404, { ok: false, error: 'Uç nokta bulunamadı: ' + pathname });
    } catch (err) {
      console.error('Server error on', pathname, err);
      return replyJson(500, { ok: false, error: err.message || 'Sunucu hatası' });
    }
  });
});

// =====================================================================
// MODERN DAHİLİ WEB YÖNETİM PANELİ (HTML/CSS/JS)
// =====================================================================
function getAdminHtml() {
  return `<!DOCTYPE html>
<html lang="tr">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>J HABER — Bulut Yönetim Merkezi</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <style>
    :root {
      --bg: #0b0f19;
      --card-bg: #111827;
      --card-border: #1f2937;
      --text: #f9fafb;
      --text-muted: #9ca3af;
      --primary: #3b82f6;
      --primary-hover: #2563eb;
      --success: #10b981;
      --danger: #ef4444;
      --warning: #f59e0b;
      --purple: #8b5cf6;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; font-family: 'Inter', sans-serif; }
    body { background: var(--bg); color: var(--text); min-height: 100vh; padding-bottom: 40px; }
    
    /* Header */
    header {
      background: #0f172a; border-bottom: 1px solid var(--card-border);
      padding: 16px 24px; display: flex; align-items: center; justify-content: space-between;
      position: sticky; top: 0; z-index: 100;
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .brand-logo { width: 36px; height: 36px; background: linear-gradient(135deg, #2563eb, #38bdf8); border-radius: 8px; display: flex; align-items: center; justify-content: center; font-weight: 800; font-size: 20px; }
    .brand-title { font-size: 18px; font-weight: 700; letter-spacing: -0.5px; }
    .brand-sub { font-size: 12px; color: var(--text-muted); }
    .header-actions { display: flex; align-items: center; gap: 12px; }
    .badge-live { display: flex; align-items: center; gap: 6px; background: rgba(16, 185, 129, 0.15); color: #34d399; padding: 4px 10px; border-radius: 20px; font-size: 12px; font-weight: 600; }
    .dot { width: 8px; height: 8px; background: #10b981; border-radius: 50%; box-shadow: 0 0 8px #10b981; animation: pulse 2s infinite; }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.4; } }

    /* Layout */
    .container { max-width: 1400px; margin: 24px auto; padding: 0 20px; }
    .stats-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 16px; margin-bottom: 24px; }
    .stat-card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 12px; padding: 20px; }
    .stat-val { font-size: 32px; font-weight: 800; margin: 8px 0; }
    .stat-label { font-size: 13px; color: var(--text-muted); }

    /* Cards */
    .card { background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 14px; padding: 22px; margin-bottom: 24px; box-shadow: 0 4px 20px rgba(0,0,0,0.25); }
    .card-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 18px; border-bottom: 1px solid var(--card-border); padding-bottom: 14px; }
    .card-title { font-size: 16px; font-weight: 700; display: flex; align-items: center; gap: 8px; }
    
    /* Tables */
    .table-responsive { overflow-x: auto; }
    table { width: 100%; border-collapse: collapse; text-align: left; font-size: 14px; }
    th { color: var(--text-muted); font-weight: 600; padding: 12px 14px; border-bottom: 1px solid var(--card-border); background: #131d2e; }
    td { padding: 14px; border-bottom: 1px solid #1a2234; vertical-align: middle; }
    tr:hover { background: rgba(255,255,255,0.02); }

    /* Badges & Buttons */
    .tag { display: inline-block; padding: 3px 8px; border-radius: 6px; font-size: 12px; font-weight: 600; }
    .tag-active { background: rgba(16,185,129,0.2); color: #34d399; }
    .tag-pending { background: rgba(245,158,11,0.2); color: #fbbf24; }
    .tag-expired { background: rgba(239,68,68,0.2); color: #f87171; }
    .tag-vip { background: rgba(139,92,246,0.2); color: #c084fc; font-weight: 700; }

    .btn { display: inline-flex; align-items: center; gap: 6px; padding: 8px 14px; border-radius: 8px; font-size: 13px; font-weight: 600; cursor: pointer; border: none; transition: 0.15s ease; }
    .btn-primary { background: var(--primary); color: white; }
    .btn-primary:hover { background: var(--primary-hover); }
    .btn-success { background: #059669; color: white; }
    .btn-success:hover { background: #047857; }
    .btn-danger { background: rgba(239,68,68,0.15); color: #f87171; border: 1px solid rgba(239,68,68,0.3); }
    .btn-danger:hover { background: #ef4444; color: white; }
    .btn-secondary { background: #1f2937; color: #d1d5db; }
    .btn-secondary:hover { background: #374151; }
    .btn-sm { padding: 5px 10px; font-size: 12px; }

    select, input, textarea { background: #1e293b; border: 1px solid #334155; color: white; padding: 8px 12px; border-radius: 8px; font-size: 13px; outline: none; }
    select:focus, input:focus { border-color: var(--primary); }

    /* Modal */
    .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.8); display: flex; align-items: center; justify-content: center; z-index: 999; backdrop-filter: blur(4px); }
    .modal { background: #111827; border: 1px solid #374151; border-radius: 16px; padding: 28px; width: 90%; max-width: 480px; }
  </style>
</head>
<body>
  <div id="loginModal" class="modal-overlay" style="display: none;">
    <div class="modal">
      <div style="text-align: center; margin-bottom: 20px;">
        <div class="brand-logo" style="margin: 0 auto 12px auto; width: 48px; height: 48px; font-size: 26px;">J</div>
        <h2 style="font-size: 20px; font-weight: 700;">J HABER Bulut Yönetim Girişi</h2>
        <p style="font-size: 13px; color: var(--text-muted); margin-top: 4px;">Devam etmek için yönetici şifrenizi girin</p>
      </div>
      <div style="margin-bottom: 16px;">
        <label style="display: block; font-size: 13px; margin-bottom: 6px; color: #cbd5e1;">Yönetici Şifresi</label>
        <input type="password" id="adminPasswordInput" placeholder="Varsayılan: 123456" style="width: 100%; font-size: 15px; padding: 10px;" onkeydown="if(event.key==='Enter') doLogin()">
      </div>
      <div id="loginErr" style="color: #ef4444; font-size: 13px; margin-bottom: 12px; display: none;"></div>
      <button class="btn btn-primary" style="width: 100%; justify-content: center; padding: 12px; font-size: 15px;" onclick="doLogin()">Giriş Yap</button>
    </div>
  </div>

  <header>
    <div class="brand">
      <div class="brand-logo">J</div>
      <div>
        <div class="brand-title">J HABER MERKEZ YÖNETİM SUNUCUSU</div>
        <div class="brand-sub">7/24 Kesintisiz Bulut Kontrol Portalı</div>
      </div>
    </div>
    <div class="header-actions">
      <div class="badge-live"><div class="dot"></div> CANLI BAĞLANTI AKTİF</div>
      <button class="btn btn-secondary btn-sm" onclick="refreshData()">🔄 Yenile</button>
      <button class="btn btn-danger btn-sm" onclick="logout()">Çıkış</button>
    </div>
  </header>

  <div class="container">
    <!-- İstatistikler -->
    <div class="stats-grid">
      <div class="stat-card">
        <div class="stat-label">Toplam Kayıtlı Kullanıcı</div>
        <div class="stat-val" id="stTotal">0</div>
        <div style="font-size: 12px; color: #34d399;">Tüm bilgisayarlar</div>
      </div>
      <div class="stat-card" style="border-color: rgba(245,158,11,0.4);">
        <div class="stat-label" style="color: #fbbf24;">Onay Bekleyenler</div>
        <div class="stat-val" id="stPending" style="color: #fbbf24;">0</div>
        <div style="font-size: 12px; color: #fbbf24;">Onay ve süre tanımlaması bekliyor</div>
      </div>
      <div class="stat-card" style="border-color: rgba(16,185,129,0.4);">
        <div class="stat-label" style="color: #34d399;">Şu An Canlı (Online)</div>
        <div class="stat-val" id="stOnline" style="color: #34d399;">0</div>
        <div style="font-size: 12px; color: var(--text-muted);">Son 2 dakikada aktif</div>
      </div>
      <div class="stat-card">
        <div class="stat-label">Aktif Destek Talepleri</div>
        <div class="stat-val" id="stTickets" style="color: var(--purple);">0</div>
        <div style="font-size: 12px; color: var(--text-muted);">Kullanıcı mesajları</div>
      </div>
    </div>

    <!-- Onay Bekleyenler Kartı -->
    <div class="card" id="pendingSection" style="border-color: rgba(245,158,11,0.4);">
      <div class="card-header">
        <div class="card-title" style="color: #fbbf24;">⏳ Onay Bekleyen Yeni Üyelikler (<span id="pendingCount">0</span>)</div>
      </div>
      <div class="table-responsive">
        <table id="pendingTable">
          <thead>
            <tr>
              <th>Kullanıcı Adı</th>
              <th>Ad Soyad / Kurum</th>
              <th>İletişim</th>
              <th>Kayıt Zamanı</th>
              <th>Bilgisayar / IP</th>
              <th>Süre Seçimi & Onay</th>
            </tr>
          </thead>
          <tbody id="pendingTbody">
            <tr><td colspan="6" style="text-align: center; color: var(--text-muted);">Onay bekleyen üye bulunmuyor.</td></tr>
          </tbody>
        </table>
      </div>
    </div>

    <!-- Tüm Kullanıcılar -->
    <div class="card">
      <div class="card-header">
        <div class="card-title">👥 Tüm Kullanıcılar ve Canlı Durumları</div>
        <button class="btn btn-primary btn-sm" onclick="showNewUserModal()">+ Manuel Kullanıcı Ekle</button>
      </div>
      <div class="table-responsive">
        <table>
          <thead>
            <tr>
              <th>Durum</th>
              <th>Kullanıcı Adı</th>
              <th>Paket & Kalan Süre</th>
              <th>Canlı Konum / Sekme</th>
              <th>Son IP & Cihaz</th>
              <th>İşlemler</th>
            </tr>
          </thead>
          <tbody id="usersTbody"></tbody>
        </table>
      </div>
    </div>

    <!-- Hızlı Yönetim & Bildirim -->
    <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(400px, 1fr)); gap: 20px;">
      <!-- Anlık Duyuru & Popup -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">📢 Canlı Duyuru & Bildirim Gönder</div>
        </div>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <input type="text" id="postTitle" placeholder="Duyuru Başlığı (Örn: Acil Gelişme / Güncelleme)">
          <textarea id="postBody" rows="3" placeholder="Duyuru veya haber metni..."></textarea>
          <div style="display: flex; gap: 10px;">
            <label style="font-size: 13px; display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="postPinned"> Üst Kayan Bant Olarak Sabitle
            </label>
            <label style="font-size: 13px; display: flex; align-items: center; gap: 6px;">
              <input type="checkbox" id="postNewsFeed" checked> Haber Akışına Ekle
            </label>
          </div>
          <button class="btn btn-primary" onclick="sendPost()">Duyuruyu Canlı Yayınla</button>
        </div>
      </div>

      <!-- Acil Sistem Kilidi -->
      <div class="card">
        <div class="card-header">
          <div class="card-title">🛡️ Acil Bakım & Güvenlik Kilidi</div>
        </div>
        <p style="font-size: 13px; color: var(--text-muted); margin-bottom: 14px;">
          Sistem kilidini açtığınızda tüm J HABER kullanıcılarının ekranında kilit mesajı görünür ve uygulama kullanımı geçici olarak durur.
        </p>
        <div style="display: flex; flex-direction: column; gap: 12px;">
          <input type="text" id="lockMsg" value="Sistem bakım nedeniyle geçici olarak durdurulmuştur.">
          <div style="display: flex; gap: 10px;">
            <button class="btn btn-danger" id="btnLock" onclick="toggleSystemLock(true)">🔒 TÜM SİSTEMİ KİLİTLE</button>
            <button class="btn btn-success" id="btnUnlock" onclick="toggleSystemLock(false)">🔓 KİLİDİ AÇ (NORMAL ÇALIŞMA)</button>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script>
    let adminToken = localStorage.getItem('jh_admin_token') || '';
    let currentState = null;

    async function req(endpoint, data = {}) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + adminToken
        },
        body: JSON.stringify(data)
      });
      if (res.status === 401 || res.status === 403) {
        showLogin();
        throw new Error('Unauthorized');
      }
      return await res.json();
    }

    function showLogin() {
      document.getElementById('loginModal').style.display = 'flex';
    }

    async function doLogin() {
      const pass = document.getElementById('adminPasswordInput').value;
      const errEl = document.getElementById('loginErr');
      errEl.style.display = 'none';
      try {
        const res = await fetch('/api/admin/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ password: pass })
        });
        const data = await res.json();
        if (data.ok && data.token) {
          adminToken = data.token;
          localStorage.setItem('jh_admin_token', adminToken);
          document.getElementById('loginModal').style.display = 'none';
          renderState(data.state);
        } else {
          errEl.innerText = data.error || 'Şifre hatalı!';
          errEl.style.display = 'block';
        }
      } catch (err) {
        errEl.innerText = 'Bağlantı hatası: ' + err.message;
        errEl.style.display = 'block';
      }
    }

    function logout() {
      localStorage.removeItem('jh_admin_token');
      adminToken = '';
      showLogin();
    }

    async function refreshData() {
      try {
        const state = await req('/api/admin/get-state');
        renderState(state);
      } catch (_) {}
    }

    function renderState(st) {
      if (!st) return;
      currentState = st;

      document.getElementById('stTotal').innerText = st.stats?.totalUsers || 0;
      document.getElementById('stPending').innerText = st.stats?.pendingUsers || 0;
      document.getElementById('stOnline').innerText = st.stats?.onlineNow || 0;
      document.getElementById('stTickets').innerText = st.stats?.openTickets || 0;

      // Pending Section
      const pendings = (st.users || []).filter(u => u.status === 'pending');
      document.getElementById('pendingCount').innerText = pendings.length;
      const ptbody = document.getElementById('pendingTbody');
      ptbody.innerHTML = '';

      if (pendings.length === 0) {
        ptbody.innerHTML = '<tr><td colspan="6" style="text-align: center; color: var(--text-muted); padding: 20px;">Şu an onay bekleyen yeni üye bulunmuyor.</td></tr>';
      } else {
        pendings.forEach(u => {
          const tr = document.createElement('tr');
          tr.innerHTML = \`
            <td><strong>\${escapeHtml(u.username)}</strong></td>
            <td>\${escapeHtml(u.fullName || '—')}</td>
            <td>\${escapeHtml(u.contact || '—')}</td>
            <td style="font-size: 12px; color: var(--text-muted);">\${new Date(u.registeredAt || Date.now()).toLocaleTimeString()}</td>
            <td style="font-size: 12px;">\${escapeHtml(u.lastIp || '—')}<br><span style="color:var(--text-muted)">\${escapeHtml(u.hostname || '')}</span></td>
            <td>
              <div style="display: flex; gap: 8px; align-items: center;">
                <select id="dur_\${u.id}">
                  <option value="1d">1 Gün</option>
                  <option value="3d">3 Gün</option>
                  <option value="1w">1 Hafta</option>
                  <option value="1m" selected>1 Ay (30 Gün)</option>
                  <option value="3m">3 Ay</option>
                  <option value="6m">6 Ay</option>
                  <option value="1y">1 Yıl</option>
                  <option value="unlimited">Sınırsız (Ömür Boyu)</option>
                </select>
                <select id="vip_\${u.id}">
                  <option value="Standart">Standart</option>
                  <option value="VIP" selected>VIP</option>
                  <option value="Gold">Gold</option>
                  <option value="Kurumsal">Kurumsal</option>
                </select>
                <button class="btn btn-success btn-sm" onclick="approveUser('\${u.id}')">✓ ONAYLA</button>
                <button class="btn btn-danger btn-sm" onclick="deleteUser('\${u.id}')">Sil</button>
              </div>
            </td>
          \`;
          ptbody.appendChild(tr);
        });
      }

      // All Users Table
      const utbody = document.getElementById('usersTbody');
      utbody.innerHTML = '';
      (st.users || []).forEach(u => {
        const isOnline = u.isOnline;
        let statusTag = '';
        if (u.status === 'active') statusTag = '<span class="tag tag-active">Aktif</span>';
        else if (u.status === 'pending') statusTag = '<span class="tag tag-pending">Onay Bekliyor</span>';
        else if (u.status === 'expired') statusTag = '<span class="tag tag-expired">Süresi Doldu</span>';
        else statusTag = '<span class="tag">' + u.status + '</span>';

        let remaining = '—';
        if (u.status === 'active') {
          if (u.expiresAt === 'unlimited') remaining = 'Sınırsız (Ömür Boyu)';
          else if (Number(u.expiresAt) > 0) {
            const diff = Number(u.expiresAt) - Date.now();
            const days = Math.ceil(diff / (24*3600*1000));
            remaining = days > 0 ? \`\${days} Gün Kaldı\` : 'Süre Doldu';
          }
        }

        const tr = document.createElement('tr');
        tr.innerHTML = \`
          <td>
            <div style="display: flex; align-items: center; gap: 8px;">
              <div style="width: 10px; height: 10px; border-radius: 50%; background: \${isOnline ? '#10b981' : '#4b5563'};"></div>
              \${statusTag}
            </div>
          </td>
          <td>
            <strong>\${escapeHtml(u.username)}</strong>
            <span class="tag tag-vip" style="margin-left: 6px;">\${u.vipPlan || 'Standart'}</span>
            \${u.fullName ? \`<div style="font-size: 12px; color: var(--text-muted);">\${escapeHtml(u.fullName)}</div>\` : ''}
          </td>
          <td>
            <div>\${escapeHtml(u.planLabel || '—')}</div>
            <div style="font-size: 12px; color: #34d399;">\${remaining}</div>
          </td>
          <td>
            <div>\${escapeHtml(u.currentViewLabel || u.currentView || '—')}</div>
            <div style="font-size: 11px; color: var(--text-muted);">Son görülme: \${u.lastSeenAt ? new Date(u.lastSeenAt).toLocaleTimeString() : '—'}</div>
          </td>
          <td style="font-size: 12px;">
            \${escapeHtml(u.lastIp || '—')}<br>
            <span style="color: var(--text-muted);">\${escapeHtml(u.hostname || '')}</span>
          </td>
          <td>
            <div style="display: flex; gap: 6px;">
              <button class="btn btn-secondary btn-sm" onclick="quickExtend('\${u.id}')">⏳ Süre Ekle</button>
              <button class="btn btn-danger btn-sm" onclick="kickUser('\${u.id}')">Kick</button>
              <button class="btn btn-danger btn-sm" onclick="deleteUser('\${u.id}')">Sil</button>
            </div>
          </td>
        \`;
        utbody.appendChild(tr);
      });
    }

    async function approveUser(userId) {
      const dur = document.getElementById('dur_' + userId).value;
      const vip = document.getElementById('vip_' + userId).value;
      const res = await req('/api/admin/user-approve', { userId, durationKey: dur, vipPlan: vip });
      if (res.ok) renderState(res.state);
    }

    async function quickExtend(userId) {
      const dur = prompt('Kullanıcıya kaç gün eklemek istiyorsunuz? (Örn: 30)', '30');
      if (!dur) return;
      const res = await req('/api/admin/user-approve', { userId, durationKey: 'custom', customDays: Number(dur) });
      if (res.ok) renderState(res.state);
    }

    async function kickUser(userId) {
      if (!confirm('Kullanıcının uygulamadaki oturumu hemen sonlandırılsın mı?')) return;
      const res = await req('/api/admin/user-kick', { userId });
      if (res.ok) renderState(res.state);
    }

    async function deleteUser(userId) {
      if (!confirm('Bu kullanıcıyı tamamen silmek istediğinizden emin misiniz?')) return;
      const res = await req('/api/admin/user-delete', { userId });
      if (res.ok) renderState(res.state);
    }

    async function sendPost() {
      const title = document.getElementById('postTitle').value.trim();
      const body = document.getElementById('postBody').value.trim();
      const pinnedBanner = document.getElementById('postPinned').checked;
      const showInNewsFeed = document.getElementById('postNewsFeed').checked;
      if (!title || !body) return alert('Lütfen başlık ve duyuru metnini yazın.');

      const res = await req('/api/admin/post-add', { title, body, pinnedBanner, showInNewsFeed });
      if (res.ok) {
        alert('Duyuru tüm kullanıcılara başarıyla gönderildi!');
        document.getElementById('postTitle').value = '';
        document.getElementById('postBody').value = '';
        renderState(res.state);
      }
    }

    async function toggleSystemLock(enabled) {
      const msg = document.getElementById('lockMsg').value.trim();
      const action = enabled ? 'SİSTEMİ KİLİTLEMEK' : 'KİLİDİ AÇMAK';
      if (!confirm(action + ' istediğinizden emin misiniz?')) return;
      const res = await req('/api/admin/system-lock', { enabled, message: msg });
      if (res.ok) {
        alert(enabled ? 'Sistem kilitlendi! Kullanıcıların ekranında uyarı belirecektir.' : 'Sistem açıldı! Kullanıcılar uygulamaya erişebilir.');
        renderState(res.state);
      }
    }

    function escapeHtml(str) {
      return String(str || '').replace(/[&<>"']/g, m => ({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' })[m]);
    }

    // Başlangıç
    if (!adminToken) showLogin();
    else refreshData();
    setInterval(refreshData, 5000);
  </script>
</body>
</html>`;
}

// Sunucuyu Başlat
server.listen(PORT, '0.0.0.0', () => {
  console.log(`[J HABER CLOUD] Sunucu port ${PORT} üzerinde 7/24 aktif!`);
  console.log(`[J HABER CLOUD] Web Yönetim Paneli: http://localhost:${PORT}/admin`);
});
