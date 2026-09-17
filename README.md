# claude-approval

**Approve Claude Code's tool calls from your phone.**

A small, zero-dependency [Claude Code](https://claude.com/claude-code) `PreToolUse` hook that pushes every tool call to your phone via Feishu (Lark) and blocks until you reply. Walk away from the keyboard without either stalling the agent or handing it unrestricted access to your files.

[中文说明见下方](#中文说明)

---

## The problem

AI coding agents stop and ask for permission before most tool calls. When you're at the keyboard that's one click. When you're not, you have two bad options:

- **Leave it waiting** — the task stalls until you get back, sometimes on the very first file write.
- **Turn on "skip permissions"** — the agent now edits and runs whatever it wants, unattended.

This middleware adds a third option: a human-in-the-loop gate that follows you onto your phone.

## How it works

```
Claude Code wants to run a tool
        │
        ▼
  PreToolUse hook  (hook.cjs)
        │
        ├─ away mode off ──────────────────► exit 0   (identical to not being installed)
        ├─ read-only tool ─────────────────► exit 0   (Read / Glob / Grep …)
        ├─ approved in the last 10 min ────► allow    (no local permission prompt)
        │
        ▼
  send to Feishu as the bot  ──►  your phone:  "🔐 abcde   Bash   {"command":"…"}"
        │                                                    │
        │                                                    │  reply  "ok abcde"  /  "no abcde"
        ▼                                                    │
  poll the chat every 3 s as yourself  ◄─────────────────────┘
        │
        ├─ ok                        ► allow (no local prompt) + cached for 10 min
        ├─ no                        ► deny  (exit 2, reason is shown to the model)
        └─ 5 min with no reply       ► deny  (timeout)
```

The `allow` decision matters more than it looks: returning it from the hook makes Claude Code **skip its local permission dialog**, which is exactly what stops the agent from freezing on a prompt nobody is there to click.

## Features

| Feature | What it does | Tunable |
|---|---|---|
| **Remote approval** | Tool name + arguments (truncated to 600 chars) go to Feishu with a 5-letter ID. Reply `ok <id>` to allow, `no <id>` to deny. | `waitTimeoutSec` |
| **Approval cache** | The identical operation, once approved, is auto-allowed for 10 minutes — so reading the same file ten times asks once. | `cacheTtlMin` |
| **Read-only exemption** | Tools that cannot change anything (`Read`, `Glob`, `Grep`, …) pass straight through, otherwise your phone drowns in noise. | `exemptTools` |
| **Timeout = deny** | No reply within 5 minutes rejects the operation. Failing to reach you never means "yes". | `waitTimeoutSec` |
| **One-command toggle** | `on` / `off` / `status`, plus optional desktop shortcuts. When off, overhead is a single `existsSync` call. | — |
| **Self-check** | Verifies Feishu identity, that the hook is still registered, and whether requests are piling up. | — |
| **Guided setup** | `init` generates your config and fills in your own Feishu `open_id` automatically. | — |

## Requirements

- **Node.js 18+** (uses only built-in modules — no `npm install`)
- **Claude Code**
- **[lark-cli](https://www.npmjs.com/package/@larksuite/cli)** installed and authorized: `npm i -g @larksuite/cli`, then `lark-cli auth login --domain im --no-wait --json`
- A Feishu / Lark account (the free personal tier is enough)

## Install

**1. Clone**

```bash
git clone https://github.com/<you>/claude-approval.git
cd claude-approval
```

**2. Authorize Feishu** (skip if already done)

```bash
lark-cli auth login --domain im --no-wait --json
```

Open the URL it prints, approve, then re-run the command without `--no-wait`.

**3. Generate your config**

```bash
node toggle.cjs init
```

This creates `config.json` from `config.example.json` and auto-fills `userOpenId` with your own Feishu ID — the only person whose replies count as approval.

**4. Register the hook**

Add this to `~/.claude/settings.json` (create the file if it doesn't exist). **Replace the path with your actual clone location:**

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "node \"C:\\path\\to\\claude-approval\\hook.cjs\"",
            "timeout": 600,
            "statusMessage": "📱 Waiting for phone approval"
          }
        ]
      }
    ]
  }
}
```

> **On macOS / Linux:** drop the `"shell"` field and use a forward-slash path, e.g. `"command": "node \"/home/you/claude-approval/hook.cjs\""`.
>
> **About `timeout`:** it must stay **above** `waitTimeoutSec` (300 s by default). A hook that hits the harness timeout is *discarded and the tool call proceeds* — see [Security design](#security-design).

Restart your Claude Code session so the hook is picked up.

**5. Optional — desktop shortcuts**

`开启远程审批.bat` / `关闭远程审批.bat` / `查看审批状态.bat` are double-click launchers for the three commands. Right-click → *Send to* → *Desktop (create shortcut)* to get them on your desktop, then set a custom icon via *Properties → Change Icon* (see [`regenerate-icons.ps1`](regenerate-icons.ps1) to build `.ico` files from your own images).

## Usage

```bash
node toggle.cjs on       # start: sends a test message to your phone
node toggle.cjs status   # self-check
node toggle.cjs off      # stop: back to normal, local prompts restored
node toggle.cjs init     # first-time config; --force re-fills only empty fields
```

While away mode is on, approval messages look like this:

```
🔐 Claude Code remote approval
ID: abcde
Tool: Bash
Input: {"command":"npm test"}
——
Reply "ok abcde" to allow / "no abcde" to deny
```

Reply syntax:

| You send | Effect |
|---|---|
| `ok abcde` | Allow that operation |
| `no abcde` | Deny it; any text after the ID is passed to the model as a reason |
| `ok` / `no` | Works only when exactly one request is pending |
| `同意` / `拒绝` | Chinese equivalents of `ok` / `no` |

## Security design

This is a component that gates command execution, so its failure modes are the interesting part.

- **Fail closed.** Send failure, timeout, missing config, missing approver — all deny. "Can't reach you" never means "allow".
- **Only you can approve.** Messages are matched against your own `open_id`; anything from the bot or a third party is ignored. The ID is 5 random letters from a 24-letter alphabet (~8M combinations), and the chat only has two members.
- **One reply, one approval.** Each request runs as its own process, so an in-process "seen" set is worthless across processes. Consumption is gated by *exclusive file creation* (`flag: 'wx'`) — an atomic claim that guarantees a single reply can never be spent twice.
- **Arguments are truncated** to 600 chars before leaving your machine. Don't enable this for confidential projects.
- **No credentials.** The middleware never reads or stores Feishu tokens; every API call shells out to `lark-cli`, which manages its own auth under `~/.lark-cli/`.

## Known limitations

- **Fail open on crash or harness timeout.** If the hook process dies, or the harness-level timeout (10 min) is hit, the tool call falls through to Claude Code's normal local permission flow. This is deliberate — better a local prompt than an agent that hangs forever — but it does mean a crash is not a denial. Mitigated by keeping the middleware's own budget (300 s) well under the harness limit (600 s), so the *normal* timeout path is a real deny.
- **Feishu timestamps are minute-precision.** A reply sent in the same minute but *before* the request can, in rare cases, be matched to it. The one-reply-one-approval guarantee caps the worst case at a single extra approval.
- **Feishu/Lark only.** The transport is a `lark-cli` wrapper in [`lib/feishu.cjs`](lib/feishu.cjs); swapping in another chat platform means replacing that one file.

## Troubleshooting

Run `node toggle.cjs status` first — it checks the switch, Feishu identity, pending queue, required binaries, and whether the hook is still registered.

| Symptom | Cause / fix |
|---|---|
| No approval message on your phone | Feishu not logged in; or the bot has no conversation with you — send it any message from your phone once |
| `ok` sent but nothing happens | Missing/wrong ID while several requests are pending. Re-check the ID; bare `ok` only works with one pending request |
| `Claude Code hook entry missing` | Something rewrote `settings.json` (a Claude Code update, or another tool). Re-add step 4 |
| Everything times out while you're at your desk | Away mode is still on. `node toggle.cjs off` |

## Project layout

```
hook.cjs              PreToolUse entry point — the whole approval flow
toggle.cjs            on / off / status / init
lib/common.cjs        paths, config, logging, atomic writes, ID generation, reply parsing
lib/feishu.cjs        lark-cli wrapper (send, list, auth status)
config.example.json   config template — copied to config.json by init
regenerate-icons.ps1  build rounded, multi-size .ico files from your own images
*.bat                 double-click launchers for the three commands
```

~1000 lines of Node.js, zero third-party dependencies — deliberate, for a component that runs unattended in the background.

## License

MIT

---

# 中文说明

**Claude Code 手机远程审批中间件。** 你离开电脑时，Claude Code 的每一次工具调用都会推到手机飞书，你回一个字决定放行还是拦截。

## 它解决什么问题

AI 干活时经常停下来等人确认权限。人在电脑前点一下就行，人不在电脑前只有两个坏选择：让任务卡在那儿干等，或者干脆开「跳过权限」让 AI 无约束地改你的文件。这个中间件提供第三种：把人放进回路里，但把审批器搬到手机上。

## 安装

1. **装好 lark-cli 并授权**：`npm i -g @larksuite/cli`，然后 `lark-cli auth login --domain im --no-wait --json`，按提示在浏览器里完成授权
2. **生成配置**：`node toggle.cjs init` —— 会自动识别并填入你自己的飞书 open_id（只有你本人的回复算数）
3. **注册钩子**：把下面这段加进 `~/.claude/settings.json` 的 `hooks` 字段，**路径改成你的实际位置**：

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "shell": "powershell",
            "command": "node \"C:\\path\\to\\claude-approval\\hook.cjs\"",
            "timeout": 600,
            "statusMessage": "📱 等待手机远程审批…"
          }
        ]
      }
    ]
  }
}
```

`timeout` 必须大于 `waitTimeoutSec`（默认 300 秒）—— 钩子被框架超时打断的语义是「放行」，所以中间件自己掐一个更短的预算，到点主动拒绝。

4. **重启 Claude Code 会话**让钩子生效。

## 日常怎么用

出门前 `node toggle.cjs on`（或双击「开启远程审批.bat」），会收到一条测试消息，收到就说明通道正常。回来后 `node toggle.cjs off`。

手机上收到审批请求时回复：

| 回复 | 效果 |
|---|---|
| `ok abcde` | 同意执行 |
| `no abcde` | 拒绝，编号后面的文字会作为理由告诉 AI |
| `ok` / `no` | 只在同时只有一条待审批时有效 |
| `同意` / `拒绝` | 中文写法同样支持 |

拿不准状态就双击「查看审批状态.bat」。

## 安全设计

- **失败关闭**：发不出去、超时、配置缺失，一律拒绝。绝不因为「联系不上你」就默认同意。
- **只有你能审批**：只认你本人飞书账号发的消息，机器人发的、别人发的一律忽略。
- **一条回复只放行一个操作**：每条审批是独立进程，靠「独占创建文件」做原子认领，杜绝「回一个 ok 连续放行好几个操作」。
- **参数截断到 600 字符**才发出去。涉密项目建议不要开启。
- **不碰你的令牌**：所有飞书操作都通过 lark-cli 完成，本中间件不读取、不存储任何登录凭证。

## 已知局限

- **进程崩溃或钩子被框架超时会失败放行**，退回本机正常权限流程。这是有意为之：宁可退回本机弹窗，也不让 AI 彻底卡死。正常超时（300 秒）则是真拒绝。
- **飞书消息时间只精确到分钟**，极端情况下存在极小概率的误判；「一条回复只用一次」的保护把最坏影响限制在多放行一次。
- **只支持飞书**。换平台只需替换 `lib/feishu.cjs` 这一个文件。

## 排障

先跑 `node toggle.cjs status` —— 它会检查开关、飞书身份、待审批积压、依赖是否齐全、钩子是否还在。

| 现象 | 原因 / 处理 |
|---|---|
| 手机收不到审批消息 | 飞书未登录；或机器人跟你还没有会话 —— 在手机上给它随便发一条消息即可 |
| 回了 ok 但 AI 没反应 | 多条待审批时回复必须带编号；不带编号的 ok/no 不会被采纳 |
| 提示「钩子入口缺失」 | `settings.json` 被别的程序重写了，按上面第 3 步重新加回钩子条目 |
| 人在电脑前却一直超时 | 离开模式还开着，执行 `node toggle.cjs off` |

## 许可

MIT
