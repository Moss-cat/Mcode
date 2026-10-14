/**
 * server.js — 零依赖 Node 后端（仅使用内置 http / fs / path）
 * 作用：为纯前端静态站提供共享数据源，把 localStorage 中需要跨用户共享的数据持久化到 data.json。
 *
 * - 静态文件服务：把本目录（ROOT）下的文件作为静态资源返回
 * - 数据持久化：data.json（存在内存中，每次写入时美化输出落盘）
 * - GET  /api/state -> { ok:true, rev, data }
 * - POST /api/op    -> { key, value } 合并写入，rev 自增
 *
 * 启动：node server.js  （端口默认 3000，可用环境变量 PORT 覆盖）
 */

const http = require('http');
const fs = require('fs');
const path = require('path');
const mailer = require('./mailer');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname; // 项目根目录
const DATA_FILE = path.join(ROOT, 'data.json'); // 数据持久化文件

// 不同步的键：会话与验证码保持浏览器本地
const SESSION_KEY = 'pgf_session';
const CODES_PREFIX = 'pgf_codes_';

// 同一 IP 每小时最多 10 次发信（内存计数，重启清零）
const IP_SEND_LIMIT = 10;
const IP_SEND_WINDOW_MS = 60 * 60 * 1000;
const ipSendLog = new Map(); // ip → [时间戳...]

function takeIpQuota(ip) {
  const nowMs = Date.now();
  const list = (ipSendLog.get(ip) || []).filter((t) => nowMs - t < IP_SEND_WINDOW_MS);
  if (list.length >= IP_SEND_LIMIT) { ipSendLog.set(ip, list); return false; }
  list.push(nowMs);
  ipSendLog.set(ip, list);
  return true;
}

// ===== 摩斯码存储（JSON -> UTF-8 -> 十六进制 -> 摩斯码）=====
// data.json 落盘时保存为 .- 序列；十六进制仅含 0-9 / A-F，与大小写无关，可无损还原。
const MORSE_MAP = {
  '0': '-----', '1': '.----', '2': '..---', '3': '...--', '4': '....-',
  '5': '.....', '6': '-....', '7': '--...', '8': '---..', '9': '----.',
  'A': '.-',    'B': '-...',  'C': '-.-.',  'D': '-..',   'E': '.',     'F': '..-.',
};
const MORSE_REVERSE = (() => {
  const r = {};
  Object.keys(MORSE_MAP).forEach((k) => { r[MORSE_MAP[k]] = k; });
  return r;
})();

// 对象 -> 摩斯码文本
function encodeData(obj) {
  const hex = Buffer.from(JSON.stringify(obj), 'utf8').toString('hex').toUpperCase();
  return hex.split('').map((c) => MORSE_MAP[c] || '').join(' ');
}

// 摩斯码文本 -> 对象（兼容旧的明文 JSON 格式）
function decodeData(text) {
  const t = String(text).trim();
  if (!t) return null;
  if (t.charAt(0) === '{') return JSON.parse(t); // 旧格式，仍是明文 JSON
  const hex = t.split(/\s+/).map((sym) => MORSE_REVERSE[sym] || '').join('');
  return JSON.parse(Buffer.from(hex, 'hex').toString('utf8'));
}

// ===== 数据读写 =====
// 内存中的数据结构：{ rev: 数字, data: { 键: 值 } }
let state = { rev: 0, data: {} };

// 启动时载入 data.json；不存在则创建初始结构
function loadState() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      const raw = fs.readFileSync(DATA_FILE, 'utf8');
      const parsed = decodeData(raw);
      if (parsed && typeof parsed === 'object') {
        state = {
          rev: typeof parsed.rev === 'number' ? parsed.rev : 0,
          data: (parsed.data && typeof parsed.data === 'object') ? parsed.data : {},
        };
        return;
      }
    }
  } catch (e) {
    // 文件损坏时退回初始结构，避免启动失败
    console.error('[warn] 读取 data.json 失败，使用初始结构：', e.message);
  }
  state = { rev: 0, data: {} };
  persist();
}

// 写入 data.json（摩斯码编码后落盘）
function persist() {
  try {
    // 以摩斯码形式落盘（不可直接阅读）
    fs.writeFileSync(DATA_FILE, encodeData(state), 'utf8');
  } catch (e) {
    console.error('[error] 写入 data.json 失败：', e.message);
  }
}

// ===== 合并规则 =====
// 数組合并：按每条的 id 做并集。新值覆盖同 id 旧记录；旧值独有记录保留；
// 新值中带 _deleted:true 的条目从结果中删除该 id。
function mergeArrays(oldArr, newArr) {
  const map = new Map(); // 保持插入顺序
  let noIdIndex = 0; // 无 id 条目的合成键计数器

  (oldArr || []).forEach((item) => {
    if (item && typeof item === 'object' && item.id !== undefined && item.id !== null) {
      map.set(String(item.id), item);
    } else {
      // 无 id 的旧条目：直接保留
      map.set('__noid__' + (noIdIndex++), item);
    }
  });

  (newArr || []).forEach((item) => {
    if (item && typeof item === 'object' && item.id !== undefined && item.id !== null) {
      const key = String(item.id);
      if (item._deleted) {
        map.delete(key); // 逻辑删除
      } else {
        map.set(key, item); // 覆盖或新增
      }
    } else {
      map.set('__noid__' + (noIdIndex++), item);
    }
  });

  return Array.from(map.values());
}

// 合并单个键的新旧值
function mergeValue(oldVal, newVal) {
  if (Array.isArray(oldVal) && Array.isArray(newVal)) {
    return mergeArrays(oldVal, newVal);
  }
  if (isPlainObject(oldVal) && isPlainObject(newVal)) {
    return Object.assign({}, oldVal, newVal); // 对象浅合并，新值优先
  }
  return newVal; // 其它情况直接覆盖
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

// ===== HTTP 响应辅助 =====
function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  setCors(res);
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

// ===== 静态文件 =====
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.vsix': 'application/octet-stream',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
};

function contentTypeFor(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return MIME[ext] || 'application/octet-stream';
}

// 返回静态文件；找不到返回 404
function serveStatic(req, res, urlPath) {
  let rel = decodeURIComponent(urlPath.split('?')[0]); // 处理含中文的文件名
  if (rel === '/' || rel === '') rel = '/index.html';

  // 规范化并防止路径穿越
  const filePath = path.normalize(path.join(ROOT, rel));
  if (!filePath.startsWith(ROOT)) {
    setCors(res);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(filePath, (err, stat) => {
    if (err || !stat.isFile()) {
      setCors(res);
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404 Not Found');
      return;
    }
    setCors(res);
    res.writeHead(200, { 'Content-Type': contentTypeFor(filePath), 'Content-Length': stat.size });
    fs.createReadStream(filePath).pipe(res);
  });
}

// ===== 请求体解析 =====
function readBody(req, cb) {
  let chunks = '';
  req.on('data', (c) => {
    chunks += c;
    // 简单保护：请求体过大直接中断
    if (chunks.length > 20 * 1024 * 1024) req.destroy();
  });
  req.on('end', () => cb(chunks));
  req.on('error', () => cb(null));
}

// ===== 服务器 =====
const server = http.createServer((req, res) => {
  const urlPath = req.url || '/';

  // 预检请求
  if (req.method === 'OPTIONS') {
    setCors(res);
    res.writeHead(204);
    res.end();
    return;
  }

  // 读取状态
  if (req.method === 'GET' && urlPath.split('?')[0] === '/api/state') {
    return sendJson(res, 200, { ok: true, rev: state.rev, data: state.data });
  }

  // 合并写入
  if (req.method === 'POST' && urlPath.split('?')[0] === '/api/op') {
    return readBody(req, (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 400, { ok: false, msg: '请求体不是合法 JSON' });
      }
      if (!payload || typeof payload !== 'object' || typeof payload.key !== 'string') {
        return sendJson(res, 400, { ok: false, msg: '缺少 key 字段' });
      }
      const key = payload.key;
      // 忽略会话与验证码键（保持浏览器本地）
      if (key === SESSION_KEY || key.indexOf(CODES_PREFIX) === 0) {
        return sendJson(res, 200, { ok: true, rev: state.rev });
      }
      // 合并并自增 rev
      const oldVal = Object.prototype.hasOwnProperty.call(state.data, key) ? state.data[key] : undefined;
      state.data[key] = mergeValue(oldVal, payload.value);
      state.rev += 1;
      persist();
      return sendJson(res, 200, { ok: true, rev: state.rev });
    });
  }

  // 发送邮箱验证码（163 SMTP，异步不阻塞；失败原因回传调用方）
  if (req.method === 'POST' && urlPath.split('?')[0] === '/api/send-code') {
    return readBody(req, (raw) => {
      let payload;
      try {
        payload = JSON.parse(raw);
      } catch (e) {
        return sendJson(res, 400, { ok: false, msg: '请求体不是合法 JSON' });
      }
      if (!payload || typeof payload.email !== 'string' || typeof payload.code !== 'string') {
        return sendJson(res, 400, { ok: false, msg: '缺少 email 或 code 字段' });
      }
      const ip = (req.socket && req.socket.remoteAddress) || 'unknown';
      if (!takeIpQuota(ip)) {
        return sendJson(res, 429, { ok: false, msg: '本机发送次数已达上限（每小时 10 次），请稍后再试' });
      }
      // 发信为异步操作，等待结果但不阻塞事件循环
      mailer.sendVerifyCode(payload.email, payload.code)
        .then(() => sendJson(res, 200, { ok: true, msg: '验证码已发送至邮箱' }))
        .catch((e) => {
          const status = e.code === 'RATE_LIMIT_EMAIL' ? 429 : 500;
          sendJson(res, status, { ok: false, msg: e.message || '发送失败' });
        });
    });
  }

  // 其余当作静态资源
  return serveStatic(req, res, urlPath);
});

loadState(); // 启动前载入持久化数据
server.listen(PORT, () => {
  console.log('静态站 + 数据服务已启动： http://localhost:' + PORT + '/');
  console.log('数据文件： ' + DATA_FILE);
});
