/**
 * app.js — 纯前端数据层（localStorage + JSON）
 * 替代 server.js 的所有 API 逻辑，部署到 GitHub Pages 静态托管
 *
 * 数据集合（localStorage keys）：
 *   pgf_users          : 用户数组
 *   pgf_apps           : 管理员申请数组
 *   pgf_kicks          : 踢人申请数组
 *   pgf_tours          : 赛事数组
 *   pgf_settings       : 系统设置（含超管凭据、主密钥、安全 PIN 等）
 *   pgf_session        : 当前会话登录态
 *   pgf_codes_{email}  : 验证码（带过期时间）
 *
 * 注意：localStorage 是浏览器本地存储，不同浏览器/设备之间数据不共享。
 */

const DB = (() => {
  const K = {
    users: 'pgf_users',
    apps: 'pgf_apps',
    kicks: 'pgf_kicks',
    tours: 'pgf_tours',
    settings: 'pgf_settings',
    session: 'pgf_session',
  };

  // ===== 通用工具 =====
  const read = (k, def) => {
    try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : def; }
    catch (e) { return def; }
  };
  const write = (k, v) => localStorage.setItem(k, JSON.stringify(v));
  const uid = (p = 'id') => p + '_' + Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
  const now = () => Date.now();
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const genCode = () => String(Math.floor(100000 + Math.random() * 900000));
  const maskEmail = (e) => {
    const [n, d] = e.split('@');
    if (!d) return e;
    return (n.slice(0, 3) + '***@' + d);
  };
  // 生成专属口令 GAME-XXXX-XXXXXX
  const genPassphrase = () => {
    const a = String(Math.floor(1000 + Math.random() * 9000));
    const b = String(Math.floor(100000 + Math.random() * 900000));
    return 'GAME-' + a + '-' + b;
  };
  // 生成超管主密钥（首次初始化时用）
  const genMasterKey = () => {
    const hex = '0123456789abcdef';
    let s = '';
    for (let i = 0; i < 16; i++) s += hex[Math.floor(Math.random() * 16)];
    return 'MK-' + s;
  };
  // 6位安全 PIN
  const genPIN = () => String(Math.floor(100000 + Math.random() * 900000));

  // ===== 摩斯密码编码（用于存储密码）=====
  // 规则：字符 → 摩斯码 → "." 替换为 "-"，"-" 替换为 "=" → 各字符用 "|" 分隔
  //       没有摩斯码的字符（空格、特殊符号等）保持原样，同样用 "|" 分隔
  const MORSE = {
    'A':'.-','B':'-...','C':'-.-.','D':'-..','E':'.','F':'..-.','G':'--.','H':'....',
    'I':'..','J':'.---','K':'-.-','L':'.-..','M':'--','N':'-.','O':'---','P':'.--.',
    'Q':'--.-','R':'.-.','S':'...','T':'-','U':'..-','V':'...-','W':'.--','X':'-..-',
    'Y':'-.--','Z':'--..',
    '0':'-----','1':'.----','2':'..---','3':'...--','4':'....-','5':'.....',
    '6':'-....','7':'--...','8':'---..','9':'----.',
    '.':'.-.-.-',',':'--..--','?':'..--..',"'":'.----.','!':'-.-.--','/':'-..-.',
    '(':'-.--.',')':'-.--.-','&':'.-...',':':'---...',';':'-.-.-.','=':'-...-',
    '-':'-....-','+':'.-.-.','_':'..--.-','"':'.-..-.','$':'...-..-','@':'.--.-.',
  };
  // 反向表：摩斯码 → 字符
  const MORSE_REV = {};
  Object.keys(MORSE).forEach(ch => { MORSE_REV[MORSE[ch]] = ch; });

  // 编码：明文 → 摩斯变体字符串
  function encodeMorse(text) {
    if (text == null) return '';
    return String(text).split('').map(ch => {
      const up = ch.toUpperCase();
      const m = MORSE[up];
      if (m !== undefined) {
        // 摩斯码里 "." → "-"，"-" → "="
        return m.replace(/\./g, '-').replace(/-/g, '=');
      }
      // 无摩斯码的字符（空格、其他符号）保持原样
      return ch;
    }).join('|');
  }

  // 解码：摩斯变体字符串 → 明文（用于「解锁」）
  function decodeMorse(encoded) {
    if (encoded == null) return '';
    return String(encoded).split('|').map(seg => {
      if (seg === '') return '';
      // 只含 "-" 和 "=" 的段是摩斯码；其他原样返回
      if (/^[-=]+$/.test(seg)) {
        const m = seg.replace(/-/g, '.').replace(/=/g, '-');
        return MORSE_REV[m] !== undefined ? MORSE_REV[m] : seg;
      }
      return seg;
    }).join('');
  }

  // 密码比对：把输入编码后与存储值比对（等价于「解锁存储值再对比」）
  function verifyMorse(input, stored) {
    // 兼容旧明文密码：不含 "|" 和 "=" 的存储值视为旧明文，直接比对
    if (stored && !stored.includes('|') && !stored.includes('=')) {
      return input === stored;
    }
    return encodeMorse(input) === stored;
  }

  // ===== 初始化（首次访问）=====
  // 超管凭据为硬编码（由用户指定）
  function init() {
    let s = read(K.settings, null);
    if (!s || !s.superAdminPasswordA) {
      s = {
        superAdminUsername: 'MoSS',
        superAdminPasswordA: encodeMorse('M-Cat@1012'),
        superAdminPasswordB: encodeMorse('MOSCATO'),
        superAdminEmail: 'moscatolin@qq.com',
        superAdminEmailBackup: 'jlin100@huitongschool.cn',
        createdAt: now(),
        initialized: true,
      };
      write(K.settings, s);
    }
    if (!localStorage.getItem(K.users)) write(K.users, []);
    if (!localStorage.getItem(K.apps)) write(K.apps, []);
    if (!localStorage.getItem(K.kicks)) write(K.kicks, []);
    if (!localStorage.getItem(K.tours)) write(K.tours, []);
  }

  // ===== 会话管理 =====
  function setSession(user) {
    const s = { userId: user.id, username: user.username, role: user.role, ts: now() };
    write(K.session, s);
    return s;
  }
  function getSession() { return read(K.session, null); }
  function clearSession() { localStorage.removeItem(K.session); }

  // ===== 用户操作 =====
  const users = {
    all: () => read(K.users, []),
    findByUsername(name) { return this.all().find(u => u.username === name); },
    findByEmail(email) { return this.all().find(u => u.email === email); },
    findById(id) { return this.all().find(u => u.id === id); },
    findByAccount(acc) {
      return this.all().find(u => u.username === acc || u.email === acc);
    },
    add(u) {
      const arr = this.all();
      arr.push(u);
      write(K.users, arr);
      return u;
    },
    update(id, patch) {
      const arr = this.all();
      const i = arr.findIndex(u => u.id === id);
      if (i >= 0) {
        arr[i] = { ...arr[i], ...patch };
        write(K.users, arr);
        return arr[i];
      }
      return null;
    },
    remove(id) {
      const arr = this.all().filter(u => u.id !== id);
      write(K.users, arr);
    },
  };

  // ===== 验证码 =====
  const codeKey = (email) => 'pgf_codes_' + email;
  function setCode(email, type) {
    const code = genCode();
    const data = { code, type, expires: now() + 5 * 60 * 1000 };
    localStorage.setItem(codeKey(email), JSON.stringify(data));
    return code; // 直接返回，由调用方在页面显示
  }
  function getCode(email) {
    try {
      const v = JSON.parse(localStorage.getItem(codeKey(email)) || 'null');
      if (!v) return null;
      if (Date.now() > v.expires) { localStorage.removeItem(codeKey(email)); return null; }
      return v;
    } catch (e) { return null; }
  }
  function clearCode(email) { localStorage.removeItem(codeKey(email)); }

  // ===== 业务 API =====

  // 普通用户注册验证码
  function sendRegisterCode(email) {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, msg: '邮箱格式不正确' };
    }
    if (users.findByEmail(email)) return { ok: false, msg: '该邮箱已注册' };
    const code = setCode(email, 'register');
    return { ok: true, code, msg: '验证码已生成（页面显示）' };
  }

  // 忘记密码验证码
  function sendResetCode(email) {
    if (!email) return { ok: false, msg: '请先填写邮箱' };
    if (!users.findByEmail(email)) return { ok: false, msg: '该邮箱未注册' };
    const code = setCode(email, 'reset');
    return { ok: true, code, msg: '验证码已生成（页面显示）' };
  }

  // 注册
  function register({ username, email, password, code }) {
    if (!username || username.length < 2) return { ok: false, msg: '用户名至少2位' };
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return { ok: false, msg: '邮箱格式不正确' };
    if (!password || password.length < 6) return { ok: false, msg: '密码至少6位' };
    if (users.findByUsername(username)) return { ok: false, msg: '用户名已存在' };
    if (users.findByEmail(email)) return { ok: false, msg: '邮箱已注册' };
    const c = getCode(email);
    if (!c || c.code !== code) return { ok: false, msg: '验证码错误或已过期' };
    clearCode(email);
    const u = {
      id: uid('u'), username, email, password: encodeMorse(password),
      role: 'user', banned: false, banReason: '',
      createdAt: now(),
    };
    users.add(u);
    return { ok: true, user: u };
  }

  // 登录
  function login({ account, password }) {
    if (!account || !password) return { ok: false, msg: '请填写账号密码' };
    const u = users.findByAccount(account);
    if (!u) return { ok: false, msg: '账号不存在' };
    if (u.banned) return { ok: false, msg: '账号已封禁：' + (u.banReason || '无') };
    if (!verifyMorse(password, u.password)) return { ok: false, msg: '密码错误' };
    setSession(u);
    return { ok: true, user: { id: u.id, username: u.username, email: u.email, role: u.role } };
  }

  // 重置密码
  function resetPassword({ email, code, newPassword }) {
    if (!email || !code || !newPassword) return { ok: false, msg: '请填写完整' };
    if (newPassword.length < 6) return { ok: false, msg: '密码至少6位' };
    const u = users.findByEmail(email);
    if (!u) return { ok: false, msg: '邮箱未注册' };
    const c = getCode(email);
    if (!c || c.code !== code) return { ok: false, msg: '验证码错误或已过期' };
    clearCode(email);
    users.update(u.id, { password: encodeMorse(newPassword) });
    return { ok: true };
  }

  // ===== 管理员申请 =====
  function adminApply({ passwordA, passwordB, reason }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (!passwordA || passwordA.length < 6) return { ok: false, msg: '密码A至少6位' };
    if (!passwordB || passwordB.length < 6) return { ok: false, msg: '密码B至少6位' };
    if (passwordA === passwordB) return { ok: false, msg: '密码A与B不能相同' };
    if (!reason || reason.length < 5) return { ok: false, msg: '请填写申请理由（至少5字）' };
    const u = users.findById(s.userId);
    if (!u) return { ok: false, msg: '用户不存在' };
    if (u.role !== 'user') return { ok: false, msg: '你已是管理员或超管' };
    const arr = read(K.apps, []);
    // 拒绝后可以再申请；待审核中不能再申请
    const pend = arr.find(a => a.userId === u.id && a.status === 'pending');
    if (pend) return { ok: false, msg: '已提交过申请，审核中' };
    const app = {
      id: uid('app'), userId: u.id, username: u.username, email: u.email,
      passwordA: encodeMorse(passwordA), passwordB: encodeMorse(passwordB),
      reason, status: 'pending',
      passphrase: '', rejectReason: '', createdAt: now(),
    };
    arr.push(app);
    write(K.apps, arr);
    return { ok: true };
  }

  function adminApplyStatus() {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    const arr = read(K.apps, []).filter(a => a.userId === s.userId);
    return { ok: true, applications: arr };
  }

  // 管理员登录验证码
  function sendAdminCode(email) {
    if (!email) return { ok: false, msg: '请先填写邮箱' };
    const u = users.findByEmail(email);
    if (!u) return { ok: false, msg: '该邮箱不存在' };
    if (u.role !== 'admin') return { ok: false, msg: '该账号非管理员' };
    const code = setCode(email, 'admin');
    return { ok: true, code, msg: '验证码已生成（页面显示）' };
  }

  // 管理员三重验证登录
  function adminLogin({ email, code, passwordA, passwordB, username, passphrase }) {
    if (!email || !code || !passwordA || !passwordB || !username || !passphrase) {
      return { ok: false, msg: '所有字段必填' };
    }
    const u = users.findByEmail(email);
    if (!u) return { ok: false, msg: '邮箱不存在' };
    if (u.role !== 'admin') return { ok: false, msg: '非管理员账号' };
    if (u.banned) return { ok: false, msg: '账号已封禁' };
    if (u.username !== username) return { ok: false, msg: '用户名不匹配' };
    const c = getCode(email);
    if (!c || c.code !== code) return { ok: false, msg: '验证码错误或已过期' };
    if (!verifyMorse(passwordA, u.adminPasswordA)) return { ok: false, msg: '密码A错误' };
    if (!verifyMorse(passwordB, u.adminPasswordB)) return { ok: false, msg: '密码B错误' };
    if (u.adminPassphrase !== passphrase) return { ok: false, msg: '口令错误' };
    clearCode(email);
    setSession(u);
    return { ok: true, user: { id: u.id, username: u.username, role: u.role } };
  }

  // 发布赛事
  function publishTournament({ title, gameType, description, winCondition, maxPlayers }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (s.role !== 'admin') return { ok: false, msg: '仅管理员可发布' };
    if (!title) return { ok: false, msg: '请填写赛事名称' };
    if (!winCondition) return { ok: false, msg: '请填写输赢条件（你自行编写，bug导致比赛无法运行后果自负）' };
    const arr = read(K.tours, []);
    const t = {
      id: uid('t'), title, gameType: gameType || '', description: description || '',
      winCondition, maxPlayers: parseInt(maxPlayers) || 8,
      createdBy: s.username, createdByUserId: s.userId,
      status: 'active', cancelReason: '', createdAt: now(),
    };
    arr.push(t);
    write(K.tours, arr);
    return { ok: true, tournament: t };
  }

  function myTournaments() {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    const arr = read(K.tours, []).filter(t => t.createdByUserId === s.userId);
    return { ok: true, tournaments: arr };
  }

  function updateTournament({ id, status }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    const arr = read(K.tours, []);
    const i = arr.findIndex(t => t.id === id);
    if (i < 0) return { ok: false, msg: '赛事不存在' };
    if (arr[i].createdByUserId !== s.userId) return { ok: false, msg: '无权操作' };
    arr[i].status = status;
    write(K.tours, arr);
    return { ok: true };
  }

  function kickRequest({ targetUsername, reason }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (!targetUsername) return { ok: false, msg: '请填写目标用户名' };
    if (!reason) return { ok: false, msg: '请填写理由' };
    const target = users.findByUsername(targetUsername);
    if (!target) return { ok: false, msg: '目标用户不存在' };
    if (target.role === 'superadmin') return { ok: false, msg: '不可踢超管' };
    const arr = read(K.kicks, []);
    const req = {
      id: uid('k'), requestedBy: s.username, requestedByUserId: s.userId,
      targetId: target.id, targetUsername, reason,
      status: 'pending', rejectReason: '', createdAt: now(),
    };
    arr.push(req);
    write(K.kicks, arr);
    return { ok: true };
  }

  function myKickRequests() {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    const arr = read(K.kicks, []).filter(k => k.requestedByUserId === s.userId);
    return { ok: true, requests: arr };
  }

  // 公开赛事列表
  function publicTournaments() {
    return { ok: true, tournaments: read(K.tours, []) };
  }

  // ===== 超管 =====
  function getSettings() { return read(K.settings, {}); }
  function updateSettings(patch) {
    const s = getSettings();
    const next = { ...s, ...patch };
    write(K.settings, next);
    return next;
  }

  // 超管邮箱验证码：可发送至主邮箱 A 或备份邮箱 B
  function superAdminSendCode(email) {
    const s = getSettings();
    if (email !== s.superAdminEmail && email !== s.superAdminEmailBackup) {
      return { ok: false, msg: '邮箱不匹配超管邮箱' };
    }
    const code = setCode(email, 'super');
    return { ok: true, code, msg: '验证码已生成（页面显示）' };
  }

  // 超管四重验证：用户名 + 密码A + 密码B + 邮箱验证码
  function superAdminLogin({ username, passwordA, passwordB, email, code }) {
    const s = getSettings();
    if (!username || !passwordA || !passwordB || !email || !code) {
      return { ok: false, msg: '所有字段必填' };
    }
    if (username !== s.superAdminUsername) return { ok: false, msg: '用户名错误' };
    if (!verifyMorse(passwordA, s.superAdminPasswordA)) return { ok: false, msg: '密码A错误' };
    if (!verifyMorse(passwordB, s.superAdminPasswordB)) return { ok: false, msg: '密码B错误' };
    if (email !== s.superAdminEmail && email !== s.superAdminEmailBackup) {
      return { ok: false, msg: '邮箱不匹配' };
    }
    const c = getCode(email);
    if (!c || c.code !== code) return { ok: false, msg: '邮箱验证码错误或已过期' };
    clearCode(email);
    setSession({ id: 'super', username: s.superAdminUsername, role: 'superadmin' });
    return { ok: true, username: s.superAdminUsername };
  }

  function superAdminUsers() {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    return { ok: true, users: users.all().map(u => ({ ...u })) };
  }

  function superAdminBan({ userId, banned }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    users.update(userId, { banned: !!banned, banReason: banned ? '总管理员封禁' : '' });
    return { ok: true, msg: banned ? '已封禁' : '已解封' };
  }

  function superAdminKick({ userId, reason }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    const u = users.findById(userId);
    if (!u) return { ok: false, msg: '用户不存在' };
    if (u.role === 'superadmin') return { ok: false, msg: '不可踢超管' };
    users.remove(userId);
    return { ok: true, msg: '已踢出 ' + u.username };
  }

  function superAdminApplications() {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    return { ok: true, applications: read(K.apps, []) };
  }

  function superAdminApproveApplication({ appId, action, rejectReason }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    const arr = read(K.apps, []);
    const i = arr.findIndex(a => a.id === appId);
    if (i < 0) return { ok: false, msg: '申请不存在' };
    const app = arr[i];
    if (app.status !== 'pending') return { ok: false, msg: '该申请已处理' };
    if (action === 'approve') {
      const passphrase = genPassphrase();
      arr[i].status = 'approved';
      arr[i].passphrase = passphrase;
      // 升级用户为管理员，写入管理员凭据
      users.update(app.userId, {
        role: 'admin',
        adminPasswordA: app.passwordA,
        adminPasswordB: app.passwordB,
        adminPassphrase: passphrase,
      });
      write(K.apps, arr);
      return { ok: true, passphrase, msg: '已批准，请通过安全渠道将口令告知该管理员' };
    } else if (action === 'reject') {
      arr[i].status = 'rejected';
      arr[i].rejectReason = rejectReason || '';
      write(K.apps, arr);
      return { ok: true, msg: '已拒绝' };
    }
    return { ok: false, msg: '未知操作' };
  }

  function superAdminKickRequests() {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    return { ok: true, requests: read(K.kicks, []) };
  }

  function superAdminApproveKick({ requestId, action }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    const arr = read(K.kicks, []);
    const i = arr.findIndex(k => k.id === requestId);
    if (i < 0) return { ok: false, msg: '申请不存在' };
    if (arr[i].status !== 'pending') return { ok: false, msg: '该申请已处理' };
    if (action === 'approve') {
      arr[i].status = 'approved';
      write(K.kicks, arr);
      // 执行踢出
      users.remove(arr[i].targetId);
      return { ok: true, msg: '已批准并踢出' };
    } else if (action === 'reject') {
      arr[i].status = 'rejected';
      write(K.kicks, arr);
      return { ok: true, msg: '已拒绝' };
    }
    return { ok: false, msg: '未知操作' };
  }

  function superAdminTournaments() {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    return { ok: true, tournaments: read(K.tours, []) };
  }

  function superAdminCancelTournament({ id, reason }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    const arr = read(K.tours, []);
    const i = arr.findIndex(t => t.id === id);
    if (i < 0) return { ok: false, msg: '赛事不存在' };
    arr[i].status = 'cancelled';
    arr[i].cancelReason = reason || '';
    write(K.tours, arr);
    return { ok: true, msg: '已取消' };
  }

  function superAdminChangePassword({ oldPassword, newPassword }) {
    const s = getSession();
    if (!s || s.role !== 'superadmin') return { ok: false, msg: '权限不足' };
    const cfg = getSettings();
    if (!verifyMorse(oldPassword, cfg.superAdminPasswordA)) return { ok: false, msg: '旧密码A错误' };
    if (!newPassword || newPassword.length < 6) return { ok: false, msg: '新密码至少6位' };
    updateSettings({ superAdminPasswordA: encodeMorse(newPassword) });
    return { ok: true, msg: '密码A已修改' };
  }

  // 初始化公开
  init();

  return {
    init,
    users,
    getSession, clearSession,
    maskEmail,
    // 用户 API
    sendRegisterCode, sendResetCode, register, login, resetPassword,
    adminApply, adminApplyStatus,
    sendAdminCode, adminLogin,
    publishTournament, myTournaments, updateTournament,
    kickRequest, myKickRequests,
    publicTournaments,
    // 超管 API
    getSettings,
    superAdminSendCode, superAdminLogin,
    superAdminUsers, superAdminBan, superAdminKick,
    superAdminApplications, superAdminApproveApplication,
    superAdminKickRequests, superAdminApproveKick,
    superAdminTournaments, superAdminCancelTournament,
    superAdminChangePassword,
  };
})();
