'use strict';
// claude-approval / lib/describe.cjs
// 把工具调用翻译成人话，供审批消息与审批卡片使用。
//
// 设计红线：友好标题只做「翻译」，绝不隐藏真实内容。
// 跑命令时永远原样显示命令本身 —— 这道闸门的意义就是让你看清 AI 到底要干什么，
// 用委婉的说法把真实操作盖住，等于把闸门拆了。

// ---------------------------------------------------------------- 路径

// 长路径缩短成「…\最后两段」，手机上不至于撑成三行。
// 短路径原样返回，不做任何美化，避免把真实位置改得认不出来。
function shortenPath(p, maxSeg) {
  const s = String(p == null ? '' : p).trim();
  if (!s) return '';
  const n = maxSeg || 3;
  const sep = s.indexOf('\\') !== -1 ? '\\' : '/';
  const parts = s.split(/[\\/]+/).filter(Boolean);
  // 末尾是分隔符（目录）时保留标记
  const trailing = /[\\/]$/.test(s) ? sep : '';
  if (parts.length <= n) return parts.join(sep) + trailing;
  return '…' + sep + parts.slice(-n).join(sep) + trailing;
}

// ---------------------------------------------------------------- 风险提示

// 只用于给卡片标题换个颜色（提示「这个值得看一眼」），不参与任何决策。
// 宁可误报（多标一个橙色）也不漏报 —— 漏报的状态就是现在的样子。
const RISKY_PATTERNS = [
  /\brm\s+-[a-z]*[rf]/i,
  /\brmdir\s+\/s/i,
  /\bdel\s+\/[a-z]*[fsq]/i,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/i,
  /\bdd\s+if=/i,
  /\b(shutdown|reboot|poweroff)\b/i,
  /Remove-Item\b[^\n]*-(Recurse|Force)/i,
  /\bgit\s+(push\s+(-f|--force)|reset\s+--hard|clean\s+-[a-z]*f)/i,
  /\b(drop|truncate)\s+(table|database)/i,
  /\bchmod\s+-R\s+777/i,
  /\b(npm|yarn|pnpm)\s+publish\b/i,
  /\bcurl\b[^\n|]*\|\s*(ba|z|)sh\b/i,
  /\b(iwr|Invoke-WebRequest)\b[^\n|]*\|\s*iex\b/i,
];

function riskOf(toolName, ti) {
  if (String(toolName) !== 'Bash') return 'normal';
  const cmd = String(ti.command || '');
  for (const re of RISKY_PATTERNS) {
    if (re.test(cmd)) return 'high';
  }
  return 'normal';
}

// ---------------------------------------------------------------- 兜底取值

// 不认识的工具：按「信息量」挑一个字段显示，找不到就整体 JSON。
const PREFERRED_KEYS = [
  'file_path', 'path', 'notebook_path', 'command', 'pattern', 'query',
  'url', 'prompt', 'description', 'name',
];

function firstString(ti) {
  for (const k of PREFERRED_KEYS) {
    if (typeof ti[k] === 'string' && ti[k].trim()) return ti[k];
  }
  for (const k of Object.keys(ti)) {
    if (typeof ti[k] === 'string' && ti[k].trim()) return ti[k];
  }
  return '';
}

function clamp(s, n) {
  const t = String(s == null ? '' : s);
  return t.length <= n ? t : t.slice(0, n) + '…';
}

// ---------------------------------------------------------------- 主函数

/**
 * 把一次工具调用翻译成人话。
 * @returns {{icon:string, title:string, detail:string, note:string, risk:'normal'|'high'}}
 *   icon   emoji 前缀
 *   title  人话标题（做什么）
 *   detail 真实内容（哪个文件 / 哪条命令）—— 永不含糊
 *   note   补充说明，可为空
 *   risk   normal | high
 */
function describe(toolName, toolInput) {
  const ti = (toolInput && typeof toolInput === 'object') ? toolInput : {};
  const name = String(toolName || '');
  const risk = riskOf(name, ti);

  // MCP 外部工具：mcp__<服务>__<工具>
  if (name.indexOf('mcp__') === 0) {
    const parts = name.split('__');
    const server = parts[1] || '';
    const tool = parts.slice(2).join('__');
    return {
      icon: '🔌',
      title: '调用外部工具',
      detail: clamp((server ? server + ' · ' : '') + (tool || name), 200),
      note: '',
      risk: 'normal',
    };
  }

  const fileOf = (v) => shortenPath(v, 3);

  switch (name) {
    case 'Read':
      return { icon: '📖', title: '读取文件', detail: fileOf(ti.file_path || ti.path), note: '', risk };

    case 'Write': {
      // 人话文案不再显示文件内容（手机上也没法读），但至少给出体量，
      // 让你知道这是「改一行」还是「灌一整个文件」。
      const len = typeof ti.content === 'string' ? ti.content.length : 0;
      return {
        icon: '✍️', title: '写入文件（新建或覆盖）', detail: fileOf(ti.file_path),
        note: len ? '内容 ' + len.toLocaleString('en-US') + ' 字符' : '', risk,
      };
    }

    case 'Edit':
      return { icon: '✏️', title: '修改文件', detail: fileOf(ti.file_path), note: '', risk };

    case 'MultiEdit':
      return {
        icon: '✏️', title: '批量修改文件', detail: fileOf(ti.file_path),
        note: Array.isArray(ti.edits) ? '共 ' + ti.edits.length + ' 处改动' : '', risk,
      };

    case 'NotebookEdit':
      return { icon: '📓', title: '修改笔记本', detail: fileOf(ti.notebook_path), note: '', risk };

    case 'Bash': {
      const cmd = String(ti.command || '');
      return {
        icon: '⚡', title: '执行命令', detail: clamp(cmd, 300),
        note: ti.description ? clamp(ti.description, 80) : '', risk,
      };
    }

    case 'BashOutput':
      return { icon: '⚡', title: '查看命令输出', detail: String(ti.bash_id || ''), note: '', risk };

    case 'KillShell':
      return { icon: '⛔', title: '终止后台命令', detail: String(ti.shell_id || ''), note: '', risk };

    case 'Glob':
      return { icon: '📂', title: '查找文件', detail: clamp(ti.pattern || '', 120), note: '', risk };

    case 'Grep':
      return { icon: '🔍', title: '搜索内容', detail: clamp(ti.pattern || '', 120), note: '', risk };

    case 'WebFetch':
      return { icon: '🌐', title: '访问网页', detail: clamp(hostOf(ti.url), 120), note: '', risk };

    case 'WebSearch':
      return { icon: '🔍', title: '联网搜索', detail: clamp(ti.query || '', 120), note: '', risk };

    case 'Task':
    case 'Agent':
      return {
        icon: '🤖', title: '派出子任务',
        detail: clamp(ti.description || ti.subagent_type || '', 120),
        note: ti.subagent_type ? '类型：' + ti.subagent_type : '', risk,
      };

    case 'TodoWrite': {
      const n = Array.isArray(ti.todos) ? ti.todos.length : 0;
      return { icon: '📝', title: '更新任务清单', detail: n ? '共 ' + n + ' 项' : '', note: '', risk };
    }

    case 'ExitPlanMode':
      return { icon: '📋', title: '提交方案待你确认', detail: '', note: '', risk };

    case 'AskUserQuestion':
      return { icon: '❓', title: '向你提问', detail: '', note: '', risk };

    case 'Skill':
      return { icon: '🧩', title: '调用技能', detail: clamp(ti.skill || ti.command || '', 120), note: '', risk };

    case 'SlashCommand':
      return { icon: '⌨️', title: '执行斜杠命令', detail: clamp(ti.command || '', 120), note: '', risk };

    default:
      return {
        icon: '🔧', title: '调用工具：' + (name || '未知'),
        detail: clamp(firstString(ti), 200), note: '', risk,
      };
  }
}

function hostOf(u) {
  const s = String(u || '');
  const m = s.match(/^[a-z]+:\/\/([^/?#]+)/i);
  return m ? m[1] : s;
}

// 纯文本摘要：给「不开卡片」时的文字消息用
function summaryLine(d) {
  const parts = [d.icon + ' ' + d.title];
  if (d.detail) parts.push(d.detail);
  return parts.join('：');
}

module.exports = { describe, shortenPath, summaryLine, riskOf, RISKY_PATTERNS };
