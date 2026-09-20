'use strict';
// claude-approval / lib/card.cjs
// 审批卡片（飞书 Card 2.0）的构造。
//
// 为什么用卡片：手机上有两个现成的按钮，不用打字。按钮点击通过
// card.action.trigger 事件回到本机的后台守护进程（见 button-daemon.cjs）。
//
// 安全前提：按钮只是「多一条路」，不是替代品。文字回复（1/0、ok/no）始终有效，
// 守护进程没起来时 hook 会自动改发纯文字，不会出现「点了没反应还不知道为什么」。

const C = require('./common.cjs');
const D = require('./describe.cjs');

const MAX_CODE = 600;

// 卡片 markdown 里反引号 / 代码围栏会破坏结构，替换掉再嵌入
function inline(s) {
  return String(s == null ? '' : s).replace(/`/g, "'");
}
function block(s) {
  return String(s == null ? '' : s).replace(/```/g, "'''");
}

// 命令用代码块（保留原样、易读），路径等短内容用行内代码
function codeOf(d) {
  if (!d.detail) return '';
  const isCmd = d.icon === '⚡' || d.icon === '⛔';
  if (isCmd && d.detail.length <= MAX_CODE) {
    return '```\n' + block(d.detail) + '\n```';
  }
  return '`' + inline(d.detail) + '`';
}

function button(text, type, id, decision) {
  return {
    tag: 'button',
    text: { tag: 'plain_text', content: text },
    type,
    width: 'fill',
    behaviors: [{ type: 'callback', value: { id, d: decision } }],
  };
}

/**
 * 审批卡片。
 * @param {object} cfg
 * @param {{id:string, toolName:string, toolInput:object, desc?:object}} req
 */
function buildApprovalCard(cfg, req) {
  const d = req.desc || D.describe(req.toolName, req.toolInput);
  const risky = d.risk === 'high';
  const id = req.id;

  const elements = [];
  elements.push({
    tag: 'markdown',
    content: '**' + d.icon + ' ' + inline(d.title) + '**' + (d.detail ? '\n' + codeOf(d) : ''),
  });
  if (d.note) elements.push({ tag: 'markdown', content: '（' + inline(d.note) + '）' });
  if (risky) {
    elements.push({ tag: 'markdown', content: '⚠️ **这个操作看起来有破坏性，看清楚再决定**' });
  }
  elements.push({ tag: 'hr', margin: '4px 0' });
  elements.push({
    tag: 'markdown',
    content: '编号 `' + id + '` · ' + inline(C.humanTimeout(cfg)) + '\n也可以直接回复 `1` / `0`',
  });
  elements.push({
    tag: 'column_set',
    flex_mode: 'bisect',
    horizontal_spacing: '8px',
    columns: [
      { tag: 'column', width: 'weighted', weight: 1, elements: [button('✅ 同意', 'primary_filled', id, 'allow')] },
      { tag: 'column', width: 'weighted', weight: 1, elements: [button('⛔ 拒绝', 'danger', id, 'deny')] },
    ],
  });

  const card = {
    schema: '2.0',
    config: {
      update_multi: true,
      width_mode: 'default',
      summary: { content: '🔐 需要批准：' + d.title + (d.detail ? ' ' + d.detail : '') },
    },
    header: {
      title: { tag: 'plain_text', content: risky ? '🔐 需要批准 · 注意风险' : '🔐 Claude Code 需要你批准' },
      template: risky ? 'red' : 'blue',
    },
    body: { direction: 'vertical', elements },
  };
  return card;
}

/**
 * 决策后的卡片：替换掉按钮，明确显示你选了什么。
 * 这样旧卡片的按钮不会一直留在那儿可点（防止重复点击 / 事后误触）。
 */
function buildResultCard(req) {
  const d = req.desc || {};
  const allow = req.decision === 'allow';
  // 点得够快时，hook 可能已经把待审批文件清掉了，desc 就是空的。
  // 那张卡片本身写着「你点了同意」就够了，不必显示一个空缺的标题。
  const head = d.title ? '**' + (d.icon || '') + ' ' + inline(d.title) + '**' : '**该操作**';
  const elements = [
    {
      tag: 'markdown',
      content: head + (d.detail ? '\n' + codeOf(d) : ''),
    },
    { tag: 'hr', margin: '4px 0' },
    {
      tag: 'markdown',
      content: '编号 `' + inline(req.id) + '` · 你点了「' + (allow ? '同意' : '拒绝') + '」',
    },
  ];
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: allow ? '✅ 已同意' : '⛔ 已拒绝' } },
    header: {
      title: { tag: 'plain_text', content: allow ? '✅ 已同意' : '⛔ 已拒绝' },
      template: allow ? 'green' : 'red',
    },
    body: { direction: 'vertical', elements },
  };
}

/**
 * 常驻测试卡片：开启远程审批时发一张，让你当场点一下确认按钮通道是通的。
 * 点击不会放行任何操作（编号不匹配任何待审批请求）。
 */
function buildTestCard() {
  const id = 'test0';
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: '✅ 远程审批已开启' } },
    header: { title: { tag: 'plain_text', content: '✅ 远程审批已开启' }, template: 'green' },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: '之后 Claude 需要授权的操作会发到这里。\n**顺手点一下下面的按钮，确认按钮通道是通的**（点了不会执行任何操作）。' },
        { tag: 'hr', margin: '4px 0' },
        { tag: 'column_set', flex_mode: 'bisect', horizontal_spacing: '8px', columns: [
          { tag: 'column', width: 'weighted', weight: 1, elements: [button('✅ 点我测试', 'primary_filled', id, 'allow')] },
          { tag: 'column', width: 'weighted', weight: 1, elements: [button('⛔ 点我测试', 'danger', id, 'deny')] },
        ] },
        { tag: 'markdown', content: '急用时也可以直接回复 `1` 同意 / `0` 拒绝。' },
      ],
    },
  };
}

// 测试卡片被点击后的样子：确认「按钮通道通了」这件事本身
function buildTestResultCard(ok) {
  return {
    schema: '2.0',
    config: { update_multi: true, width_mode: 'default', summary: { content: '✅ 按钮通道正常' } },
    header: { title: { tag: 'plain_text', content: '✅ 按钮通道正常' }, template: 'green' },
    body: {
      direction: 'vertical',
      elements: [
        { tag: 'markdown', content: '你已经成功点击了「**' + (ok ? '同意' : '拒绝') + '**」。\n说明按钮通道是通的 —— 以后收到审批请求，直接点按钮即可。' },
        { tag: 'hr', margin: '4px 0' },
        { tag: 'markdown', content: '（这条只是测试，没有执行任何操作）' },
      ],
    },
  };
}

module.exports = { buildApprovalCard, buildResultCard, buildTestCard, buildTestResultCard };
