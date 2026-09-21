# Browser MCP Bridge

把你**已经打开、已经登录**的 Chrome 标签页，通过一条 WebSocket 交给本地的中转服务，
让 AI 客户端（Claude Code 等）能读页面、点按钮、填表单、抓接口。

```
AI 客户端 ──MCP / HTTP──> node 中转服务 ──WebSocket──> Chrome 插件 ──CDP / scripting──> 你的页面
                          127.0.0.1:8777            ws://127.0.0.1:8777/bridge
```

**这个项目不负责"打开浏览器"。** 它接管的是你当前真实的浏览器会话 —— 该登录的已经登录、
该过的验证码已经过了。这正是它相对 Playwright 那类无头方案的价值：不需要重新造一份登录态。

反过来说，它也**不是爬虫**：没有后台批量抓取，所有动作都发生在你眼前这个浏览器里，
并且每一次操作都会写进审计日志（见 [审计](#审计每次操作都有记录)）。

---

## 目录

- [仓库结构](#仓库结构)
- [安装](#安装)
- [第一次连上](#第一次连上)
- [popup 面板](#popup-面板)
- [日常用法：三步主线](#日常用法三步主线)
- [命令速查](#命令速查)
- [关于「正在被调试」横幅](#关于正在被调试横幅)
- [权限说明](#权限说明)
- [连接是怎么维持的](#连接是怎么维持的)
- [故障排查](#故障排查)
- [错误码](#错误码)
- [改了插件代码之后](#改了插件代码之后)
- [相关文件](#相关文件)

---

## 仓库结构

三个包，pnpm workspace 管理：

| 包 | 作用 |
|---|---|
| `packages/server` | node 中转服务：WebSocket 桥 + MCP HTTP 端点 + `bx` 命令行 |
| `packages/extension` | Chrome MV3 插件，真正动你浏览器的那一端 |
| `packages/shared` | 两端共用的协议与动作定义 —— `ACTIONS` 是全仓库的单一真相源 |

服务端自己不懂浏览器，插件自己不懂 MCP，中间靠 `shared` 里的动作注册表把两边钉在一起。

常用命令：`pnpm build`（三个包）、`pnpm check`（lint + 类型 + 测试，提交前跑）、
`pnpm --filter @browser-mcp/server smoke`（不开 Chrome 跑通整条链路）。

---

## 安装

要求 **Chrome 116 或更新**（`manifest.json` 里的 `minimum_chrome_version`）。

### 1. 构建产物

插件是 TypeScript 写的，必须先构建出 `dist/`：

```bash
pnpm install
pnpm build          # 三个包一起构建，shared 会先于 extension
```

需要 **Node 22.18+ 或 24**（服务端直接执行 `.ts`，不预编译）和 **pnpm**。

产物在 `packages/extension/dist/`，包含 `background.js` / `popup.js`（打包产物）
和 `manifest.json` / `popup.html`（从 `public/` 原样拷过去的）。

> 只改了 `packages/shared` 的话也必须重新 `pnpm build` —— 插件引用的是 shared 的 **dist**，
> 不是源码，不重新构建它看到的还是旧的。

### 2. 加载到 Chrome

1. 地址栏打开 `chrome://extensions`
2. 右上角打开「**开发者模式**」
3. 点「**加载已解压的扩展程序**」
4. 选中 `packages/extension/dist` 目录（**是 `dist`，不是 `packages/extension`**）

加载成功后工具栏会出现插件图标，图标上带一个徽标显示连接状态。

> 图标目前是 Chrome 默认的拼图块 —— 还没做图标资源，不影响使用。
> 建议把它**固定到工具栏**（点工具栏的拼图图标 → 图钉），否则看不到状态徽标。

### 3. 装上 `bx` 命令行（可选但推荐）

日常操作走 `bx`，不用手写 MCP 调用：

```bash
cd packages/server && pnpm link --global
bx --help
```

---

## 第一次连上

中转服务没起来的时候，插件会一直处于「未连接」并按退避重试。把服务起来即可：

**方式 A：什么都不用做（推荐）**

直接跑任意一条 `bx` 命令。首次调用会自动 `spawn` 守护进程，
然后**最多等 20 秒**让插件连上来：

```bash
bx status
```

等这么久是因为插件此时多半正处在重连退避中（退避上限 30 秒）。实测等 9 秒不够，
会误报「插件未连接」。

**方式 B：自己起服务**

```bash
pnpm --filter @browser-mcp/server start
```

**确认连上了**：徽标变成绿色 `ON`，或者

```bash
curl -s http://127.0.0.1:8777/healthz     # bridge.connected 应为 true
bx status                                  # 守护进程 + 插件连接状态
```

### 徽标状态

| 徽标 | 颜色 | 含义 |
|---|---|---|
| `ON` | 绿 | 已连上中转服务，可以用了 |
| `···` | 黄 | 正在连接 |
| `OFF` | 红 | 未连接，正在按退避重试 |

徽标是你**唯一**能一眼看到的连接状态。鼠标悬停图标有对应的文字提示。

---

## popup 面板

点插件图标打开，四样东西：

| 元素 | 说明 |
|---|---|
| **状态圆点 + 文字** | 实时反映连接状态（已连接 / 连接中… / 未连接），由后台写进 session storage，变化会立刻刷新 |
| **服务地址** | 默认 `ws://127.0.0.1:8777/bridge`。改了中转服务的 `BRIDGE_HOST` / `BRIDGE_PORT` 才需要动它。留空则回落到默认值 |
| **令牌（可选）** | 对应服务端的 `BRIDGE_TOKEN`。服务端没设就留空。WebSocket 构造器不支持自定义请求头，令牌会自动挂到 URL 的 `?token=` 上 |
| **保存并重连** | 写入设置并**立刻**重连（清零退避，不用等 30 秒）。连接卡住时点它就是手动重连按钮 |
| **诊断日志** | 折叠区，点开是最近 40 条事件。`pre` 区域设了 `user-select: all`，点一下即可全选复制 |

**诊断日志为什么直接读 storage、不走桥**：需要看日志的时候恰恰是连不上的时候，
走中转服务读日志是死循环。它写在 `storage.local`（而不是 session 或内存），
因为要诊断的正是「service worker 被回收之后发生了什么」—— 任何随 SW 消失的记录方式都看不到那段。

日志里的事件名含义：

| 事件 | 含义 |
|---|---|
| `sw_start` | service worker 被拉起（每次都会重建连接） |
| `ws_open` / `ws_close` / `ws_error` | WebSocket 生命周期 |
| `reconnect_scheduled` | 已排好第 N 次重连，多少毫秒后 |
| `alarm_created` / `alarm_fire` | 兜底闹钟的创建与触发（每分钟一次） |
| `ensure_check` | 闹钟触发时的**体检依据**：`readyState=1 idle=20s` 这种 |
| `stale_detected` | 判定连接是半开的（超过 60 秒没收到任何字节） |
| `manual_restart` | 你点了「保存并重连」 |

`ensure_check` 记的是「看到了什么」而不是「做了什么」—— 排查后台间歇性问题时，
这一条往往是唯一能定位到分支的线索。

---

## 日常用法：三步主线

插件本身没有操作界面，用法全在 `bx`（或 MCP 工具）那一侧。主线永远是这三步：

```bash
# 1. 看看有哪些标签页
bx tabs
#   1836310593  *   GitHub · gogocrow/mcp-browser              https://github.com/...
#   1836310612      爱快路由 - 控制台                            http://192.168.1.1/...

# 2. 选定后续操作的目标（注意：只是选定，不会把页面切到前台）
bx select 1836310612

# 3. 之后所有页面操作都省略 tabId，自动落在选中的那个页面上
bx snapshot
bx click e12
bx text
```

标记：`*` = 当前活动标签页，`>` = 已选中的目标。

几条要知道的规则：

- **省略 `--tab` 时的解释顺序是：选中的页面 → 当前活动标签页。** 一个都没有才报错。
- **显式的 `--tab <id>` 永远优先于选中状态** —— 想临时看一眼别的页面不该被选中劫持。
- **只有动作成功才记住选中**。`bx select` 会真的往插件走一趟确认标签页存在，失败时保持原选中不变。
- **插件一断开，选中就被清空**。标签页 id 只在一次浏览器会话内有效，浏览器重启后同一个 id
  很可能指向完全不同的页面，留着旧值会让后续操作静默打到错误的页面上。
- `bx select` **不切前台**，切前台是 `bx activate <tabId>`。

### 操作页面：优先用 ref，不要猜 CSS 选择器

```bash
bx snapshot
```

输出是 Chrome **真实的无障碍树**（不是自己近似算的 role/name），每个可交互节点带 `[ref=eN]`：

```
button "保存" [ref=e7]
textbox "用户名" [ref=e8]
link "退出登录" [ref=e9]

12 个可操作元素（滤掉 26 个不可见）
```

然后直接拿 ref 操作：

```bash
bx fill e8 admin
bx click e7
```

**ref 比 CSS 选择器可靠得多**：它直接指向 DOM 节点，不受 class 名变化、同名元素、
动态重排影响。ref 表每次快照**整表覆盖**，页面变动后用旧 ref 会报 `ERR_STALE_REF` ——
这时重新 `bx snapshot` 即可，不要试图猜。

两个刻意的行为：

- **快照只收看得见的元素。** 实测某路由后台 45 个可交互元素里 21 个是 `opacity: 0`
  却照样进无障碍树 —— 不过滤的话你会拿到一半幽灵 ref，只能挨个点着试。
- **快照默认只给可操作元素**，不含表格、段落这类结构节点。要结构加 `--structure`，
  但体积可能翻倍。**读内容请用 `bx text`，不要用 snapshot** —— 表格密集的页面上
  未过滤的快照会比整页纯文本还大。

### 抓接口

```bash
bx net start            # 先开录制
# …在页面上触发操作…
bx net list --api       # 列出请求，拿 requestId
bx net body <requestId> # 取请求体 + 响应体，可 --offset 分页、--headers 带上头
bx net stop
```

- **必须先 `start` 再触发操作** —— 录制前发生的请求抓不到。
- **响应体是浏览器临时保留的**，页面导航或缓冲区淘汰（上限 1000 条）之后
  `net body` 就取不到正文了，这不是 bug；此时摘要信息仍在，`net list` 还查得到。
- 录制有开销，用完记得 `net stop`。

---

## 命令速查

完整的以 `bx --help` 为准（会随版本变化），当前这批是：

| 分类 | 命令 | 说明 |
|---|---|---|
| 标签页 | `bx tabs` | 列出标签页（`*` 活动，`>` 选中） |
| | `bx select <tabId>` | 选定目标，不切前台 |
| | `bx activate <tabId>` | 切到前台并聚焦窗口 |
| 读取 | `bx snapshot [--structure]` | 语义快照，带 `[ref]` |
| | `bx text [--css <选择器>]` | 读可见正文（默认截断 2000 字符） |
| | `bx query <选择器>` | 按选择器列出匹配元素 |
| 操作 | `bx click <ref>` / `--css <选择器>` | 点击 |
| | `bx fill <ref> <值>` / `--css <选择器>` | 填输入框 |
| | `bx nav <url>` | 导航并等待加载完成 |
| | `bx eval <表达式>` | 在页面里求值 |
| 网络 | `bx net start\|list\|body\|stop` | 见上一节 |
| 其他 | `bx status` | 守护进程与插件连接状态 |
| | `bx history [--errors]` | 操作审计记录 |
| | `bx daemon status\|stop` | 管理守护进程（平时不用） |

全局选项：`--json`（输出 JSON）、`--tab <id>`（临时覆盖选中）、`--max <n>`（截断上限，`0` 不截断）。

> **截断警告一律走 stderr。** stdout 常被 `grep` 吃掉，而"你看到的是残缺内容"这件事必须还能看见。

### 不用 `bx`，直接接 MCP

中转服务同时是一个 **Streamable HTTP** 形态的 MCP server，端点固定是
`http://127.0.0.1:8777/mcp`。下面各家客户端接的都是这一个端点，只是写法不同。

> 先跑起来再接：客户端连的是守护进程，服务没起就会连不上。`bx status` 会把它拉起来。

**Claude Code**

```bash
claude mcp add --transport http browser http://127.0.0.1:8777/mcp
# 设了 BRIDGE_TOKEN 时：
claude mcp add --transport http browser http://127.0.0.1:8777/mcp --header "Authorization: Bearer <token>"
```

**Codex CLI**

```bash
codex mcp add browser --url http://127.0.0.1:8777/mcp
# 设了 BRIDGE_TOKEN 时（给的是环境变量名，不是令牌本身）：
export BRIDGE_TOKEN=<token>
codex mcp add browser --url http://127.0.0.1:8777/mcp --bearer-token-env-var BRIDGE_TOKEN
```

等价于往 `~/.codex/config.toml` 里写：

```toml
[mcp_servers.browser]
url = "http://127.0.0.1:8777/mcp"
bearer_token_env_var = "BRIDGE_TOKEN"   # 没设令牌就删掉这行
```

会话里 `/mcp` 可以确认连上了没有。

**Qoder CLI**

```bash
qoder mcp add -t http -s user browser http://127.0.0.1:8777/mcp
qoder mcp list       # 确认加上了
# 已经开着会话的话：/mcp reload
```

`-s user` 写进 `~/.qoder/settings.json`（跨项目可用），默认的 `-s local` 只对当前项目生效。
设了 `BRIDGE_TOKEN` 时 CLI 没有对应参数，直接改那个文件补 `headers`：

```json
{
  "mcpServers": {
    "browser": {
      "type": "http",
      "url": "http://127.0.0.1:8777/mcp",
      "headers": { "Authorization": "Bearer <token>" }
    }
  }
}
```

**Qoder IDE**

设置（`⌘⇧,` / `Ctrl+Shift+,`）→ 左栏 **MCP** → 「我的服务」→ 右上角 **+ 添加**，
把上面那段 JSON 粘进去导入即可（没设令牌就去掉 `headers`）。

---

注意这些接法都会把当前 **17 个工具**的 schema **常驻上下文**：实测
name + description + inputSchema 共 7,606 字符，客户端若同时展开 outputSchema 则约 17k 字符。
日常用 `bx` + skill 的方式更省 —— skill 只在触发时加载，`bx --help` 按需取。

---

## 关于「正在被调试」横幅

用到下面这些能力时，插件会 `chrome.debugger.attach` 到目标标签页，
该标签页顶部会常驻一条 **「XX 正在调试此浏览器」** 的黄色横幅：

| 动作 | 是否需要调试器 |
|---|---|
| `snapshot` | **是**（`Accessibility.getFullAXTree`） |
| `click` | **是**（用真实鼠标事件，见下） |
| `fill <ref>` | **是**（`fill --css` 不需要） |
| `net *` | **是** |
| `text` / `query` / `eval` / `nav` | 否（走 `chrome.scripting`） |

**这个代价是刻意接受的，不要指望去掉横幅。** 用真实无障碍树而不是自己在页面里近似算
role/name，是快照可靠性的前提。

两个相关行为：

- **附加后不主动断开**，只在标签页关闭时清理。频繁 attach/detach 会让横幅不停闪。
- **你点横幅上的「取消」是安全的** —— 插件监听 `onDetach`，会同步清掉内部状态，
  下次操作时重新附加。

如果 Chrome DevTools 已经开在同一个标签页上，附加可能失败并报 `ERR_DEBUGGER_UNAVAILABLE`
（一个标签页同时只能有一个调试器）。关掉 DevTools 再试。

### 为什么点击用坐标而不是 `element.click()`

点击走的是「滚动到可见 → 取元素中心坐标 → 派发真实鼠标事件」，并且点击前会做命中检测。

原因是实测踩过的坑：无障碍树会把整张卡片折叠成一个 `button` 节点，但它关联的 DOM 节点
可能是**外层包裹 div**，而点击处理器挂在其**子元素**上（antd / element / MUI 极常见）。
`element.click()` 的事件 target 就是那个包裹 div，只会向上冒泡、永远到不了子元素 ——
表现为"接口返回成功、页面毫无反应"，是最难查的一类失败。

命中检测不通过会报 `ERR_ELEMENT_COVERED` 并说明原因（元素在视口外 / 被谁盖住），
而不是静默地"点成功了"。

### 为什么填值能被 React / Vue 收到

React/Vue 会劫持 `value` 的 setter 来跟踪状态，直接赋值它们收不到变更。
填值走的是原型链上的**原生 setter**，再补派发 `input` / `change` 事件，受控组件才认。

---

## 权限说明

`manifest.json` 申请的权限都是必需的：

| 权限 | 用途 | 不给会怎样 |
|---|---|---|
| `tabs` | 列举标签页、读 url/标题、切前台 | `bx tabs` / `select` / `activate` 全废 |
| `scripting` | 注入函数读正文、查选择器、求值 | `text` / `query` / `eval` / `fill --css` 全废 |
| `debugger` | CDP：无障碍树、真实鼠标事件、网络监听 | `snapshot` / `click` / `net` 全废 |
| `storage` | 存服务地址与令牌（local）、连接状态（session）、ref 表、诊断日志 | 设置存不住，每次重启都要重填 |
| `alarms` | 每分钟唤醒 SW 做连接体检 | SW 被回收后可能再也不重连 |
| `<all_urls>` | 要操作的就是"用户已经打开的任意页面" | 只能操作特定域名，失去意义 |

**这是一组很大的权限** —— 装了它，能连上中转服务的一方就能在你浏览器里执行任意 JS、
读取任何已登录页面的内容。所以：

- 中转服务**默认只绑 `127.0.0.1`**。绑非回环地址时如果没设 `BRIDGE_TOKEN`，服务端会**拒绝启动**。
- WebSocket 升级会**校验 `Origin`**。这条不是形式主义：**WebSocket 不受同源策略约束**，
  你访问的任意网页都能打开一条到 `ws://127.0.0.1:8777/bridge` 的连接，配合"新连接顶掉旧连接"
  的单连接模型，恶意页面连上来就能把真插件挤下线、之后伪造所有应答。"只听回环"完全挡不住这个。
- 担心**其他已安装的扩展**冒名连接，可以把服务端的 `BRIDGE_ALLOWED_ORIGIN` 收紧到
  具体的扩展 id（形如 `chrome-extension://abcd...`，在 `chrome://extensions` 上能看到）。

### 审计：每次操作都有记录

每次浏览器操作都会追加一条 JSONL 到 `~/.browser-mcp/audit.jsonl`，
记录时间、动作、目标标签页、参数、成败、错误码、耗时和一句话结果摘要：

```bash
bx history                 # 最近的操作
bx history --errors        # 只看失败
bx history --tab 1836310612
jq . ~/.browser-mcp/audit.jsonl | less     # 或者直接看文件
```

`BRIDGE_AUDIT_FILE` 可改路径，`BRIDGE_AUDIT=off` 可关闭。

> **`fill` 的值不会被记下来**，只记长度 —— 它完全可能是密码，而这是永久落盘的明文文件。
> 结果只存一句话摘要，不存内容。

---

## 连接是怎么维持的

MV3 的 **service worker 空闲约 30 秒就会被回收**，下面这一串设计都是为了对抗它：

| 机制 | 参数 | 为什么 |
|---|---|---|
| 服务端心跳 | 每 **20 秒** 一次 ping | WebSocket 上的收发会重置 SW 的空闲计时器，间隔必须明显小于 30 秒 |
| 兜底闹钟 | `chrome.alarms` 每 **1 分钟** | SW 被回收后 `setTimeout` 排的重连也一起没了，alarm 是唯一能把它叫醒的机制（最小周期就是 1 分钟） |
| 半开判活 | 超过 **60 秒** 没收到任何字节就重连 | 笔记本睡眠、切网、NAT 超时都会产生半开连接：自称 `OPEN` 其实已死，只看 `readyState` 会一直以为还连着 |
| 重连退避 | 指数退避，上限 **30 秒**，**全抖动** | 抖动不是锦上添花：服务端重启时所有窗口会同时掉线，没有抖动它们会在同一毫秒一起回来，把刚起来的服务端再打垮一次 |

所以**断线是会自愈的，通常不需要你做什么**：服务端重启后实测 3 秒左右恢复；
被别的连接顶下线后是秒级恢复。等不及就点 popup 的「保存并重连」，它会清零退避立刻重试。

---

## 故障排查

### 徽标一直是红色 `OFF`

按顺序排除：

```bash
curl -s http://127.0.0.1:8777/healthz     # 1. 服务在不在？
bx daemon status                            # 2. 守护进程状态
```

- **服务没起** → `bx status` 会自动拉起来，或 `pnpm --filter @browser-mcp/server start`。
- **服务在、插件还是连不上** → 打开 popup 的诊断日志看 `ws_error` / `ensure_check`。
- **地址填错了** → popup 里把「服务地址」清空（会回落到默认值），点保存并重连。
  地址非法也会走退避重试，不需要重装插件。
- **服务端设了 `BRIDGE_TOKEN` 而 popup 没填**（或填错）→ 握手会被拒。两边必须一致。
- **端口被占**：`lsof -nP -iTCP:8777`。如果看到**一个进程持 LISTEN、另一个只持 ESTABLISHED**，
  说明有僵尸进程攥着插件连接 —— `bx daemon stop` 清掉。

### 操作报 `ERR_NO_EXTENSION` / 插件未连接（退出码 3）

徽标是绿的但还是报这个，通常是**冷启动**：守护进程刚起来、插件还在退避中。
`bx` 会自动等最多 20 秒；还不行就点一下 popup 的「保存并重连」。

### 页面报 `ERR_TAB_BLOCKED`（退出码 6）

`chrome://` 开头的页面、Chrome 应用商店、PDF 查看器等禁止注入脚本。
**这不是 bug**，是 Chrome 的硬限制，换一个普通网页操作。

### `ERR_STALE_REF`（退出码 4）

ref 表每次快照整表覆盖，页面变动后旧 ref 就失效了。重新 `bx snapshot` 拿新的 ref，
不要猜也不要退回 CSS 选择器碰运气。

### `ERR_ELEMENT_COVERED`

元素在视口外、或被别的东西盖住（弹窗、遮罩、固定头部）。错误信息里会说明是哪种、被谁盖住。
先处理遮挡（关弹窗、滚动），再重新快照。

### `ERR_DEBUGGER_UNAVAILABLE`

同一标签页上已经有别的调试器了 —— 最常见是你自己开着 DevTools。关掉再试。

### `bx eval` 在某些站点上失败

`eval` 跑在 MAIN world（要看见页面自己的变量），因此**受页面 CSP 限制**，
严格 CSP 的站点上会失败。这是机制本身的限制，不是 bug。

### 改了代码但行为没变

unpacked 扩展**不会自动重载**。见下一节。

---

## 错误码

桥接层的每个失败都带一个稳定的 `ERR_*` 码 —— 不存在"返回错误字符串"的路径。
这让调用方能区分**可重试**（超时、断连）和**不可重试**（元素找不到）。

| 错误码 | 含义 | `bx` 退出码 |
|---|---|---|
| `ERR_NO_EXTENSION` | 插件没连上中转服务 | 3 |
| `ERR_DISCONNECTED` | 请求途中连接断了 | 3 |
| `ERR_NO_TAB` | 找不到指定的标签页 | 4 |
| `ERR_ELEMENT_NOT_FOUND` | 选择器没匹配到元素 | 4 |
| `ERR_STALE_REF` | ref 已失效，需重新快照 | 4 |
| `ERR_ELEMENT_COVERED` | 元素在视口外或被遮挡，点击未执行 | 4 |
| `ERR_TIMEOUT` | 动作超时（默认 30 秒，`BRIDGE_REQUEST_TIMEOUT_MS` 可调） | 5 |
| `ERR_TAB_BLOCKED` | 该页面禁止注入（`chrome://`、应用商店、PDF 等） | 6 |
| `ERR_DEBUGGER_UNAVAILABLE` | 调试器附加失败（多半是 DevTools 占着） | 6 |
| `ERR_INVALID_PAYLOAD` | 参数不合法（下发前被 zod 挡下） | 1 |
| `ERR_INVALID_RESULT` | 插件的回执不符合 schema —— 多半是插件版本比服务端旧 | 1 |
| `ERR_UNKNOWN_ACTION` | 插件不认识这个动作，同上 | 1 |
| `ERR_SCRIPT_FAILED` | 注入的脚本自己抛了异常 | 1 |
| `ERR_PROTOCOL` | 协议层错误（握手版本不匹配等） | 1 |
| `ERR_INTERNAL` | 其余未归类的内部错误 | 1 |

其中 `ERR_INVALID_RESULT` / `ERR_UNKNOWN_ACTION` 出现时，第一件事是
**`pnpm build` 后去 `chrome://extensions` 重新加载插件** —— 服务端会把插件的回执
重新校验一遍，不符合 schema 就拒绝透传，所以两边版本必须同步。

`bx` 的其余退出码：`0` 成功、`2` 用法错。

---

## 改了插件代码之后

```bash
pnpm build
# 然后去 chrome://extensions 点插件卡片上的 ↻ 重新加载
```

**这一步没有捷径**，改 `manifest.json` 的权限时尤其必须手动 reload。
所以涉及插件的改动尽量**攒成一批**再 reload，别改一点 reload 一次。

调试入口：

- **service worker 的 console** —— `chrome://extensions` → 插件卡片上的「Service Worker」链接。
  注意 SW 被回收后 console 会清空，这正是诊断日志存在的理由。
- **popup 的诊断日志** —— 不依赖桥，断线时也能看。
- `bx history --errors` —— 看操作层面的失败。

### 加一个新的浏览器能力

流程是固定的（单一真相源在 `packages/shared/src/actions.ts` 的 `ACTIONS`）：

1. 在 `ACTIONS` 里加一条声明（`description` / `input` / `output`）；
2. 在 `packages/extension/src/background/dispatch.ts` 的 `handlers` 里加同名实现
   —— **不加就是编译错误**，不会变成运行时的未知动作；
3. 需要进页面取数据就去 `background/inject.ts` 加一个 `page*` 函数；
4. **server 不用动**，MCP 工具是遍历 `ACTIONS` 出来的；
5. `pnpm --filter @browser-mcp/server smoke` 验证整条链路。

> **注入进页面的函数必须自包含。** `chrome.scripting.executeScript({ func })` 是把函数
> `toString()` 后送进页面执行的，**不能引用任何外层作用域的东西**（import、模块级常量、
> 闭包变量都不行），输入一律经 `args` 传。打包器不会报这个错，只会在运行时抛
> `xxx is not defined`。

> **smoke 绿了不代表插件是对的** —— 它用的是手写的假插件，真插件有 bug
> （chrome API 用错、manifest 权限缺失、SW 起不来）时 smoke 照样全绿。
> 涉及 `packages/extension` 的改动必须另外在真 Chrome 里手验一遍。

---

## 相关文件

协议与动作（两端共用）：

| 路径 | 作用 |
|---|---|
| `packages/shared/src/actions.ts` | **`ACTIONS`：全仓库的单一真相源**，工具与 handler 都由它长出来 |
| `packages/shared/src/protocol.ts` | 桥接消息格式、握手 |
| `packages/shared/src/errors.ts` | `ERR_*` 错误码 |

中转服务：

| 路径 | 作用 |
|---|---|
| `packages/server/src/index.ts` | 进程入口：HTTP + WebSocket 同进程 |
| `packages/server/src/bridge.ts` | `BridgeHub`：单连接、心跳、超时、回执校验 |
| `packages/server/src/mcp.ts` | 遍历 `ACTIONS` 注册 MCP 工具，写审计 |
| `packages/server/src/cli.ts` | `bx` 命令行（瘦客户端，内部打 `/mcp`） |
| `packages/server/src/selection.ts` | 选中的标签页（模块级单例） |
| `packages/server/src/auth.ts` | `Origin` 校验、令牌比较 |
| `packages/server/src/audit.ts` | 审计 JSONL 的写入与脱敏 |

Chrome 插件：

| 路径 | 作用 |
|---|---|
| `packages/extension/public/manifest.json` | MV3 清单，权限与入口（不经打包，原样拷进 dist） |
| `packages/extension/public/popup.html` | popup 界面（同上） |
| `packages/extension/src/background/index.ts` | SW 入口：建连接、分发请求、闹钟兜底 |
| `packages/extension/src/background/connection.ts` | WebSocket 生命周期、判活、退避重连 |
| `packages/extension/src/background/dispatch.ts` | 动作分发表，与 `ACTIONS` 一一对应 |
| `packages/extension/src/background/ax.ts` | 无障碍树 → 缩进快照 |
| `packages/extension/src/background/cdp.ts` | 调试器附加、可见性过滤、坐标点击 |
| `packages/extension/src/background/inject.ts` | 注入页面的自包含函数 |
| `packages/extension/src/background/network.ts` | 网络录制与环形缓冲区 |
| `packages/extension/src/background/refs.ts` | ref ↔ DOM 节点映射表 |
| `packages/extension/src/background/diag.ts` | 跨 SW 存活的诊断日志 |
| `packages/extension/src/background/settings.ts` | 服务地址与令牌 |
| `packages/extension/src/background/badge.ts` | 徽标状态 |

根目录的 `CLAUDE.md` 记了更多"为什么这么写"的设计约束，改代码前值得先读。
