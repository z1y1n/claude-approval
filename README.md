# claude-approval

**Approve Claude Code's tool calls from your phone.**

A small, zero-dependency [Claude Code](https://claude.com/claude-code) `PreToolUse` hook that pushes every tool call to your phone via Feishu (Lark) and blocks until you answer — one tap on **✅ Allow / ⛔ Deny**, or a one-character reply. Walk away from the keyboard without either stalling the agent or handing it unrestricted access to your files.

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
  send a card to Feishu as the bot
        │
        │   your phone:  🔐 Claude Code needs your approval
        │                ⚡ Run command: npm test
        │                [ ✅ Allow ]  [ ⛔ Deny ]
        │                     │
        │                     └── tap ──► card.action.trigger  (WebSocket, no public URL)
        │                                    │
        │                                    ▼
        │                          button-daemon.cjs (background)
        │                          verifies the clicker is you,
        │                          then atomically writes
        │                          runtime/decisions/<id>.json
        │                                    │
        ▼                                    │
  poll every 3 s: that file first, then the chat  ◄──┘
        │                                    ▲
        │                                    └── or reply  "1 abcde" / "0 abcde"
        │
        ├─ allow                     ► allow (no local prompt) + cached for 10 min
        ├─ deny                      ► deny  (exit 2, reason is shown to the model)
        └─ 5 min with no reply       ► deny  (timeout)
```

The `allow` decision matters more than it looks: returning it from the hook makes Claude Code **skip its local permission dialog**, which is exactly what stops the agent from freezing on a prompt nobody is there to click.

## Features

| Feature | What it does | Tunable |
|---|---|---|
| **Remote approval** | A readable summary of what Claude wants to do lands on your phone with a 5-letter ID — `⚡ Run command: npm test`, `✏️ Edit file: …\Desktop\resume.md`, `📖 Read file: …\notes.md`. | `friendlyMessages`, `waitTimeoutSec` |
| **Approve in one tap** | The message is an interactive card with **✅ Allow / ⛔ Deny** buttons. One tap is all it takes. | `useCardButtons` |
| **Short replies** | `1` allows, `0` denies — with or without the ID. `ok` / `no` / `同意` / `拒绝` still work exactly as before. | — |
| **Approval cache** | The identical operation, once approved, is auto-allowed for 10 minutes — so reading the same file ten times asks once. | `cacheTtlMin` |
| **Read-only exemption** | Tools that cannot change anything (`Read`, `Glob`, `Grep`, …) pass straight through, otherwise your phone drowns in noise. | `exemptTools` |
| **Timeout = deny** | No reply within 5 minutes rejects the operation. Failing to reach you never means "yes". | `waitTimeoutSec` |
| **One-command toggle** | `on` / `off` / `status`, plus optional desktop shortcuts. When off, overhead is a single `existsSync` call. | — |
| **Self-check** | Verifies Feishu identity, button-channel health, that the hook is still registered, and whether requests are piling up. | — |
| **Guided setup** | `init` generates your config and fills in your own Feishu `open_id` automatically. | — |

### Readable, but never vague

Friendly wording only ever *translates the label* — it never hides what is actually being run.

```
🔐 Claude Code needs your approval

⚡ Run command: npm test
```

The command itself is always shown **verbatim**, for exactly the reason this middleware exists: you are supposed to be able to see what the AI is about to do. A euphemism that obscures the real operation would defeat the whole point. Set `"friendlyMessages": false` to go back to raw JSON if you prefer.

Operations that look destructive (`rm -rf`, `git push --force`, `format`, `drop table`, …) get a red header and an explicit warning, so a dangerous command never looks like a routine one.

## Requirements

- **Node.js 18+** (uses only built-in modules — no `npm install`)
- **Claude Code**
- **[lark-cli](https://www.npmjs.com/package/@larksuite/cli)** with a bound Feishu app and an authorized account (steps 2 below)
- A Feishu / Lark account (the free personal tier is enough)

## Install

**1. Clone**

```bash
git clone https://github.com/<you>/claude-approval.git
cd claude-approval
```

**2. Set up the Feishu CLI** (skip if you already use `lark-cli`)

```bash
npm i -g @larksuite/cli
lark-cli config init --new     # create and bind a Feishu app — follow the browser flow
lark-cli auth login --domain im --no-wait --json
```

Open the URL it prints, approve, then re-run the last command without `--no-wait`.

> **Why do I need an app?** Approval requests are sent *as a bot*, so the CLI needs a bound Feishu custom app that is allowed to send messages. `lark-cli config init --new` creates one and walks you through it.
>
> Doing it by hand instead: Feishu developer console → **创建企业自建应用** → enable the **bot** capability → add the *send messages* permission (`im:message`) → publish → `lark-cli config init --app-id <id> --app-secret-stdin`. Reading replies *as you* additionally needs `im:message:readonly`.

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

**5. One-time: subscribe the button callback** (only needed for the ✅ / ⛔ buttons)

```bash
node toggle.cjs status
```

If the button channel reports that the callback isn't subscribed, it prints a one-click link:

```
  ✗ 飞书开发者后台还没订阅「卡片按钮回调」← 点了按钮不会有反应
    处理：打开下面这个链接确认订阅（一次性，之后永久生效）
    https://open.feishu.cn/page/launcher?clientID=...
```

Open it and confirm. That's it — the subscription is permanent.

> **Skipping this is fine.** Everything still works: approval messages fall back to plain text and you reply `1` / `0`. The card buttons simply won't respond until you subscribe.
>
> **Why is this needed?** Sending a card only needs the *send messages* permission you already granted. *Reacting* to a button click is a callback, and Feishu requires each app to opt into callbacks explicitly. No public URL is involved — `lark-cli` holds a WebSocket long connection to Feishu from your own machine.

**6. Optional — desktop shortcuts**

`开启远程审批.bat` / `关闭远程审批.bat` / `查看审批状态.bat` are double-click launchers for the three commands. Right-click → *Send to* → *Desktop (create shortcut)* to get them on your desktop, then set a custom icon via *Properties → Change Icon* (see [`regenerate-icons.ps1`](regenerate-icons.ps1) to build `.ico` files from your own images).

## Usage

```bash
node toggle.cjs on       # start: sends a test card to your phone
node toggle.cjs status   # self-check (incl. button channel)
node toggle.cjs off      # stop: back to normal, local prompts restored
node toggle.cjs init     # first-time config; --force re-fills only empty fields
```

While away mode is on, approval messages arrive as a card:

```
🔐 Claude Code needs your approval

⚡ Run command: npm test

────────────────────────────────
ID abcde · auto-denies in 5 min
You can also reply 1 / 0
[ ✅ Allow ]      [ ⛔ Deny ]
```

Tap a button, or reply. Both channels stay valid at all times.

Reply syntax:

| You send | Effect |
|---|---|
| `1` | Allow — when exactly one request is pending |
| `0` | Deny it |
| `1 abcde` | Allow that specific request (use this when several are pending) |
| `0 abcde` | Deny it; text after the ID is passed to the model as a reason |
| `ok abcde` / `no abcde` | The original spelling — still works |
| `同意` / `拒绝` | Chinese equivalents |

Bare `1` / `0` must stand alone or be followed by a separator: `1` and `1 ok` are approvals, `1月去实习` is not (it is matched as ordinary text and ignored, rather than silently approving something you never meant).

`on` also sends a one-off test card. Tapping its buttons confirms the channel works end to end; it approves nothing.

## Security design

This is a component that gates command execution, so its failure modes are the interesting part.

- **Fail closed.** Send failure, timeout, missing config, missing approver — all deny. "Can't reach you" never means "allow".
- **Only you can approve.** Messages are matched against your own `open_id`. On the button channel, every click carries the clicker's `operator_id`, which is checked the same way — a card forwarded to someone else gets them nowhere. The ID is 5 random letters from a 24-letter alphabet (~8M combinations), and the chat only has two members.
- **One reply, one approval.** Each request runs as its own process, so an in-process "seen" set is worthless across processes. Consumption is gated by *exclusive file creation* (`flag: 'wx'`) — an atomic claim that guarantees a single reply can never be spent twice. The same primitive backs the button channel: one tap writes one decision file, and a second tap — even a contradictory one — cannot rewrite it.
- **The approval decision never leaves the hook.** The background daemon that receives button clicks cannot allow anything. Its whole job is to atomically drop a small JSON file; `hook.cjs` is the only thing that reads it, and the only thing that ever emits `allow`. If that daemon misbehaved, the worst it could do is write a file nobody reads — not bypass an approval.
- **Stale IDs are never recycled.** An old card stays clickable for as long as its update token lives (30 min), so ID generation skips recently-used IDs, not just currently-pending ones. A resurrected card cannot be mis-matched to a fresh request.
- **Arguments are truncated** to 600 chars before leaving your machine. Don't enable this for confidential projects.
- **No credentials.** The middleware never reads or stores Feishu tokens; every API call shells out to `lark-cli`, which manages its own auth under `~/.lark-cli/`.

## Known limitations

- **Fail open on crash or harness timeout.** If the hook process dies, or the harness-level timeout (10 min) is hit, the tool call falls through to Claude Code's normal local permission flow. This is deliberate — better a local prompt than an agent that hangs forever — but it does mean a crash is not a denial. Mitigated by keeping the middleware's own budget (300 s) well under the harness limit (600 s), so the *normal* timeout path is a real deny.
- **Buttons need a one-time console subscription** (step 5) and the background daemon running. Without either, the hook sends plain text instead — daemon health (including heartbeat freshness) is checked before every send, so you never get an unclickable card with no explanation. `status` tells you which mode you are in. If the daemon dies while away mode is still on, just run `on` again — it notices the dead daemon and restarts it instead of reporting "already on".
- **Feishu timestamps are minute-precision.** A reply sent in the same minute but *before* the request can, in rare cases, be matched to it. The one-reply-one-approval guarantee caps the worst case at a single extra approval.
- **Feishu/Lark only.** The transport is a `lark-cli` wrapper in [`lib/feishu.cjs`](lib/feishu.cjs); swapping in another chat platform means replacing that one file.

## Troubleshooting

Run `node toggle.cjs status` first — it checks the switch, Feishu identity, button-channel health, pending queue, required binaries, and whether the hook is still registered.

| Symptom | Cause / fix |
|---|---|
| No approval message on your phone | Feishu not logged in; or the bot has no conversation with you — send it any message from your phone once |
| Buttons do nothing when tapped | The callback isn't subscribed (step 5), or the daemon isn't running. `status` reports both and prints the subscription link. If the daemon is dead, run `on` again — it restarts it |
| `1` sent but nothing happens | Missing/wrong ID while several requests are pending. Bare `1` only works with one pending request |
| `Claude Code hook entry missing` | Something rewrote `settings.json` (a Claude Code update, or another tool). Re-add step 4 |
| Everything times out while you're at your desk | Away mode is still on. `node toggle.cjs off` |

## Project layout

```
hook.cjs               PreToolUse entry point — the whole approval flow
toggle.cjs             on / off / status / init
lib/common.cjs         paths, config, logging, atomic writes, ID generation, reply parsing
lib/describe.cjs       turns a tool call into a readable one-line summary
lib/card.cjs           builds the Feishu cards (approval / result / test)
lib/button-daemon.cjs  background listener for card button clicks
lib/feishu.cjs         lark-cli wrapper (send, list, card update, auth status)
config.example.json    config template — copied to config.json by init
regenerate-icons.ps1   build rounded, multi-size .ico files from your own images
*.bat                  double-click launchers for the three commands
```

~2000 lines of Node.js, zero third-party dependencies — deliberate, for a component that runs unattended in the background.

## License

MIT

---

# 中文说明

**Claude Code 手机远程审批中间件。** 你离开电脑时，Claude Code 的每一次工具调用都会推到手机飞书，点一下按钮、或回一个字，决定放行还是拦截。

## 它解决什么问题

AI 干活时经常停下来等人确认权限。人在电脑前点一下就行，人不在电脑前只有两个坏选择：让任务卡在那儿干等，或者干脆开「跳过权限」让 AI 无约束地改你的文件。这个中间件提供第三种：把人放进回路里，但把审批器搬到手机上。

## 安装

1. **装好 lark-cli，并绑定一个飞书应用**：
   ```bash
   npm i -g @larksuite/cli
   lark-cli config init --new     # 在浏览器里创建并绑定一个飞书应用
   lark-cli auth login --domain im --no-wait --json
   ```
   打开它打印的链接完成授权，然后去掉 `--no-wait` 再跑一次最后那条命令。

   > **为什么需要创建应用？** 审批消息是以「机器人身份」发出的，所以必须有一个已绑定、且被允许发消息的飞书自建应用。`lark-cli config init --new` 会帮你创建并引导开通权限。
   >
   > 想手工创建：飞书开发者后台 → 创建企业自建应用 → 开启「机器人」能力 → 添加「发送消息」权限（`im:message`）→ 发布 → `lark-cli config init --app-id <id> --app-secret-stdin`。你自己读取回复还需要 `im:message:readonly`。

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
5. **一次性开通卡片按钮回调**（只有想用 ✅ / ⛔ 按钮才需要）：

   ```bash
   node toggle.cjs status
   ```

   如果按钮通道提示还没订阅，它会直接打印一个一键订阅链接：

   ```
     ✗ 飞书开发者后台还没订阅「卡片按钮回调」← 点了按钮不会有反应
       处理：打开下面这个链接确认订阅（一次性，之后永久生效）
       https://open.feishu.cn/page/launcher?clientID=...
   ```

   点开确认即可，订阅是永久的。

   > **不开通也完全能用**：审批消息会退回纯文字，回复 `1` / `0` 一样审批。只是卡片上的按钮暂时点不动。
   >
   > **为什么需要这一步？** 发卡片只用你已有的「发消息」权限。而*响应*按钮点击属于回调，飞书要求每个应用显式开通。全程不需要公网地址 —— lark-cli 从你自己电脑上跟飞书保持一条 WebSocket 长连接。

## 日常怎么用

出门前 `node toggle.cjs on`（或双击「开启远程审批.bat」），会收到一张测试卡片。点一下卡片上的按钮确认通道正常，然后就可以放心走了。回来后 `node toggle.cjs off`。

手机上收到的审批请求长这样：

```
🔐 Claude Code 需要你批准

⚡ 执行命令：npm test

────────────────────────────────
编号 abcde · 5 分钟不回复自动拒绝
也可以直接回复 1 / 0
[ ✅ 同意 ]      [ ⛔ 拒绝 ]
```

点按钮或者回一个字都行，两条通道随时都有效。

| 回复 | 效果 |
|---|---|
| `1` | 同意 —— 同时只有一条待审批时用 |
| `0` | 拒绝 |
| `1 abcde` | 同意指定编号的那条（有多条待审批时用这个） |
| `0 abcde` | 拒绝，编号后面的文字会作为理由告诉 AI |
| `ok abcde` / `no abcde` | 老写法，照样有效 |
| `同意` / `拒绝` | 中文写法同样支持 |

不带编号的 `1` / `0` 必须单独出现、或后面跟分隔符才算数：`1`、`1 ok` 是同意，`1月去实习` 不是（它会被当成普通聊天忽略掉，而不是悄悄批准一个你根本没打算批准的操作）。

### 翻译成人话，但不打马虎眼

友好文案只做「翻译」，绝不隐藏真实内容。跑命令时**命令原文永远原样显示**——这道闸门的意义就是让你看清 AI 到底要干什么，用委婉说法把真实操作盖住等于把闸门拆了。想把文案换回原始 JSON，把 `friendlyMessages` 设成 `false` 即可。

看起来有破坏性的操作（`rm -rf`、`git push --force`、`format`、`drop table` 等）会用红色表头并额外警示，危险命令不会长得像日常操作。

## 安全设计

- **失败关闭**：发不出去、超时、配置缺失，一律拒绝。绝不因为「联系不上你」就默认同意。
- **只有你能审批**：只认你本人的飞书账号。按钮通道上每次点击都带着点击者的 `operator_id`，同样会校验 —— 卡片被转发给别人也没用。
- **一条回复只放行一个操作**：每条审批是独立进程，靠「独占创建文件」做原子认领，杜绝「回一个 ok 连续放行好几个操作」。按钮通道用的是同一套原语：一次点击落一个决策文件，再点一次（哪怕点的是相反的按钮）也改不了它。
- **放行决策不离开钩子**：接收点击的后台守护进程没有放行能力。它唯一的职责是原子地写一个小 JSON 文件；只有 `hook.cjs` 会读它，也只有 `hook.cjs` 会输出 allow。守护进程就算行为异常，最坏也只是写了个没人读的文件，而不是绕过审批。
- **旧编号不会被回收**：旧卡片在令牌有效期内（30 分钟）仍可点击，所以编号生成会避开「最近用过的」，不只是「当前待审批的」。一张「复活」的旧卡片不会被误配到新请求上。
- **参数截断到 600 字符**才发出去。涉密项目建议不要开启。
- **不碰你的令牌**：所有飞书操作都通过 lark-cli 完成，本中间件不读取、不存储任何登录凭证。

## 已知局限

- **进程崩溃或钩子被框架超时会失败放行**，退回本机正常权限流程。这是有意为之：宁可退回本机弹窗，也不让 AI 彻底卡死。正常超时（300 秒）则是真拒绝。
- **按钮需要一次性开通后台订阅**（第 5 步）**且守护进程在跑**。两者缺任一，钩子会自动改发纯文字 —— 每次发送前都会检查守护进程健康度（含心跳是否新鲜），不会出现「发了张点不动的卡片还不告诉你为什么」。`status` 会告诉你当前处于哪种模式。守护进程万一在开关还开着的时候死了，再执行一次 `on` 即可 —— 它会发现并重新拉起，而不是只说一句「已处于开启状态」。
- **飞书消息时间只精确到分钟**，极端情况下存在极小概率的误判；「一条回复只用一次」的保护把最坏影响限制在多放行一次。
- **只支持飞书**。换平台只需替换 `lib/feishu.cjs` 这一个文件。

## 排障

先跑 `node toggle.cjs status` —— 它会检查开关、飞书身份、按钮通道健康度、待审批积压、依赖是否齐全、钩子是否还在。

| 现象 | 原因 / 处理 |
|---|---|
| 手机收不到审批消息 | 飞书未登录；或机器人跟你还没有会话 —— 在手机上给它随便发一条消息即可 |
| 点按钮没反应 | 回调没订阅（第 5 步）或守护进程没在跑。`status` 会分别报出来，并给出订阅链接；若只是守护进程死了，再执行一次 `on` 即可自动重启 |
| 回了 1 但 AI 没反应 | 多条待审批时回复必须带编号；不带编号的 1/0 不会被采纳 |
| 提示「钩子入口缺失」 | `settings.json` 被别的程序重写了，按上面第 3 步重新加回钩子条目 |
| 人在电脑前却一直超时 | 离开模式还开着，执行 `node toggle.cjs off` |

## 许可

MIT
