'use strict';
// claude-approval / lib/feishu.cjs
// lark-cli 封装：直接 spawn .exe 绝对路径，不经 shell，因此没有引号/转义问题。
// 令牌续期与并发锁由 lark-cli 自己管理，这里只调用它。

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// lark-cli 的默认安装位置。npm 的 Windows 全局目录就是 %APPDATA%\npm，
// 这里按环境变量推导而不写死用户名；该路径不存在时（其他系统、装在别处），
// spawnLark 会自动回退到 PATH 里的 lark-cli。
const DEFAULT_CLI = path.join(
  process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'),
  'npm', 'node_modules', '@larksuite', 'cli', 'bin', 'lark-cli.exe'
);

// 抑制 CLI 的更新/技能提示噪声，保证 stdout 是可解析的纯 JSON
function cliEnv() {
  return Object.assign({}, process.env, {
    LARKSUITE_CLI_NO_UPDATE_NOTIFIER: '1',
    LARKSUITE_CLI_NO_SKILLS_NOTIFIER: '1',
  });
}

/**
 * 解析出 lark-cli 可执行文件的实际位置（供需要「长期流式读取输出」的调用方使用，
 * 例如按钮守护进程；spawnLark 是一次性同步调用，不适合流式场景）。
 */
function resolveCliPath(cfg) {
  const candidates = [];
  if (cfg && cfg.larkCliPath) candidates.push(cfg.larkCliPath);
  candidates.push(DEFAULT_CLI);
  for (const bin of candidates) {
    if (/[\\/]/.test(bin)) {
      try { if (fs.existsSync(bin)) return bin; } catch (_) { /* 看下一个 */ }
    }
  }
  return 'lark-cli'; // 交给 PATH 解析
}

/**
 * 调用 lark-cli。
 * @returns {{ok:boolean, exitCode:number, data:object|null, error:string}}
 */
function spawnLark(cfg, args, opts) {
  opts = opts || {};
  const timeout = opts.timeoutMs || 15000;
  const candidates = [];
  if (cfg && cfg.larkCliPath) candidates.push(cfg.larkCliPath);
  candidates.push(DEFAULT_CLI);
  candidates.push('lark-cli'); // PATH 兜底

  let lastErr = '未找到 lark-cli';
  let lastExit = -1;

  for (const bin of candidates) {
    // 绝对路径且文件不存在 → 跳过（避免 spawnSync 抛 ENOENT）
    if (/[\\/]/.test(bin) && !fs.existsSync(bin)) continue;

    const r = spawnSync(bin, args, {
      encoding: 'utf8',
      timeout,
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      env: cliEnv(),
    });

    if (r.error) {
      lastErr = r.error.code === 'ETIMEDOUT' ? '飞书命令行调用超时' : String(r.error.message || r.error);
      lastExit = -1;
      continue; // 换下一个候选路径
    }

    // 注意：spawnSync 的退出码字段是 status（部分环境下 exitCode 为 undefined）
    const code = (r.status !== undefined && r.status !== null)
      ? r.status
      : ((r.exitCode !== undefined && r.exitCode !== null) ? r.exitCode : -1);
    lastExit = code;
    const stdout = (r.stdout || '').trim();
    const stderr = (r.stderr || '').trim();

    if (lastExit === 10) {
      return { ok: false, exitCode: 10, data: null, error: '飞书命令行要求高危写确认（exit 10）' };
    }

    let data = null;
    if (stdout) {
      try { data = JSON.parse(stdout); } catch (_) { data = null; }
    }

    if (data && data.ok === true) {
      return { ok: true, exitCode: lastExit, data, error: '' };
    }
    if (data && data.ok === false) {
      const e = data.error || data.message || (data.msg) || '飞书接口返回失败';
      return { ok: false, exitCode: lastExit, data, error: typeof e === 'string' ? e : JSON.stringify(e) };
    }
    if (lastExit === 0 && data) {
      // 没有 ok 字段但退出码为 0，视为成功
      return { ok: true, exitCode: 0, data, error: '' };
    }

    lastErr = stderr || stdout || ('lark-cli 退出码 ' + lastExit);
    // 该候选能跑起来但不是成功 → 不再试其他候选，直接返回
    if (!r.error) {
      return { ok: false, exitCode: lastExit, data, error: lastErr.slice(0, 300) };
    }
  }

  return { ok: false, exitCode: lastExit, data: null, error: lastErr.slice(0, 300) };
}

/**
 * 以机器人身份给用户发一条私聊文本消息。
 * @returns {{ok:boolean, chatId:string, messageId:string, createTime:string, error:string}}
 */
function sendText(cfg, { toUserId, text, idempotencyKey }) {
  const args = ['im', '+messages-send', '--as', 'bot', '--user-id', toUserId, '--text', text];
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 50));

  const r = spawnLark(cfg, args, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, chatId: '', messageId: '', createTime: '', error: r.error };

  const d = (r.data && r.data.data) || {};
  return {
    ok: true,
    chatId: d.chat_id || '',
    messageId: d.message_id || '',
    createTime: d.create_time || '',
    error: '',
  };
}

/**
 * 以机器人身份给用户发一张交互卡片（带「同意 / 拒绝」按钮）。
 * @returns {{ok:boolean, chatId:string, messageId:string, createTime:string, error:string}}
 */
function sendCard(cfg, { toUserId, card, idempotencyKey }) {
  const args = [
    'im', '+messages-send', '--as', 'bot',
    '--user-id', toUserId,
    '--msg-type', 'interactive',
    '--content', JSON.stringify(card),
  ];
  if (idempotencyKey) args.push('--idempotency-key', String(idempotencyKey).slice(0, 50));

  const r = spawnLark(cfg, args, { timeoutMs: 20000 });
  if (!r.ok) return { ok: false, chatId: '', messageId: '', createTime: '', error: r.error };

  const d = (r.data && r.data.data) || {};
  return {
    ok: true,
    chatId: d.chat_id || '',
    messageId: d.message_id || '',
    createTime: d.create_time || '',
    error: '',
  };
}

/**
 * 用按钮点击事件里的 token 更新那张卡片（去掉按钮、显示结果）。
 * 令牌 30 分钟内有效、最多用 2 次；失败只记日志，不影响审批本身。
 * @returns {{ok:boolean, error:string}}
 */
function updateCard(cfg, { token, card }) {
  if (!token) return { ok: false, error: '缺少卡片更新令牌' };
  const r = spawnLark(cfg, [
    'api', 'POST', '/open-apis/interactive/v1/card/update',
    '--as', 'bot',
    '--data', JSON.stringify({ token, card }),
  ], { timeoutMs: 15000 });
  return { ok: r.ok, error: r.ok ? '' : r.error };
}

/**
 * 检查「卡片按钮回调」在开发者后台开了没有。
 * lark-cli 的 event consume --dry-run 会做这个前置检查，并在未开通时
 * 直接给出一个一键订阅链接 —— 用户点开确认即可，不用自己在后台里找。
 * @returns {{ok:boolean, blocked:boolean, hint:string, error:string}}
 */
function cardCallbackStatus(cfg) {
  const r = spawnLark(cfg, ['event', 'consume', 'card.action.trigger', '--as', 'bot', '--dry-run'],
    { timeoutMs: 25000 });
  if (!r.ok) return { ok: false, blocked: false, hint: '', error: r.error };

  const pre = (((r.data || {}).data || {}).decision || {}).preconditions || [];
  for (const p of pre) {
    if (p && p.name === 'console_event_published') {
      const blocked = p.status !== 'ok';
      return { ok: true, blocked, hint: p.hint || '', error: '' };
    }
  }
  return { ok: true, blocked: false, hint: '', error: '' };
}

/**
 * 以用户身份读取人机单聊里的消息（用于轮询回复）。
 * @returns {{ok:boolean, messages:Array, error:string}}
 */
function listMessages(cfg, { chatId, startIso, pageSize }) {
  const args = [
    'im', '+chat-messages-list',
    '--as', 'user',
    '--chat-id', chatId,
    '--no-reactions',
    '--order', 'desc',
    '--page-size', String(pageSize || 20),
  ];
  if (startIso) args.push('--start', startIso);

  const r = spawnLark(cfg, args, { timeoutMs: 15000 });
  if (!r.ok) return { ok: false, messages: [], error: r.error };

  const d = (r.data && r.data.data) || {};
  return { ok: true, messages: Array.isArray(d.messages) ? d.messages : [], error: '' };
}

/**
 * 读取飞书身份状态（供 status 自检与 init 自动配置用）。
 * opts.verify=true 时附加 --verify（会校验 token 有效性、稍慢），
 * 并额外返回当前登录用户的 openId / userName —— init 就是靠它自动填 userOpenId 的。
 */
function authStatus(cfg, opts) {
  const verify = !!(opts && opts.verify);
  const args = ['auth', 'status', '--json'];
  if (verify) args.push('--verify');

  const r = spawnLark(cfg, args, { timeoutMs: verify ? 25000 : 15000 });
  if (!r.ok) return { ok: false, bot: '未知', user: '未知', openId: '', userName: '', error: r.error };
  const id = (r.data && r.data.identities) || {};
  return {
    ok: true,
    bot: (id.bot && id.bot.status) || '未知',
    user: (id.user && id.user.status) || '未知',
    openId: (id.user && id.user.openId) || '',
    userName: (id.user && id.user.userName) || '',
    error: '',
  };
}

module.exports = {
  spawnLark, sendText, sendCard, updateCard, listMessages, authStatus,
  cardCallbackStatus, resolveCliPath, cliEnv, DEFAULT_CLI,
};
