'use strict';
// claude-approval / lib/common.cjs
// 共享工具：路径、配置、日志、原子写、编号生成、时间解析、决策输出
// 零依赖，仅用 Node 内置模块。

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const D = require('./describe.cjs');

const BASE = path.resolve(__dirname, '..');

const DIRS = {
  base: BASE,
  pending: path.join(BASE, 'pending'),
  cache: path.join(BASE, 'cache'),
  runtime: path.join(BASE, 'runtime'),
  // 按钮点击的落点：后台守护进程写，hook 轮询读
  decisions: path.join(BASE, 'runtime', 'decisions'),
};

const FILES = {
  flag: path.join(BASE, 'away.flag'),
  config: path.join(BASE, 'config.json'),
  configExample: path.join(BASE, 'config.example.json'),
  log: path.join(BASE, 'log.txt'),
  logOld: path.join(BASE, 'log.old.txt'),
  chatid: path.join(DIRS.runtime, 'chatid.json'),
};

const LOG_MAX_BYTES = 1024 * 1024; // 1MB 滚动

// ---------------------------------------------------------------- 基础工具

function ensureDirs() {
  for (const d of [DIRS.pending, DIRS.cache, DIRS.runtime, DIRS.decisions]) {
    try { fs.mkdirSync(d, { recursive: true }); } catch (_) { /* 已存在 */ }
  }
}

function readJsonSafe(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (_) {
    return null;
  }
}

// 原子写：先写 .tmp 再 rename，避免多进程并发写坏文件
function writeJsonAtomic(p, obj) {
  const tmp = p + '.tmp-' + process.pid;
  try {
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, p);
    return true;
  } catch (_) {
    try { fs.unlinkSync(tmp); } catch (__) { /* 忽略 */ }
    return false;
  }
}

function removeQuiet(p) {
  try { fs.unlinkSync(p); } catch (_) { /* 忽略 */ }
}

function sha256hex(s) {
  return crypto.createHash('sha256').update(s, 'utf8').digest('hex');
}

function truncate(s, n) {
  s = String(s == null ? '' : s);
  if (s.length <= n) return s;
  return s.slice(0, n) + '…(已截断)';
}

function log(line) {
  try {
    ensureDirs();
    try {
      const st = fs.statSync(FILES.log);
      if (st.size > LOG_MAX_BYTES) fs.renameSync(FILES.log, FILES.logOld);
    } catch (_) { /* 文件不存在，无需滚动 */ }
    const ts = new Date().toLocaleString('zh-CN', { hour12: false });
    fs.appendFileSync(FILES.log, `[${ts}] ${line}\n`, 'utf8');
  } catch (_) { /* 日志失败绝不能影响主流程 */ }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------- 配置与状态

const DEFAULTS = {
  waitTimeoutSec: 300,
  pollIntervalSec: 3,
  cacheTtlMin: 10,
  exemptTools: [],
  userOpenId: '',
  botOpenId: '',
  chatId: '',
  maxToolInputChars: 600,
  maxMsgChars: 1200,
  maxReplyTextChars: 200,
  stalePendingSec: 3600,
  idAlphabet: 'abcdefghjkmnpqrstuvwxyz',
  nodePath: '',
  larkCliPath: '',
  // 把工具调用翻译成人话再发出去（Bash 的命令原文始终原样保留）
  friendlyMessages: true,
  // 用带「同意/拒绝」按钮的卡片发送审批；守护进程没起来时自动退回纯文字
  useCardButtons: true,
};

function loadConfig() {
  const cfg = Object.assign({}, DEFAULTS, readJsonSafe(FILES.config) || {});
  // 环境变量覆盖（仅用于测试）
  if (process.env.APPROVAL_TIMEOUT_SEC) {
    const v = Number(process.env.APPROVAL_TIMEOUT_SEC);
    if (v > 0) cfg.waitTimeoutSec = v;
  }
  if (process.env.APPROVAL_POLL_SEC) {
    const v = Number(process.env.APPROVAL_POLL_SEC);
    if (v > 0) cfg.pollIntervalSec = v;
  }
  if (process.env.APPROVAL_TTL_MIN) {
    const v = Number(process.env.APPROVAL_TTL_MIN);
    if (v >= 0) cfg.cacheTtlMin = v;
  }
  return cfg;
}

// 离开模式是否开启 —— 这是 hook 每次调用的第一道检查
function isAway() {
  try { return fs.existsSync(FILES.flag); } catch (_) { return false; }
}

function awaySince() {
  const f = readJsonSafe(FILES.flag);
  return f && f.on_at ? f.on_at : null;
}

// ---------------------------------------------------------------- 编号

function genId(cfg, existingSet) {
  const alpha = cfg.idAlphabet || DEFAULTS.idAlphabet;
  for (let attempt = 0; attempt < 50; attempt++) {
    let id = '';
    for (let i = 0; i < 5; i++) id += alpha[crypto.randomInt(0, alpha.length)];
    if (!existingSet || !existingSet.has(id)) return id;
  }
  // 极端情况兜底：加时间后缀
  return ('x' + Date.now().toString(36)).slice(0, 5);
}

// ---------------------------------------------------------------- 时间解析

// 飞书返回的时间是本地时间字符串，可能是 "YYYY-MM-DD HH:MM:SS"（发送接口，秒级）
// 或 "YYYY-MM-DD HH:MM"（消息列表，分钟级）。用本地时区构造 Date。
function parseLarkTime(s) {
  if (!s) return null;
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return new Date(
    Number(m[1]), Number(m[2]) - 1, Number(m[3]),
    Number(m[4]), Number(m[5]), Number(m[6] || 0)
  );
}

// ---------------------------------------------------------------- 消息解析

// 飞书 content 通常是纯文本；兼容被包成 {"text":"..."} 的 JSON 形式
function extractText(content) {
  if (content == null) return '';
  if (typeof content === 'object') {
    return String(content.text != null ? content.text : JSON.stringify(content));
  }
  const s = String(content);
  const t = s.trim();
  if (t.startsWith('{') && t.endsWith('}')) {
    try {
      const o = JSON.parse(t);
      if (o && typeof o.text === 'string') return o.text;
    } catch (_) { /* 不是 JSON，按纯文本处理 */ }
  }
  return s;
}

// 认得的回复词。允许 short form（1/0）是为了手机上少打字。
const ALLOW_WORDS = ['1', 'y', 'yes', 'ok', 'okay', 'approve', '同意'];
const DENY_WORDS = ['0', 'n', 'no', 'deny', 'reject', '拒绝'];
// 数字后面经常跟着中文单位（「1月」「0点」），会被 \b 判成词边界而误匹配，
// 所以这两个词要求整条消息就是它本身（顶多再带一个编号），不接受任何后缀。
const STRICT_WORDS = ['1', '0'];

function isAllowWord(kw) { return ALLOW_WORDS.indexOf(kw) !== -1; }
function isDenyWord(kw) { return DENY_WORDS.indexOf(kw) !== -1; }

// 回复解析。注意：JS 正则的 \b 按 ASCII 判定，中文「同意」后没有 word boundary，
// 所以中文与英文必须分成两个分支，中文分支不能用 \b。
function matchReply(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return null;
  // 捕获组：1=关键词 2=分隔符 3=编号 4=分隔符 5=剩余文字
  // 分隔符单独捕获，是为了区分「1 好的」（有意回复）和「1月要去实习」（闲聊误撞）。
  const m = t.match(/^([a-z0-9]+)([\s,，。:：]*)([a-z]{5}\b)?([\s,，。:：]*)([\s\S]*)$/i)
        || t.match(/^(同意|拒绝)([\s,，。:：]*)([a-z]{5}\b)?([\s,，。:：]*)([\s\S]*)$/i);
  if (!m) return null;

  const kw = String(m[1] || '').toLowerCase();
  let allow;
  if (isAllowWord(kw)) allow = true;
  else if (isDenyWord(kw)) allow = false;
  else return null; // 认不出的词，交回调用方（当作普通聊天忽略）

  const sep1 = String(m[2] || '');
  const replyId = String(m[3] || '').toLowerCase();
  const sep2 = String(m[4] || '');
  const extra = String(m[5] || '').trim();

  // 「1」「0」后面还跟着别的东西时，必须用空格/标点隔开才算有意回复。
  // 「1 好的」→ 算；「1月要去实习」→ 不算（否则会被当成同意，后果严重）。
  if (STRICT_WORDS.indexOf(kw) !== -1 && extra && !sep1 && !sep2) return null;

  return { kw, allow, replyId, extra };
}

// ---------------------------------------------------------------- 决策输出

function printDecision(decision, reason) {
  const payload = {
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: decision,
      permissionDecisionReason: reason,
    },
  };
  process.stdout.write(JSON.stringify(payload) + '\n');
}

// 拒绝：同时给 stdout 的 JSON 决策与 stderr 文本（exit 2 是硬性拦截）
function exitDeny(reason) {
  printDecision('deny', reason);
  process.stderr.write(reason + '\n');
  process.exit(2);
}

// ---------------------------------------------------------------- 清理

function listPending() {
  try {
    return fs.readdirSync(DIRS.pending)
      .filter((f) => f.endsWith('.json'))
      .map((f) => readJsonSafe(path.join(DIRS.pending, f)))
      .filter((p) => p && p.id);
  } catch (_) {
    return [];
  }
}

function undecidedPending() {
  return listPending().filter((p) => p.decision == null);
}

// ---------------------------------------------------------------- 回复认领

// 原子认领一条回复。用「独占创建文件」（flag 'wx'）保证同一时刻只有一个审批请求
// 能消费同一条回复消息 —— 这是防止「一个 ok 连续放行多个操作」的关键。
// 每一条审批请求都是独立进程，仅靠进程内的 seen 集合无法阻止跨进程重复消费。
function claimMessage(messageId) {
  if (!messageId) return false;
  try {
    ensureDirs();
    const p = path.join(DIRS.runtime, 'consumed-' + messageId);
    fs.writeFileSync(p, String(Date.now()), { flag: 'wx' });
    return true;
  } catch (e) {
    if (e && e.code === 'EEXIST') return false; // 已被别的请求消费掉
    return true; // 其他异常（磁盘等）不应阻塞审批流
  }
}

// 清理陈旧的 pending（进程被杀残留）与过期 cache
function gcStale(cfg) {
  const now = Date.now();
  const staleMs = (cfg.stalePendingSec || DEFAULTS.stalePendingSec) * 1000;
  try {
    for (const f of fs.readdirSync(DIRS.pending)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(DIRS.pending, f);
      const o = readJsonSafe(p);
      if (!o || !o.created_at || now - o.created_at > staleMs) removeQuiet(p);
    }
  } catch (_) { /* 忽略 */ }
  try {
    for (const f of fs.readdirSync(DIRS.cache)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(DIRS.cache, f);
      const o = readJsonSafe(p);
      if (!o || !o.expires_at || o.expires_at < now - 24 * 3600 * 1000) removeQuiet(p);
    }
  } catch (_) { /* 忽略 */ }
  // 回复认领标记：保留 2 小时（要覆盖最长等待期，避免刚认领的标记被清掉后又被复用）
  try {
    for (const f of fs.readdirSync(DIRS.runtime)) {
      if (!f.startsWith('consumed-')) continue;
      const p = path.join(DIRS.runtime, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > 2 * 3600 * 1000) removeQuiet(p);
    }
  } catch (_) { /* 忽略 */ }
  // 按钮决策：同样保留 2 小时。保留期就是「编号不会被复用」的窗口，
  // 短于飞书卡片按钮令牌的有效期（30 分钟）也不至于误配。
  try {
    for (const f of fs.readdirSync(DIRS.decisions)) {
      if (!f.endsWith('.json')) continue;
      const p = path.join(DIRS.decisions, f);
      const st = fs.statSync(p);
      if (now - st.mtimeMs > 2 * 3600 * 1000) removeQuiet(p);
    }
  } catch (_) { /* 忽略 */ }
}

function clearState() {
  let n = 0;
  try {
    for (const f of fs.readdirSync(DIRS.pending)) { removeQuiet(path.join(DIRS.pending, f)); n++; }
  } catch (_) { /* 忽略 */ }
  try {
    for (const f of fs.readdirSync(DIRS.cache)) { removeQuiet(path.join(DIRS.cache, f)); n++; }
  } catch (_) { /* 忽略 */ }
  try {
    for (const f of fs.readdirSync(DIRS.runtime)) {
      if (f.startsWith('consumed-')) { removeQuiet(path.join(DIRS.runtime, f)); n++; }
    }
  } catch (_) { /* 忽略 */ }
  try {
    for (const f of fs.readdirSync(DIRS.decisions)) {
      if (f.endsWith('.json')) { removeQuiet(path.join(DIRS.decisions, f)); n++; }
    }
  } catch (_) { /* 忽略 */ }
  return n;
}

// ---------------------------------------------------------------- 审批消息文案

// 审批文案。friendlyMessages 开启时用 describe.cjs 翻成人话；
// 关闭时退回「工具名 + 原始 JSON」的老格式。
// 无论哪种格式，必须让用户看见「到底要对什么做什么」—— 这是闸门的意义所在。
function buildApprovalMessage(cfg, id, toolName, toolInput) {
  const inputPreview = truncate(JSON.stringify(toolInput || {}), cfg.maxToolInputChars);

  if (cfg && cfg.friendlyMessages === false) {
    return truncate([
      '🔐 Claude Code 远程审批',
      '编号：' + id,
      '操作：' + toolName,
      '参数：' + inputPreview,
      '——',
      '回复「1 ' + id + '」同意 / 「0 ' + id + '」拒绝',
      '（同一条消息回复 1 或 0 亦可；' + cfg.cacheTtlMin + ' 分钟内相同操作会自动放行）',
    ].join('\n'), cfg.maxMsgChars || DEFAULTS.maxMsgChars);
  }

  const d = D.describe(toolName, toolInput);
  const lines = [
    '🔐 Claude Code 需要你批准',
    '',
    d.icon + ' ' + d.title + (d.detail ? '：' + d.detail : ''),
  ];
  if (d.note) lines.push('（' + d.note + '）');
  if (d.risk === 'high') lines.push('⚠️ 这个操作看起来有破坏性，看清楚再决定');
  lines.push('');
  lines.push('编号 ' + id);
  lines.push('回复 1 同意 / 0 拒绝（回复 ok / no 亦可）');
  lines.push('—— ' + humanTimeout(cfg) + '，或改为在本机确认');

  return truncate(lines.join('\n'), cfg.maxMsgChars || DEFAULTS.maxMsgChars);
}

function humanTimeout(cfg) {
  const sec = (cfg && cfg.waitTimeoutSec) || DEFAULTS.waitTimeoutSec;
  if (sec < 90) return sec + ' 秒不回复自动拒绝';
  return Math.round(sec / 60) + ' 分钟不回复自动拒绝';
}

// ---------------------------------------------------------------- 按钮决策

// 按钮点击的落点。后台守护进程用「独占创建」写入（第一次点击成功，
// 第二次及以后的点击拿到 EEXIST 被忽略）—— 这就是「一次点击只放行一个操作」
// 在按钮通道上的实现，和 claimMessage 是同一个思路。
function writeDecision(id, decision, meta) {
  if (!id) return false;
  try {
    ensureDirs();
    const payload = Object.assign({ id, decision, at: Date.now() }, meta || {});
    fs.writeFileSync(path.join(DIRS.decisions, id + '.json'),
      JSON.stringify(payload, null, 2), { flag: 'wx' });
    return true;
  } catch (_) {
    return false; // EEXIST（已决策过）或磁盘异常，一律当作「没抢到」
  }
}

function readDecision(id) {
  if (!id) return null;
  return readJsonSafe(path.join(DIRS.decisions, id + '.json'));
}

// 最近用过的编号：防止旧卡片上的按钮被误配到新请求上。
// genId 原本只避开「当前待审批」的编号，但旧卡片的按钮在令牌失效前仍可点击。
function recentDecisionIds() {
  try {
    return fs.readdirSync(DIRS.decisions)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  } catch (_) {
    return [];
  }
}

module.exports = {
  BASE, DIRS, FILES, DEFAULTS,
  ensureDirs, readJsonSafe, writeJsonAtomic, removeQuiet,
  sha256hex, truncate, log, sleep,
  loadConfig, isAway, awaySince,
  genId, parseLarkTime, extractText, matchReply,
  printDecision, exitDeny,
  listPending, undecidedPending, claimMessage, gcStale, clearState,
  buildApprovalMessage, humanTimeout,
  writeDecision, readDecision, recentDecisionIds,
};
