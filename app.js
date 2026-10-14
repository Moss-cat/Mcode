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
  const write = (k, v) => {
    localStorage.setItem(k, JSON.stringify(v));
    // 同步键：在本地写入完成后，fire-and-forget 推送到共享后端（若同步已启用）
    if (syncEnabled && SYNC_KEYS.indexOf(k) >= 0) pushOp(k, v);
  };
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

  // ===== 摩斯密码变体（大小写感知，用于存储密码）=====
  // 规则：字符 → 标准摩斯码 → 逐符号替换（"." 换 "-"，"-" 换 "="）
  //       → 段首加 "1"（大写）/ "0"（小写）；各段用 "|" 分隔
  //       没有摩斯码的字符（空格、其他符号等）原样保留，同样用 "|" 分隔
  // 关键：替换必须「逐符号一次性」完成，不能全局先把 "." 换 "-" 再把 "-" 换 "="，
  //       否则点与划会互相污染 —— 老实现正是因此既分不出大小写、又会撞码（B 与 H 同码）
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
  const MORSE_REV = {};
  Object.keys(MORSE).forEach(ch => { MORSE_REV[MORSE[ch]] = ch; });

  const TO_CODE = { '.': '-', '-': '=' };    // 编码方向：点 → - ，划 → =
  const FROM_CODE = { '-': '.', '=': '-' };  // 解码方向

  // 编码：明文 → 新密文（大小写感知）
  function encodeMorse(text) {
    if (text == null) return '';
    return String(text).split('').map(ch => {
      const m = MORSE[ch.toUpperCase()];
      if (m === undefined) return ch; // 无摩斯码的字符原样保留
      const body = m.split('').map(s => TO_CODE[s]).join('');
      const isLower = (ch === ch.toLowerCase()) && (ch !== ch.toUpperCase());
      return (isLower ? '0' : '1') + body;
    }).join('|');
  }

  // 解码：新密文 → 明文（用于「解锁」）
  function decodeMorse(encoded) {
    if (encoded == null) return '';
    return String(encoded).split('|').map(seg => {
      if (seg === '') return '';
      const m = /^([01])([-=]+)$/.exec(seg);
      if (!m) return seg; // 非摩斯段，原样返回
      const std = m[2].split('').map(s => FROM_CODE[s]).join('');
      const ch = MORSE_REV[std];
      if (ch === undefined) return seg;
      return m[1] === '0' ? ch.toLowerCase() : ch;
    }).join('');
  }

  // 旧版编码（存在撞码缺陷，仅用于兼容校验已存在的旧格式密文，不再用于新写入）
  function encodeMorseOld(text) {
    if (text == null) return '';
    return String(text).split('').map(ch => {
      const up = ch.toUpperCase();
      const m = MORSE[up];
      if (m !== undefined) {
        return m.replace(/\./g, '-').replace(/-/g, '=');
      }
      return ch;
    }).join('|');
  }

  // 判断 stored 是否为「旧格式」密文（含旧明文）
  function isOldMorseFormat(stored) {
    if (!stored) return false;
    // 不含 "|" 也不含 "=" → 旧明文密码
    if (!stored.includes('|') && !stored.includes('=')) return true;
    // 任一段以 0/1 开头后跟 [-=] → 新格式；否则视为旧格式
    const segs = String(stored).split('|');
    return !segs.some(seg => /^[01][-=]+$/.test(seg));
  }

  // 密码比对：兼容旧明文 / 旧格式 / 新格式
  function verifyMorse(input, stored) {
    if (stored == null) return false;
    if (!stored.includes('|') && !stored.includes('=')) {
      return input === stored; // 旧明文
    }
    if (isOldMorseFormat(stored)) {
      return encodeMorseOld(input) === stored;
    }
    return encodeMorse(input) === stored;
  }

  // 透明升级：若 stored 为旧格式且 input 校验通过，返回新格式密文；否则原样返回
  // 用于登录成功后把存量旧密文原地升级为新格式（不影响用户输入习惯）
  function reencodeMorse(input, stored) {
    if (stored == null) return stored;
    if (!isOldMorseFormat(stored)) return stored;
    if (!verifyMorse(input, stored)) return stored;
    return encodeMorse(input);
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
    // raw 包含 _deleted 墓碑标记；all 对外隐藏墓碑
    raw: () => read(K.users, []),
    all() { return this.raw().filter(u => !u || !u._deleted); },
    findByUsername(name) { return this.all().find(u => u.username === name); },
    findByEmail(email) { return this.all().find(u => u.email === email); },
    findById(id) { return this.all().find(u => u.id === id); },
    findByAccount(acc) {
      return this.all().find(u => u.username === acc || u.email === acc);
    },
    add(u) {
      const arr = this.raw();
      arr.push(u);
      write(K.users, arr);
      return u;
    },
    update(id, patch) {
      const arr = this.raw();
      const i = arr.findIndex(u => u.id === id && !u._deleted);
      if (i >= 0) {
        arr[i] = { ...arr[i], ...patch };
        write(K.users, arr);
        return arr[i];
      }
      return null;
    },
    remove(id) {
      // 先移除目标，再写入一条 _deleted 墓碑标记，让同步两端都能按 id 删除该用户
      const arr = this.raw().filter(u => u.id !== id || u._deleted);
      arr.push({ id, _deleted: true });
      write(K.users, arr);
    },
  };

  // ===== 验证码 =====
  const codeKey = (email) => 'pgf_codes_' + email;
  function setCode(email, type) {
    const code = genCode();
    const data = { code, type, expires: now() + 5 * 60 * 1000 };
    localStorage.setItem(codeKey(email), JSON.stringify(data));
    return code;
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

  // 后端可用时真实发送一封邮件（异步等待结果）
  // 返回 true 表示邮件已成功送达；false 表示未启用同步或发送失败
  async function mailCode(email, code) {
    if (!syncEnabled) return false;
    try {
      const r = await sync.sendMail(email, code);
      if (r && r.ok) return true;
      console.warn('[mail] 验证码邮件发送失败：' + ((r && r.msg) || '后端不可用'));
      return false;
    } catch (e) {
      console.warn('[mail] 验证码邮件发送异常：' + (e && e.message));
      return false;
    }
  }

  // ===== 业务 API =====

  // 普通用户注册验证码
  async function sendRegisterCode(email) {
    if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return { ok: false, msg: '邮箱格式不正确' };
    }
    if (users.findByEmail(email)) return { ok: false, msg: '该邮箱已注册' };
    const code = setCode(email, 'register');
    const sent = await mailCode(email, code);
    if (sent) return { ok: true, msg: '验证码已发送至邮箱，请查收' };
    return { ok: false, msg: '验证码邮件发送失败，请稍后重试' };
  }

  // 忘记密码验证码
  async function sendResetCode(email) {
    if (!email) return { ok: false, msg: '请先填写邮箱' };
    if (!users.findByEmail(email)) return { ok: false, msg: '该邮箱未注册' };
    const code = setCode(email, 'reset');
    const sent = await mailCode(email, code);
    if (sent) return { ok: true, msg: '验证码已发送至邮箱，请查收' };
    return { ok: false, msg: '验证码邮件发送失败，请稍后重试' };
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
    // 透明升级：存量旧格式密文在登录成功后原地改写为新格式
    const upgraded = reencodeMorse(password, u.password);
    if (upgraded !== u.password) users.update(u.id, { password: upgraded });
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
  async function sendAdminCode(email) {
    if (!email) return { ok: false, msg: '请先填写邮箱' };
    const u = users.findByEmail(email);
    if (!u) return { ok: false, msg: '该邮箱不存在' };
    if (u.role !== 'admin') return { ok: false, msg: '该账号非管理员' };
    const code = setCode(email, 'admin');
    const sent = await mailCode(email, code);
    if (sent) return { ok: true, msg: '验证码已发送至邮箱，请查收' };
    return { ok: false, msg: '验证码邮件发送失败，请稍后重试' };
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
    // 透明升级：存量旧格式密文在登录成功后原地改写为新格式
    const upA = reencodeMorse(passwordA, u.adminPasswordA);
    const upB = reencodeMorse(passwordB, u.adminPasswordB);
    const patch = {};
    if (upA !== u.adminPasswordA) patch.adminPasswordA = upA;
    if (upB !== u.adminPasswordB) patch.adminPasswordB = upB;
    if (Object.keys(patch).length) users.update(u.id, patch);
    if (u.adminPassphrase !== passphrase) return { ok: false, msg: '口令错误' };
    clearCode(email);
    setSession(u);
    return { ok: true, user: { id: u.id, username: u.username, role: u.role } };
  }

  // 发布赛事
  function publishTournament({ title, gameType, description, winCondition, maxPlayers, mossRounds, mossMode, judgeCode }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (s.role !== 'admin' && s.role !== 'superadmin') return { ok: false, msg: '仅管理员或超管可发布' };
    if (!title) return { ok: false, msg: '请填写赛事名称' };
    if (!winCondition) return { ok: false, msg: '请填写输赢条件（你自行编写，bug导致比赛无法运行后果自负）' };
    const arr = read(K.tours, []);
    const t = {
      id: uid('t'), title, gameType: gameType || '', description: description || '',
      winCondition, maxPlayers: parseInt(maxPlayers) || 8,
      // MOSS 博弈规则
      mossRounds: parseInt(mossRounds) || 100,
      mossMode: mossMode || 'elimination', // 'elimination' 单败淘汰 | 'round-robin' 循环赛 | '1v1' 随机匹配
      judgeCode: judgeCode || '', // 裁判代码（隐藏，对玩家不可见）
      mossBots: [], // 玩家提交的 Bot: [{userId, username, name, code}]
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

  // 校验 Bot 代码是否符合参赛规范（必须有 main() 且设置 final_choose）
  function validateBotCode(code) {
    const M = (typeof MOSS !== 'undefined') ? MOSS : (global.MOSS);
    if (!M || !M.Bot) return { ok: true }; // 解释器未加载时跳过强校验
    try {
      const bot = new M.Bot('_validate_', code);
      if (bot.compileError) return { ok: false, msg: '编译错误: ' + bot.compileError };
      // 试跑一轮，检查是否能正常决策
      const choice = bot.decide({ win: false, round: 0, history: [], oppHistory: [] });
      if (bot.error) return { ok: false, msg: '运行错误: ' + bot.error };
      if (!choice) return { ok: false, msg: '未做出决策，请确保 main() 设置了 final_choose' };
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: '校验失败: ' + (e.message || e) };
    }
  }

  // 玩家提交 Bot 到赛事
  function submitBot({ tournamentId, botName, botCode }) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (!tournamentId) return { ok: false, msg: '赛事ID缺失' };
    if (!botCode || !botCode.trim()) return { ok: false, msg: 'Bot 代码不能为空' };
    // 参赛规范校验：必须有 main() 且设置 final_choose
    const v = validateBotCode(botCode);
    if (!v.ok) return { ok: false, msg: v.msg };
    const arr = read(K.tours, []);
    const i = arr.findIndex(t => t.id === tournamentId);
    if (i < 0) return { ok: false, msg: '赛事不存在' };
    const t = arr[i];
    if (t.status !== 'active') return { ok: false, msg: '赛事已结束或已取消' };
    // 检查是否已提交，已提交则覆盖
    const bi = t.mossBots.findIndex(b => b.userId === s.userId);
    const entry = {
      userId: s.userId, username: s.username,
      name: botName || s.username + '_bot',
      code: botCode,
      submittedAt: now(),
    };
    if (bi >= 0) {
      t.mossBots[bi] = entry;
    } else {
      t.mossBots.push(entry);
    }
    arr[i] = t;
    write(K.tours, arr);
    return { ok: true, msg: bi >= 0 ? 'Bot 已更新' : 'Bot 已提交' };
  }

  // 管理员开始比赛（随机匹配 + 对战）
  function runTournament(tournamentId) {
    const s = getSession();
    if (!s) return { ok: false, msg: '请先登录' };
    if (s.role !== 'admin' && s.role !== 'superadmin') return { ok: false, msg: '无权限' };
    const arr = read(K.tours, []);
    const i = arr.findIndex(t => t.id === tournamentId);
    if (i < 0) return { ok: false, msg: '赛事不存在' };
    const t = arr[i];
    if (t.createdByUserId !== s.userId && s.role !== 'superadmin') return { ok: false, msg: '无权操作' };
    if (t.mossBots.length < 2) return { ok: false, msg: '至少需要 2 个 Bot 才能开始比赛' };
    // 标记为进行中
    t.status = 'running';
    arr[i] = t;
    write(K.tours, arr);
    return { ok: true, msg: '比赛已开始', botCount: t.mossBots.length };
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
  async function superAdminSendCode(email) {
    const s = getSettings();
    if (email !== s.superAdminEmail && email !== s.superAdminEmailBackup) {
      return { ok: false, msg: '邮箱不匹配超管邮箱' };
    }
    const code = setCode(email, 'super');
    const sent = await mailCode(email, code);
    if (sent) return { ok: true, msg: '验证码已发送至 ' + email + '，请查收' };
    return { ok: false, msg: '验证码邮件发送失败，请稍后重试' };
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
    // 透明升级：存量旧格式密文在登录成功后原地改写为新格式
    const upA = reencodeMorse(passwordA, s.superAdminPasswordA);
    const upB = reencodeMorse(passwordB, s.superAdminPasswordB);
    const patch = {};
    if (upA !== s.superAdminPasswordA) patch.superAdminPasswordA = upA;
    if (upB !== s.superAdminPasswordB) patch.superAdminPasswordB = upB;
    if (Object.keys(patch).length) updateSettings(patch);
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

  // ===== 服务器同步层（共享后端）=====
  // 仅同步这 5 个键；pgf_session 与 pgf_codes_* 绝不同步（保持浏览器本地）
  // 注意：SYNC_KEYS / syncEnabled 必须在任何 write 调用之前完成声明（本段位于下方 init() 调用之前）。
  const SYNC_KEYS = [K.users, K.apps, K.kicks, K.tours, K.settings];
  let syncEnabled = false; // 是否已启用服务器同步
  let lastRev = -1;        // 最近一次拉取到的服务器 rev
  let pollingTimer = null; // 轮询定时器
  // 仅在 http(s) 协议下才可能连到后端；直接用 file:// 打开时 fetch 会被浏览器拦截（ERR_BLOCKED_BY_CLIENT），
  // 故此时直接禁用同步，静默退回纯本地模式
  const canSync = (typeof location !== 'undefined') && (location.protocol === 'http:' || location.protocol === 'https:');

  // 按 id 合并两个数组（与后端 mergeArrays 对齐）：
  // 新值覆盖同 id 旧记录；旧值独有记录保留；_deleted:true 的条目从结果中删除。
  // _deleted 标记最后处理，确保同一轮合并中删除优先于新增。
  function mergeArrays(oldArr, newArr) {
    const map = new Map();
    const tombstones = new Set();
    let noIdIdx = 0;
    const add = (item) => {
      if (item && typeof item === 'object' && item.id != null) {
        if (item._deleted) { tombstones.add(String(item.id)); return; }
        map.set(String(item.id), item);
      } else {
        map.set('__noid__' + (noIdIdx++), item);
      }
    };
    (oldArr || []).forEach(add);
    (newArr || []).forEach(add);
    tombstones.forEach(id => map.delete(id));
    return Array.from(map.values());
  }

  // 把服务器返回 data 中的已同步键合并进本地 localStorage
  // 数组按 id 合并（防 stale 覆盖）；对象浅合并；其它直接覆盖
  function applyServerData(data) {
    if (!data || typeof data !== 'object') return;
    SYNC_KEYS.forEach(k => {
      if (!Object.prototype.hasOwnProperty.call(data, k)) return;
      const incoming = data[k];
      const local = read(k, Array.isArray(incoming) ? [] : {});
      let merged;
      if (Array.isArray(local) && Array.isArray(incoming)) {
        merged = mergeArrays(local, incoming);
      } else if (local && typeof local === 'object' && !Array.isArray(local) &&
                 incoming && typeof incoming === 'object' && !Array.isArray(incoming)) {
        merged = Object.assign({}, local, incoming);
      } else {
        merged = incoming;
      }
      localStorage.setItem(k, JSON.stringify(merged));
    });
  }

  // fire-and-forget 推送一次操作（不阻塞，错误静默忽略）
  function pushOp(k, v) {
    if (!canSync) return; // file:// 或非 http(s) 下不做推送
    try {
      fetch('/api/op', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ key: k, value: v }),
      }).catch(() => { /* 忽略网络错误 */ });
    } catch (e) { /* 忽略（如 fetch 不可用） */ }
  }

  // 手动触发一次拉取
  function pull() {
    if (!canSync) return Promise.resolve();
    try {
      return fetch('/api/state')
        .then(r => r.json())
        .then(state => {
          if (state && state.ok) {
            applyServerData(state.data);
            lastRev = state.rev;
            syncEnabled = true;
          }
          return state;
        })
        .catch(() => { /* 忽略 */ });
    } catch (e) { return Promise.resolve(); }
  }

  // 轮询：rev 变化则写入本地并广播 db:changed
  function pollOnce() {
    if (!canSync) return;
    try {
      fetch('/api/state')
        .then(r => r.json())
        .then(state => {
          if (state && state.ok && state.rev !== lastRev) {
            applyServerData(state.data);
            lastRev = state.rev;
            window.dispatchEvent(new Event('db:changed'));
          }
        })
        .catch(() => { /* 忽略网络错误 */ });
    } catch (e) { /* 忽略 */ }
  }

  // 初始化流程：先拉取服务器数据；失败则静默降级为纯本地模式
  const ready = (function () {
    if (!canSync) { syncEnabled = false; return Promise.resolve(); } // file:// 下无后端，直接纯本地
    try {
      return fetch('/api/state')
        .then(r => r.json())
        .then(state => {
          if (state && state.ok) {
            applyServerData(state.data);
            lastRev = state.rev;
            syncEnabled = true;
            if (!pollingTimer) pollingTimer = setInterval(pollOnce, 3000);
          }
        })
        .catch(() => { syncEnabled = false; });
    } catch (e) {
      syncEnabled = false;
      return Promise.resolve();
    }
  })();

  // 同一浏览器多标签页：storage 事件触发即时刷新
  window.addEventListener('storage', e => {
    if (SYNC_KEYS.indexOf(e.key) >= 0) window.dispatchEvent(new Event('db:changed'));
  });

  // 通过后端请求发送验证码邮件（未启用同步 / 非 http(s) 时返回 null）
  function sendMail(email, code) {
    if (!canSync || !syncEnabled) return Promise.resolve(null);
    try {
      return fetch('/api/send-code', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, code }),
      })
        .then(r => r.json())
        .catch(() => null);
    } catch (e) { return Promise.resolve(null); }
  }

  const sync = {
    ready,
    pull,
    isEnabled: () => syncEnabled,
    sendMail,
  };

  // 初始化公开
  init();

  return {
    init,
    users,
    sync,
    getSession, clearSession,
    maskEmail,
    // 用户 API
    sendRegisterCode, sendResetCode, register, login, resetPassword,
    adminApply, adminApplyStatus,
    sendAdminCode, adminLogin,
    publishTournament, myTournaments, updateTournament,
    submitBot, runTournament,
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
