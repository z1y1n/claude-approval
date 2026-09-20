#!/usr/bin/env node
'use strict';
// claude-approval / lib/button-daemon.cjs
// 按钮守护进程：常驻监听飞书卡片上的按钮点击。
//
// 它只做一件事 —— 把一个「校验过的点击」原子地落成 runtime/decisions/<编号>.json。
// 放行还是拦截，仍然由 hook.cjs 决定。决策权不在这个进程手里，
// 这样即使守护进程行为异常，也最多是「多写了一个没人读的文件」，而不是「绕过审批」。
//
// 由 toggle.cjs on 启动，off 时停止；离开模式被关掉时自己退出。

const path = require('path');
const { spawn } = require('child_process');
const C = require('./common.cjs');
const F = require('./feishu.cjs');
const Card = require('./card.cjs');

const HEARTBEAT = path.join(C.DIRS.runtime, 'button-daemon.json');
const TEST_ID = 'test0'; // 开启时那张测试卡片的编号，不参与任何真实审批

const state = {
  pid: process.pid,
  child_pid: 0,
  started_at: Date.now(),
  child_started_at: 0,
  updated_at: 0,
  last_event_at: 0,
  events: 0,
  last_error: '',
  stopped_at: 0,
  stop_reason: '',
};

let child = null;
let shuttingDown = false;
let backoff = 3000;

function beat() {
  state.updated_at = Date.now();
  C.writeJsonAtomic(HEARTBEAT, state);
}

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  state.stopped_at = Date.now();
  state.stop_reason = reason;
  state.child_pid = 0;
  beat();
  if (child) { try { child.kill(); } catch (_) { /* 已退出 */ } }
  C.log('按钮守护进程退出：' + reason);
  // 给子进程一点时间收尸，然后硬退
  setTimeout(() => process.exit(0), 400);
}

// ---------------------------------------------------------------- 子进程

function startChild(cfg) {
  if (shuttingDown) return;
  let bin;
  try {
    bin = F.resolveCliPath(cfg);
  } catch (e) {
    C.log('按钮守护：解析 lark-cli 路径失败：' + (e && e.message));
    bin = 'lark-cli';
  }

  try {
    child = spawn(bin, ['event', 'consume', 'card.action.trigger', '--as', 'bot'], {
      env: F.cliEnv(),
      windowsHide: true,
    });
  } catch (e) {
    state.last_error = String(e && e.message);
    beat();
    C.log('按钮守护：启动 lark-cli 失败：' + state.last_error);
    setTimeout(() => startChild(cfg), backoff);
    backoff = Math.min(backoff * 2, 60000);
    return;
  }

  state.child_pid = child.pid || 0;
  state.child_started_at = Date.now();
  beat();

  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (line) {
        try { handleLine(cfg, line); } catch (e) {
          C.log('按钮守护：处理事件异常：' + (e && e.message));
        }
      }
    }
    if (buf.length > 1024 * 1024) buf = ''; // 防御：非 NDJSON 的异常输出别把内存撑爆
  });

  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => {
    const s = String(chunk).trim();
    if (s) C.log('[按钮守护] lark-cli: ' + s.slice(0, 300));
  });

  child.on('error', (e) => {
    state.last_error = String((e && e.message) || e);
    beat();
    C.log('按钮守护：lark-cli 错误：' + state.last_error);
  });

  child.on('exit', (code) => {
    const ranMs = Date.now() - (state.child_started_at || Date.now());
    state.child_pid = 0;
    if (shuttingDown) return;
    state.last_error = 'lark-cli 退出，code=' + code;
    beat();
    // 稳定运行过一阵又断了 → 退避重置，重连要快
    if (ranMs > 60000) backoff = 3000;
    C.log('按钮守护：lark-cli 退出（code=' + code + '，运行 ' + Math.round(ranMs / 1000)
      + ' 秒），' + Math.round(backoff / 1000) + ' 秒后重连');
    setTimeout(() => startChild(cfg), backoff);
    backoff = Math.min(backoff * 2, 60000);
  });
}

// ---------------------------------------------------------------- 事件处理

function handleLine(cfg, line) {
  let ev;
  try { ev = JSON.parse(line); } catch (_) { return; } // 非 JSON 行是提示信息，忽略
  if (!ev || ev.type !== 'card.action.trigger') return;
  if (ev.action_tag !== 'button') return; // 卡片上只有按钮，其它一律不理

  state.last_event_at = Date.now();
  state.events = (state.events || 0) + 1;

  // 只有你本人的点击算数。别人点了（理论上不会发生，这条聊天只有你和机器人）直接忽略。
  const op = String(ev.operator_id || '');
  if (!cfg.userOpenId || op !== cfg.userOpenId) {
    C.log('按钮守护：忽略非本人的点击');
    beat();
    return;
  }

  let val = ev.action_value;
  if (typeof val === 'string') {
    try { val = JSON.parse(val); } catch (_) { val = null; }
  }
  const id = val && val.id ? String(val.id) : '';
  const decision = val && val.d === 'allow' ? 'allow' : (val && val.d === 'deny' ? 'deny' : '');
  if (!id || !decision) {
    C.log('按钮守护：点击事件里没有可识别的编号/决策，已忽略');
    beat();
    return;
  }

  // 原子认领：第一次点击成功，之后对这个编号的点击都会失败。
  // 这就是「一次点击只放行一个操作」在按钮通道上的实现。
  const claimed = C.writeDecision(id, decision, {
    source: 'button',
    operator: op,
    event_id: ev.event_id || '',
    message_id: ev.message_id || '',
  });
  if (!claimed) {
    C.log('按钮守护：编号 ' + id + ' 已有决策，忽略重复点击');
    beat();
    return;
  }

  C.log('按钮守护：收到点击 ' + id + ' → ' + decision);

  // 换掉卡片：按钮消失、显示你选了什么，防止旧卡片被反复点击
  try {
    let card;
    if (id === TEST_ID) {
      card = Card.buildTestResultCard(decision === 'allow');
    } else {
      const pend = C.readJsonSafe(path.join(C.DIRS.pending, id + '.json'));
      card = Card.buildResultCard({
        id,
        desc: (pend && pend.desc) || null,
        decision,
      });
    }
    const r = F.updateCard(cfg, { token: ev.token, card });
    if (!r.ok) C.log('按钮守护：更新卡片失败（不影响审批本身）：' + r.error);
  } catch (e) {
    C.log('按钮守护：更新卡片异常（不影响审批本身）：' + (e && e.message));
  }
  beat();
}

// ---------------------------------------------------------------- 生命周期

function main() {
  C.ensureDirs();
  const cfg = C.loadConfig();

  if (!cfg.userOpenId) {
    C.log('按钮守护：配置缺少 userOpenId，拒绝启动');
    process.exit(2);
  }

  C.log('按钮守护进程启动（pid ' + process.pid + '）');
  beat();
  startChild(cfg);

  // 每 5 秒：刷新心跳 + 检查离开模式是否已被关掉
  setInterval(() => {
    if (shuttingDown) return;
    if (!C.isAway()) { shutdown('离开模式已关闭'); return; }
    beat();
  }, 5000);

  process.on('SIGTERM', () => shutdown('收到停止信号'));
  process.on('SIGINT', () => shutdown('收到中断信号'));
  process.on('uncaughtException', (e) => {
    C.log('按钮守护：未捕获异常：' + (e && e.stack ? e.stack : e));
    shutdown('未捕获异常');
  });
}

// ---------------------------------------------------------------- 供 toggle 调用

// 守护进程是否活着（读心跳 + 探进程；不启动、不连接）
function daemonStatus() {
  const hb = C.readJsonSafe(HEARTBEAT);
  if (!hb || !hb.pid) return { running: false, hb: null, reason: '从未启动' };
  if (hb.stopped_at) return { running: false, hb, reason: '已停止（' + (hb.stop_reason || '') + '）' };
  let alive = false;
  try { process.kill(hb.pid, 0); alive = true; } catch (_) { alive = false; }
  if (!alive) return { running: false, hb, reason: '进程已不在（可能被系统结束）' };
  const fresh = hb.updated_at && (Date.now() - hb.updated_at < 30000);
  return { running: true, fresh: !!fresh, hb, reason: fresh ? '' : '心跳超时，可能卡住' };
}

// 停止守护进程（连同它的 lark-cli 子进程）
function stopDaemon() {
  const hb = C.readJsonSafe(HEARTBEAT);
  if (!hb) return false;
  let any = false;
  for (const pid of [hb.pid, hb.child_pid]) {
    if (!pid) continue;
    try { process.kill(pid); any = true; } catch (_) { /* 已经没了 */ }
  }
  return any;
}

if (require.main === module) main();

// 供测试直接喂事件用（见 docs/_t_button.cjs）。
// 单独导出是为了让「只认本人点击」这条判断能被真正验证到，
// 而不是只能靠读代码相信它。
module.exports = { daemonStatus, stopDaemon, handleLine, HEARTBEAT, TEST_ID };
