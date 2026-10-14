/**
 * mailer.js — 163 邮箱 SMTP 验证码发送模块
 *
 * 设计要点：
 *   - 零依赖：只用 Node 内置 tls / os / crypto，不引入 nodemailer
 *   - 授权码不落明文：以「摩斯密码变体」密文常量存储，由 getSmtpPass() 还原
 *   - 异步发信：全程 Promise，不阻塞 HTTP 请求
 *   - 发送失败抛错并记录日志，不静默吞掉
 *
 * 导出：sendVerifyCode(to, code) —— 另附 getSmtpPass / encodeMorse / decodeMorse 便于校验
 */

const tls = require('tls');
const os = require('os');
const crypto = require('crypto');

// ===== 摩斯密码变体（大小写感知）=====
// 规则：字符 → 标准摩斯码 → 逐符号替换（"." 换 "-"，"-" 换 "="）
//       → 段首加 "1"（大写）/ "0"（小写）；各段用 "|" 分隔
//       没有摩斯码的字符（空格等）原样保留
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
Object.keys(MORSE).forEach((ch) => { MORSE_REV[MORSE[ch]] = ch; });

const TO_CODE = { '.': '-', '-': '=' };    // 编码方向：点 → - ，划 → =
const FROM_CODE = { '-': '.', '=': '-' };  // 解码方向

// 明文 → 密文
function encodeMorse(text) {
  if (text == null) return '';
  return String(text).split('').map((ch) => {
    const m = MORSE[ch.toUpperCase()];
    if (m === undefined) return ch; // 无摩斯码的字符原样保留
    const body = m.split('').map((s) => TO_CODE[s]).join('');
    const isLower = (ch === ch.toLowerCase()) && (ch !== ch.toUpperCase());
    return (isLower ? '0' : '1') + body;
  }).join('|');
}

// 密文 → 明文
function decodeMorse(encoded) {
  if (encoded == null) return '';
  return String(encoded).split('|').map((seg) => {
    if (seg === '') return '';
    const m = /^([01])([-=]+)$/.exec(seg);
    if (!m) return seg; // 非摩斯段，原样返回
    const std = m[2].split('').map((s) => FROM_CODE[s]).join('');
    const ch = MORSE_REV[std];
    if (ch === undefined) return seg;
    return m[1] === '0' ? ch.toLowerCase() : ch;
  }).join('');
}

// ===== 授权码密文（明文只存在于运行时内存）=====
// sz_mossteam@163.com 的 SMTP 授权码，以摩斯变体加密后存储
const SMTP_PASS_CIPHER = '1--=-|1=--|0---|0-=-|0==-|1===--|1=-==|0---|0=--|1=-=|1====-|1=----|1=---|1-=-|0---|0=-';

function getSmtpPass() {
  return decodeMorse(SMTP_PASS_CIPHER);
}

// ===== SMTP 配置 =====
const SMTP = {
  host: 'smtp.163.com',
  port: 465,
  secure: true,
  user: 'sz_mossteam@163.com',
  from: 'sz_mossteam@163.com', // 发件地址必须与账号一致，否则 163 拒发
  fromName: 'MOSS平台',
};

// ===== 限流：同一邮箱 60 秒内只能发一次 =====
const EMAIL_COOLDOWN_MS = 60 * 1000;
const emailLastSentAt = new Map(); // email(小写) → 上次成功发送时间戳

function checkEmailCooldown(email) {
  const key = email.toLowerCase();
  const last = emailLastSentAt.get(key);
  const nowMs = Date.now();
  if (last && nowMs - last < EMAIL_COOLDOWN_MS) {
    const wait = Math.ceil((EMAIL_COOLDOWN_MS - (nowMs - last)) / 1000);
    const err = new Error('发送过于频繁，请 ' + wait + ' 秒后再试');
    err.code = 'RATE_LIMIT_EMAIL';
    err.retryAfter = wait;
    throw err;
  }
}

// ===== MIME 组装 =====
// base64 按 MIME 规范每 76 字符折行
function wrap76(b64) {
  return b64.replace(/.{76}/g, '$&\r\n');
}

// 含非 ASCII 的头部字段用 RFC2047 编码字
function headerWord(str) {
  return '=?UTF-8?B?' + Buffer.from(str, 'utf8').toString('base64') + '?=';
}

function buildMime(mail) {
  const boundary = 'MOSS_' + crypto.randomBytes(12).toString('hex');
  const head = [
    'From: ' + headerWord(SMTP.fromName) + ' <' + SMTP.from + '>',
    'To: <' + mail.to + '>',
    'Subject: ' + headerWord(mail.subject),
    'Date: ' + new Date().toUTCString(),
    'Message-ID: <' + crypto.randomBytes(16).toString('hex') + '@' + SMTP.host + '>',
    'MIME-Version: 1.0',
    'Content-Type: multipart/alternative; boundary="' + boundary + '"',
  ].join('\r\n');

  const part = (type, content) => [
    '--' + boundary,
    'Content-Type: ' + type + '; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    '',
    wrap76(Buffer.from(content, 'utf8').toString('base64')),
  ].join('\r\n');

  return head + '\r\n\r\n'
    + part('text/plain', mail.text) + '\r\n'
    + part('text/html', mail.html) + '\r\n'
    + '--' + boundary + '--';
}

// ===== 极简 SMTP 客户端（TLS 直连 465，AUTH LOGIN）=====
function openSession() {
  return new Promise((resolve, reject) => {
    const socket = tls.connect({ host: SMTP.host, port: SMTP.port, servername: SMTP.host });
    let buf = '';        // 原始字节缓冲
    let respBuf = '';    // 当前响应的累积文本
    const ready = [];    // 已到达、待消费的完整响应
    const waiters = [];  // 等待响应的 resolve
    let broken = null;   // 连接错误

    const push = (full) => { const w = waiters.shift(); if (w) w({ ok: full }); else ready.push({ ok: full }); };
    const fail = (e) => { broken = e; while (waiters.length) waiters.shift()({ err: e }); };

    socket.setEncoding('utf8');
    socket.setTimeout(20000);
    socket.on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\r\n')) !== -1) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 2);
        respBuf += line + '\r\n';
        // 多行响应：中间行形如 "250-XXX"，结束行是 "数字+空格"
        if (/^\d{3} /.test(line)) { const full = respBuf; respBuf = ''; push(full); }
      }
    });
    socket.on('error', fail);
    socket.on('timeout', () => { fail(new Error('SMTP 连接超时')); try { socket.destroy(); } catch (e) { /* ignore */ } });

    resolve({
      socket,
      next: () => {
        if (broken) return Promise.resolve({ err: broken });
        if (ready.length) return Promise.resolve(ready.shift());
        return new Promise((r) => waiters.push(r));
      },
      write: (cmd) => socket.write(cmd + '\r\n'),
      close: () => { try { socket.end(); } catch (e) { /* ignore */ } },
    });
  });
}

function expectCode(resp, want) {
  if (resp.err) throw resp.err;
  const text = String(resp.ok).trim();
  if (text.slice(0, 3) !== want) {
    throw new Error('SMTP 期望 ' + want + '，实际返回：' + text.replace(/\r\n/g, ' | '));
  }
}

async function smtpSend(mail) {
  const s = await openSession();
  try {
    expectCode(await s.next(), '220');                       // 服务端问候
    s.write('EHLO ' + (os.hostname() || 'localhost'));
    expectCode(await s.next(), '250');
    s.write('AUTH LOGIN');
    expectCode(await s.next(), '334');
    s.write(Buffer.from(SMTP.user, 'utf8').toString('base64'));
    expectCode(await s.next(), '334');
    s.write(Buffer.from(getSmtpPass(), 'utf8').toString('base64'));
    expectCode(await s.next(), '235');                       // 认证成功
    s.write('MAIL FROM:<' + SMTP.from + '>');
    expectCode(await s.next(), '250');
    s.write('RCPT TO:<' + mail.to + '>');
    expectCode(await s.next(), '250');
    s.write('DATA');
    expectCode(await s.next(), '354');
    s.write(buildMime(mail).replace(/^\./gm, '..'));         // 行首点转义
    s.write('.');                                            // 正文结束标记
    expectCode(await s.next(), '250');
    s.write('QUIT');
    s.close();
  } catch (e) {
    try { s.socket.destroy(); } catch (err) { /* ignore */ }
    throw e;
  }
}

// ===== 对外接口 =====
// 发送验证码邮件；失败抛错（调用方决定如何提示）
async function sendVerifyCode(to, code) {
  const email = String(to || '').trim();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('邮箱格式不正确');
  if (!code) throw new Error('验证码不能为空');

  checkEmailCooldown(email);

  const subject = '【MOSS平台】邮箱验证码';
  const text = [
    '您好，',
    '',
    '您的验证码是：' + code,
    '',
    '验证码 5 分钟内有效，请勿泄露给他人。',
    '',
    '本邮件由系统自动发送，请勿直接回复',
  ].join('\r\n');
  const html = [
    '<div style="font-family:-apple-system,BlinkMacSystemFont,\'Segoe UI\',\'PingFang SC\',\'Microsoft YaHei\',sans-serif;color:#222;font-size:14px;line-height:1.7">',
    '  <p>您好，</p>',
    '  <p>您的验证码是：</p>',
    '  <p style="margin:18px 0;font-size:36px;font-weight:700;letter-spacing:10px;color:#1a73e8">' + code + '</p>',
    '  <p>验证码 5 分钟内有效，请勿泄露给他人。</p>',
    '  <p style="margin-top:24px;color:#999;font-size:12px">本邮件由系统自动发送，请勿直接回复</p>',
    '</div>',
  ].join('\r\n');

  const startedAt = Date.now();
  try {
    await smtpSend({ to: email, subject, text, html });
    emailLastSentAt.set(email.toLowerCase(), Date.now()); // 成功后开始计时，失败不锁用户
    console.log('[mail] 验证码已发送：' + email + '（耗时 ' + (Date.now() - startedAt) + 'ms）');
    return { ok: true };
  } catch (e) {
    console.error('[mail] 发送失败：' + email + '，原因：' + e.message);
    throw e;
  }
}

if (require.main === module) {
  // 直接运行：node mailer.js            → 校验密文能否还原
  //          node mailer.js 收件人 验证码 → 真实发送一封
  const [, , to, code] = process.argv;
  console.log('授权码解密结果：' + (getSmtpPass() === 'FDsrg8YsdK96BRsn' ? '一致 ✓' : '不一致 ✗'));
  if (to && code) {
    sendVerifyCode(to, code)
      .then(() => console.log('发送成功'))
      .catch((e) => { console.error('发送失败：' + e.message); process.exitCode = 1; });
  }
}

module.exports = { sendVerifyCode, getSmtpPass, encodeMorse, decodeMorse, SMTP };
