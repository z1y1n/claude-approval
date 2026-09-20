#!/usr/bin/env node
'use strict';
// claude-approval / hook.cjs
// Claude Code PreToolUse 钩子入口。
// 离开模式开启时：把工具调用推到手机飞书，阻塞等待用户回复 ok/no，再回传决策。
// 离开模式关闭时：立即放行，行为与未安装本中间件时完全一致。

const fs = require('fs');
const path = require('path');
const C = require('./lib/common.cjs');
const F = require('./lib/feishu.cjs');
const D = require('./lib/describe.cjs');
const Card = require('./lib/card.cjs');
const Buttons = require('./lib/button-daemon.cjs');

// ---------------------------------------------------------------- 读取 stdin

// Claude Code 通过 stdin 传入 JSON。一旦解析成功就立刻返回，不等 EOF，
// 避免某些情况下 stdin 迟迟不关闭导致每个工具调用都白等。
function readStdin() {
  return new Promise((resolve) => {
    let data = '';
    let done = false;
    let timer = null;

    const finish = () => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      try { process.stdin.removeAllListeners('data'); } catch (_) { /* 忽略 */ }
      try { process.stdin.removeAllListeners('end'); } catch (_) { /* 忽略 */ }
      try { process.stdin.removeAllListeners('error'); } catch (_) { /* 忽略 */ }
      try { process.stdin.pause(); } catch (_) { /* 忽略 */ }
      resolve(data);
    };

    timer = setTimeout(finish, 2000); // 安全兜底

    try {
      process.stdin.setEncoding('utf8');
    } catch (_) {
      return finish();
    }

    process.stdin.on('data', (chunk) => {
      data += chunk;
      const t = data.trim();
      if (t.startsWith('{') && t.endsWith('}')) {
        try { JSON.parse(t); finish(); } catch (_) { /* 还没收完，继续 */ }
      }
    });
    process.stdin.on('end', finish);
    process.stdin.on('error', finish);
  });
}

// ---------------------------------------------------------------- 主流程

async function main() {
  let input = null;
  try {
    const raw = await readStdin();
    input = JSON.parse(raw);
  } catch (e) {
    // 输入异常 → 失败打开，绝不因为中间件出错而卡住用户
    C.log('stdin 解析失败，放行：' + (e && e.message));
    process.exit(0);
  }

  if (!input || !input.tool_name) process.exit(0);

  // 第一道闸：不在离开模式 → 立即放行（这是绝大多数时候的路径）
  if (!C.isAway()) process.exit(0);

  const cfg = C.loadConfig();
  C.ensureDirs();
  C.gcStale(cfg);

  const toolName = input.tool_name;
  const toolInput = input.tool_input || {};

  // 豁免清单（只读类工具，默认不审批）
  const exempt = Array.isArray(cfg.exemptTools) ? cfg.exemptTools : [];
  if (exempt.indexOf(toolName) !== -1) process.exit(0);

  // 配置自检：没有审批接收人就发不出审批请求 —— 失败关闭，不放行。
  // 提前拦下，避免走到「发送失败」那条更绕的错误路径上去。
  if (!cfg.userOpenId) {
    C.exitDeny('配置缺少 userOpenId（审批接收人），无法把审批请求发到你的手机，已自动拒绝该操作。'
      + '请先在中间件目录执行：node toggle.cjs init');
  }

  // ------------------------------------------------------------ 批准缓存
  const keyHash = C.sha256hex(toolName + '\n' + JSON.stringify(toolInput));
  const cacheFile = path.join(C.DIRS.cache, keyHash.slice(0, 16) + '.json');
  const cached = C.readJsonSafe(cacheFile);
  if (cached && cached.expires_at > Date.now()) {
    cached.last_used = Date.now();
    C.writeJsonAtomic(cacheFile, cached);
    C.log('缓存放行 ' + toolName + ' ' + keyHash.slice(0, 8));
    // 必须输出 allow 决策，否则默认权限模式下仍会弹出本地对话框（人不在电脑前会卡住）
    C.printDecision('allow', '该操作在 ' + cfg.cacheTtlMin + ' 分钟内已批准过，自动放行。');
    process.exit(0);
  }

  // ------------------------------------------------------------ 发起审批
  // 编号要避开「最近用过的」，不只是「当前待审批的」。
  // 旧卡片上的按钮在令牌失效前仍可点击；编号一旦被回收，那次点击会被误配到新请求上。
  const existing = new Set();
  try {
    for (const f of fs.readdirSync(C.DIRS.pending)) {
      if (f.endsWith('.json')) existing.add(f.replace(/\.json$/, ''));
    }
  } catch (_) { /* 目录为空 */ }
  C.recentDecisionIds().forEach((x) => existing.add(x));

  const id = C.genId(cfg, existing);
  const pendingFile = path.join(C.DIRS.pending, id + '.json');
  const inputPreview = C.truncate(JSON.stringify(toolInput), cfg.maxToolInputChars);
  const desc = D.describe(toolName, toolInput); // 只算一次：消息、卡片、决策后的卡片都用它

  const pending = {
    id,
    tool_name: toolName,
    tool_input_preview: inputPreview,
    key_hash: keyHash,
    session_id: input.session_id || '',
    cwd: input.cwd || '',
    created_at: Date.now(),
    decision: null,
    last_clarify_at: 0,
    desc, // 决策后由按钮守护进程读取，用来重建卡片
  };
  C.writeJsonAtomic(pendingFile, pending);

  const msgText = C.buildApprovalMessage(cfg, id, toolName, toolInput);
  const idemKey = ('apr-' + id + '-' + Date.now().toString(36)).slice(0, 50);

  const sendTextNow = (k) => F.sendText(cfg, { toUserId: cfg.userOpenId, text: msgText, idempotencyKey: k });
  const sendCardNow = (k) => F.sendCard(cfg, {
    toUserId: cfg.userOpenId,
    card: Card.buildApprovalCard(cfg, { id, toolName, toolInput, desc }),
    idempotencyKey: k,
  });

  // 按钮通道可用才发卡片：守护进程没起来时发一张点不动的卡片只会让人困惑，
  // 不如老老实实发文字。文字回复在任何情况下都是可用的。
  //
  // 心跳必须是「新鲜的」才算可用。只看「进程还在不在」不够：守护进程活着但长连接
  // 断了没重连上时，卡片照样发得出去，你点了却没人接 —— 那正是最容易被误判成
  // 「按钮坏了」的情况。宁可退回纯文字，因为文字回复在任何情况下都有效。
  const ds = Buttons.daemonStatus();
  const wantButtons = cfg.useCardButtons !== false && ds.running && ds.fresh;
  let sendRes = wantButtons ? sendCardNow(idemKey) : sendTextNow(idemKey);

  if (!sendRes.ok) {
    await C.sleep(2000);
    // 同一个 idempotency-key：飞书 1 小时内不会重复发，重试是安全的
    sendRes = wantButtons ? sendCardNow(idemKey) : sendTextNow(idemKey);
  }
  if (!sendRes.ok && wantButtons) {
    // 卡片发不出去（客户端太旧、卡片结构被拒等）→ 退回纯文字，别让请求石沉大海
    C.log('卡片发送失败，退回纯文字：' + sendRes.error);
    sendRes = sendTextNow(idemKey + '-t');
  }
  if (!sendRes.ok) {
    C.removeQuiet(pendingFile);
    C.log('发送审批请求失败：' + sendRes.error);
    C.exitDeny('无法把审批请求发送到手机飞书（' + sendRes.error + '），已自动拒绝该操作。');
  }

  // 记住会话 ID，后续轮询用
  if (sendRes.chatId && sendRes.chatId !== cfg.chatId) {
    C.writeJsonAtomic(C.FILES.chatid, { chat_id: sendRes.chatId, found_at: Date.now() });
  }
  const chatId = sendRes.chatId || cfg.chatId || (C.readJsonSafe(C.FILES.chatid) || {}).chat_id;
  if (!chatId) {
    C.removeQuiet(pendingFile);
    C.exitDeny('配置不完整：没有可用的飞书会话 ID，请先双击「查看审批状态.bat」排查。');
  }

  // 用发送响应里的服务器时间作为回复下限，免疫本机时钟偏差
  const sentAt = C.parseLarkTime(sendRes.createTime) || new Date();
  const startIso = new Date(sentAt.getTime() - 60000).toISOString();

  C.log('已发送审批 ' + id + ' ' + toolName + ' 会话=' + chatId);

  // ------------------------------------------------------------ 轮询等待回复
  const deadline = Date.now() + cfg.waitTimeoutSec * 1000;
  const seen = new Set();
  let lastPollErr = '';

  // 放行：写缓存（同样的操作短时间内不再打扰你）+ 告诉 Claude Code 跳过本地弹窗
  const grantAndExit = (how) => {
    C.writeJsonAtomic(cacheFile, {
      tool_name: toolName,
      key_hash: keyHash,
      created_at: Date.now(),
      expires_at: Date.now() + cfg.cacheTtlMin * 60000,
      last_used: Date.now(),
    });
    C.removeQuiet(pendingFile);
    C.log(how + ' ' + id + ' ' + toolName);
    C.printDecision('allow', '用户已在手机上批准（审批编号 ' + id + '）。');
    process.exit(0);
  };

  while (true) {
    // 用户回家了 / 中途关掉开关 → 回落本地正常权限流程，不误拒绝
    if (!C.isAway()) {
      C.removeQuiet(pendingFile);
      C.log('等待期间离开模式被关闭，放行 ' + id);
      process.exit(0);
    }

    if (Date.now() >= deadline) {
      C.removeQuiet(pendingFile);
      C.log('审批超时 ' + id + ' ' + toolName);
      C.exitDeny(
        '等待手机审批超时（' + cfg.waitTimeoutSec + ' 秒内未收到回复），已自动拒绝该操作。' +
        (lastPollErr ? '（轮询异常：' + lastPollErr + '）' : '')
      );
    }

    // ---- 先看按钮有没有被点（本地小文件，比轮询飞书快，也不消耗飞书接口额度）----
    // 决策文件由守护进程用「独占创建」写入，所以这里读到的一定是唯一那次点击。
    const dec = C.readDecision(id);
    if (dec) {
      if (dec.decision === 'allow') grantAndExit('手机按钮批准');
      C.removeQuiet(pendingFile);
      C.log('手机按钮拒绝 ' + id + ' ' + toolName);
      C.exitDeny('用户已在手机上点击「拒绝」该操作（审批编号 ' + id + '）。'
        + '请勿重试相同操作，除非用户另有指示。');
    }

    const r = F.listMessages(cfg, { chatId, startIso, pageSize: 20 });
    if (!r.ok) {
      // 轮询瞬时失败不判负，记日志继续等
      lastPollErr = r.error;
      C.log('轮询失败（忽略）：' + r.error);
      await C.sleep(cfg.pollIntervalSec * 1000);
      continue;
    }

    // 只认「用户本人发的、未撤回的、本次请求之后」的文本消息
    const cands = r.messages.filter((m) => {
      if (!m || !m.message_id || seen.has(m.message_id)) return false;
      if (m.msg_type !== 'text') return false;
      if (m.deleted === true) return false;
      const s = m.sender || {};
      if (s.sender_type !== 'user') return false;
      return s.id === cfg.userOpenId;
    });
    cands.forEach((m) => seen.add(m.message_id));

    // 按时间升序处理：先回复的先生效（先 no 后 ok → 拒绝）
    cands.sort((a, b) => {
      const ta = String(a.create_time || '');
      const tb = String(b.create_time || '');
      if (ta !== tb) return ta < tb ? -1 : 1;
      return String(a.message_id) < String(b.message_id) ? -1 : 1;
    });

    for (const m of cands) {
      // 明显早于本次请求的旧消息，忽略（列表时间只到分钟，故留 61 秒余量）
      const mt = C.parseLarkTime(m.create_time);
      if (mt && sentAt && mt.getTime() < sentAt.getTime() - 61000) continue;

      const text = C.extractText(m.content);
      const parsed = C.matchReply(text);
      if (!parsed) continue;

      if (parsed.replyId && parsed.replyId !== id) continue; // 回复的是别的审批编号

      if (!parsed.replyId) {
        // 裸 ok/no：仅当只有一条待审批时适用
        const und = C.undecidedPending();
        if (und.length === 0) continue;
        if (und.length > 1) {
          // 多条待审批：只让最老的那条发一次澄清提示（30 秒节流）
          const oldest = und.slice().sort((a, b) => a.created_at - b.created_at)[0];
          if (oldest && oldest.id === id && Date.now() - (pending.last_clarify_at || 0) > 30000) {
            pending.last_clarify_at = Date.now();
            C.writeJsonAtomic(pendingFile, pending);
            const list = und
              .slice()
              .sort((a, b) => a.created_at - b.created_at)
              .map((p) => p.id + ' — ' + p.tool_name)
              .join('\n');
            F.sendText(cfg, {
              toUserId: cfg.userOpenId,
              text: '当前有 ' + und.length + ' 个待审批请求，请带编号回复，例如：1 ' + oldest.id + '\n\n' + list,
            });
          }
          continue;
        }
        // und.length === 1 且我自己就在 pending 里 → 这条裸回复是给我的
      }

      // ---- 命中本条请求：先原子认领这条回复，再决策 ----
      // 一条回复只能被消费一次。否则用户在手机上回一个 ok，
      // 可能被后续多个审批请求重复消费，连续放行 TA 根本没看过的操作。
      if (!C.claimMessage(m.message_id)) continue;

      if (parsed.allow) grantAndExit('手机批准');

      C.removeQuiet(pendingFile);
      C.log('手机拒绝 ' + id + ' ' + toolName);
      C.exitDeny(
        '用户已在手机上拒绝该操作（审批编号 ' + id + '）' +
        (parsed.extra ? '：' + C.truncate(parsed.extra, cfg.maxReplyTextChars) : '。') +
        '请勿重试相同操作，除非用户另有指示。'
      );
    }

    await C.sleep(cfg.pollIntervalSec * 1000);
  }
}

process.on('uncaughtException', (e) => {
  C.log('未捕获异常，放行：' + (e && e.stack ? e.stack : e));
  process.exit(0); // 失败打开
});

main().catch((e) => {
  C.log('主流程异常，放行：' + (e && e.stack ? e.stack : e));
  process.exit(0);
});
