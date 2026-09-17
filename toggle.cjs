#!/usr/bin/env node
'use strict';
// claude-approval / toggle.cjs
// 用法：node toggle.cjs on | off | status | init [--force]
// 退出码：0 正常 / 1 有警告 / 2 用法错误

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');
const C = require('./lib/common.cjs');
const F = require('./lib/feishu.cjs');

const SETTINGS = path.join(os.homedir(), '.claude', 'settings.json');

function fmtTime(ms) {
  if (!ms) return '';
  return new Date(ms).toLocaleString('zh-CN', { hour12: false });
}

// ---------------------------------------------------------------- on

function doOn() {
  const cfg = C.loadConfig();
  C.ensureDirs();

  if (C.isAway()) {
    console.log('ℹ️  远程审批已处于开启状态（开启于 ' + fmtTime(C.awaySince()) + '）');
    return 0;
  }

  if (!cfg.userOpenId) {
    console.log('❌ 配置缺少 userOpenId，无法发送审批消息。请检查 config.json。');
    return 1;
  }

  console.log('正在发送测试消息到你的飞书…');
  const res = F.sendText(cfg, {
    toUserId: cfg.userOpenId,
    text: '✅ 远程审批已开启\n'
        + '之后 Claude 需要权限的操作会发到这里，\n'
        + '回复「ok 编号」同意 / 「no 编号」拒绝。\n\n'
        + '提醒：若你希望手机审批成为唯一门禁，请确认 Claude Code 的权限模式没有设为「跳过权限」。',
  });

  // 无论发送是否成功，本地都开启（保证离线也能开启），失败时给出警告
  C.writeJsonAtomic(C.FILES.flag, { on_at: Date.now() });

  if (!res.ok) {
    console.log('');
    console.log('⚠️  远程审批已在本地开启，但测试消息发送失败：' + res.error);
    console.log('   手机可能收不到审批请求，请检查飞书网络后重新执行本脚本。');
    console.log('   可双击「查看审批状态.bat」复查。');
    return 1;
  }

  if (res.chatId && res.chatId !== cfg.chatId) {
    const updated = Object.assign({}, cfg, { chatId: res.chatId });
    C.writeJsonAtomic(C.FILES.config, updated);
    console.log('（已自动记录飞书会话 ID：' + res.chatId + '）');
  }

  console.log('');
  console.log('✅ 远程审批已开启，测试消息已发到你的手机飞书。');
  console.log('   现在可以放心离开电脑了。回来时双击「关闭远程审批.bat」即可恢复。');
  return 0;
}

// ---------------------------------------------------------------- off

function doOff() {
  const wasOn = C.isAway();
  C.removeQuiet(C.FILES.flag);
  const cleared = C.clearState();
  console.log('✅ 已关闭远程审批，恢复本机操作。');
  if (wasOn) {
    console.log('   （已清理 ' + cleared + ' 条待审批/缓存记录，避免残留放行）');
  } else {
    console.log('   （远程审批本来就是关闭状态）');
  }
  return 0;
}

// ---------------------------------------------------------------- status

// 可执行文件自检：优先看显式配置的路径，路径为空或不存在时，
// 退一步看 PATH 里能不能真的跑起来（开源版默认就靠 PATH）。
function checkBinary(explicitPath, label, cmd, args) {
  let exists = false;
  if (explicitPath) {
    try { exists = fs.existsSync(explicitPath); } catch (_) { exists = false; }
  }
  if (exists) {
    console.log('  ✓ ' + label);
    return true;
  }

  const r = spawnSync(cmd, args || ['--version'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
  if (!r.error && r.status === 0) {
    const ver = String(r.stdout || '').trim().split('\n')[0];
    console.log('  ✓ ' + label + '（PATH：' + ver + '）');
    return true;
  }
  console.log('  ✗ ' + label + '  ← 找不到'
    + (explicitPath ? '：' + explicitPath + '（PATH 里也没有）' : '（PATH 里也没有）'));
  return false;
}

function settingsHasHook() {
  try {
    const raw = fs.readFileSync(SETTINGS, 'utf8');
    if (!raw.includes('claude-approval')) return { present: false, valid: true };
    JSON.parse(raw);
    return { present: true, valid: true };
  } catch (e) {
    return { present: false, valid: false, err: e.message };
  }
}

function doStatus() {
  const cfg = C.loadConfig();
  let warn = false;

  console.log('════════ 远程审批中间件 状态 ════════');
  console.log('');

  // 开关状态
  if (C.isAway()) {
    console.log('开关：🟢 开启中（开启于 ' + fmtTime(C.awaySince()) + '）');
  } else {
    console.log('开关：⚪ 未开启 —— Claude 的工具调用不会被打扰');
  }
  console.log('');

  // 飞书通道
  console.log('飞书通道：');
  const auth = F.authStatus(cfg);
  if (auth.ok) {
    console.log('  机器人身份：' + auth.bot + (auth.bot === 'ready' ? ' ✓' : ' ⚠️'));
    console.log('  用户身份：' + auth.user + (auth.user === 'ready' ? ' ✓' : ' ⚠️（首次读取会自动刷新，稍慢属正常）'));
    if (auth.bot !== 'ready') warn = true;
  } else {
    console.log('  ⚠️ 无法读取飞书身份状态：' + auth.error);
    warn = true;
  }
  const chatId = cfg.chatId || (C.readJsonSafe(C.FILES.chatid) || {}).chat_id || '';
  console.log('  会话 ID：' + (chatId || '（空 —— 请先执行一次「开启远程审批」）'));
  console.log('');

  // 待审批与缓存
  const pend = C.listPending();
  const und = C.undecidedPending();
  console.log('待审批请求：' + und.length + ' 条' + (pend.length !== und.length ? '（另有 ' + (pend.length - und.length) + ' 条已决策待清理）' : ''));
  und.slice(0, 10).forEach((p) => {
    console.log('  · ' + p.id + ' — ' + p.tool_name + '（' + fmtTime(p.created_at) + '）');
  });
  if (und.length > 0) {
    console.log('  → 可在飞书上回复「ok 编号」或「no 编号」处理积压请求');
  }
  let cacheN = 0;
  try { cacheN = fs.readdirSync(C.DIRS.cache).filter((f) => f.endsWith('.json')).length; } catch (_) { /* 忽略 */ }
  console.log('放行缓存：' + cacheN + ' 条' + (cacheN ? '（' + cfg.cacheTtlMin + ' 分钟内相同操作自动放行）' : ''));
  console.log('');

  // 关键文件自检
  console.log('关键文件自检：');
  const okNode = checkBinary(cfg.nodePath, 'Node 运行时', 'node', ['--version']);
  const okCli = checkBinary(cfg.larkCliPath || F.DEFAULT_CLI, '飞书命令行 lark-cli', 'lark-cli', ['--version']);
  if (!okNode || !okCli) warn = true;

  const s = settingsHasHook();
  if (!s.valid) {
    console.log('  ✗ Claude Code 配置文件不是合法 JSON  ← 请检查 ' + SETTINGS);
    warn = true;
  } else if (s.present) {
    console.log('  ✓ Claude Code 钩子入口已注册');
  } else {
    console.log('  ✗ Claude Code 钩子入口缺失  ← 远程审批不会生效');
    console.log('    可能原因：Clawd on Desk 更新时重写了 settings.json。');
    console.log('    处理：需要重新把钩子条目加回 ' + SETTINGS);
    warn = true;
  }
  console.log('');

  // 最近日志
  console.log('最近日志：');
  try {
    const lines = fs.readFileSync(C.FILES.log, 'utf8').trim().split('\n');
    lines.slice(-6).forEach((l) => console.log('  ' + l));
  } catch (_) {
    console.log('  （暂无日志）');
  }
  console.log('');
  console.log('════════════════════════════════════');
  return warn ? 1 : 0;
}

// ---------------------------------------------------------------- init

// 首次使用的配置引导：从模板生成 config.json，并自动填入你自己的飞书 open_id。
// 原则：只填「还是空的」字段，绝不覆盖已有值 —— 重复执行是安全的。
function doInit(force) {
  C.ensureDirs();
  let cfg = C.readJsonSafe(C.FILES.config);

  if (cfg && !force) {
    console.log('ℹ️  config.json 已存在，未做任何改动。');
    console.log('   当前审批接收人：' + (cfg.userOpenId || '（空 —— 尚未配置）'));
    console.log('   如需自动补全仍为空的字段，执行：node toggle.cjs init --force');
    return 0;
  }

  const isNew = !cfg;
  if (isNew) {
    const tpl = C.readJsonSafe(C.FILES.configExample);
    if (!tpl) {
      console.log('❌ 找不到配置模板 config.example.json（应与本脚本在同一目录）。');
      return 1;
    }
    cfg = Object.assign({}, tpl);
  }

  if (!cfg.userOpenId) {
    console.log('正在查询飞书登录身份…');
    const auth = F.authStatus(cfg, { verify: true });
    if (auth.ok && auth.openId) {
      cfg.userOpenId = auth.openId;
      console.log('✓ 已识别审批接收人：' + (auth.userName ? auth.userName + '  ' : '') + auth.openId);
    } else {
      console.log('⚠️  未能自动获取 userOpenId：' + (auth.error || '飞书账号尚未登录'));
    }
  }

  if (!C.writeJsonAtomic(C.FILES.config, cfg)) {
    console.log('❌ 写入 config.json 失败，请检查目录权限。');
    return 1;
  }
  console.log(isNew ? '✓ 已生成 config.json' : '✓ 已更新 config.json');

  if (!cfg.userOpenId) {
    console.log('');
    console.log('还需补上「审批接收人」，二选一：');
    console.log('  方式一：先完成飞书登录，再重跑本命令');
    console.log('          lark-cli auth login --domain im --no-wait --json');
    console.log('          node toggle.cjs init --force');
    console.log('  方式二：把你的飞书 open_id 手工填进 config.json 的 "userOpenId"');
    return 1;
  }

  console.log('');
  console.log('接下来：');
  console.log('  1. 按 README 的「安装」一节，把 hook.cjs 注册进 Claude Code 的 settings.json');
  console.log('  2. 执行 node toggle.cjs on（或双击「开启远程审批.bat」）开始使用');
  return 0;
}

// ---------------------------------------------------------------- 入口

const cmd = (process.argv[2] || '').toLowerCase();
let code = 2;
if (cmd === 'on') code = doOn();
else if (cmd === 'off') code = doOff();
else if (cmd === 'status') code = doStatus();
else if (cmd === 'init') code = doInit(process.argv.indexOf('--force') !== -1);
else {
  console.log('用法：node toggle.cjs on | off | status | init [--force]');
  code = 2;
}
process.exit(code);
