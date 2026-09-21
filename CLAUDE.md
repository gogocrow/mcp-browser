# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 常用命令

```bash
pnpm install
pnpm check       # biome + 三个包的类型检查 + 全部测试（提交前跑这个）
pnpm build       # 构建三个包
pnpm dev         # 先构建 shared，再以 --watch 起中转服务
pnpm typecheck   # 仅类型检查（pnpm -r tsc --noEmit）
pnpm test        # 全部测试
pnpm test:watch  # 监听模式
pnpm lint        # Biome 检查（不改文件）
pnpm lint:fix    # Biome 检查并自动修复
pnpm format      # 仅格式化

pnpm --filter @browser-mcp/server smoke   # 不开 Chrome 跑通整条链路，见下文
```

跑单个测试用 `-t` 过滤，可匹配 `describe` 分组名或单个用例名（均为中文）：

```bash
npx vitest run -t '退避'
npx vitest run -t 'BridgeHub 连接生命周期'
```

**包管理器统一用 pnpm。** `package-lock.json` / `yarn.lock` 已进 `.gitignore`，别用 npm 或 yarn 装依赖。三个包共用的依赖版本集中写在 `pnpm-workspace.yaml` 的 `catalog:` 里，各包只写 `"catalog:"` 引用 —— 升版本改那一处，不要在各包里散着写死版本号。

Node 22.18+ / 24 可直接执行 `.ts`，服务端和脚本都**不需要先编译**（`node src/index.ts` 即可），仓库里没有 `tsx`。

## 三段式结构

```
AI 客户端 ──MCP / Streamable HTTP──> node 中转服务 ──WebSocket──> Chrome 插件 ──chrome.scripting──> 页面
             (packages/server)                        (packages/extension)
                         两端共用 packages/shared 的协议与动作定义
```

服务端自己不懂浏览器，插件自己不懂 MCP，中间靠 `shared` 里的动作注册表把两边钉在一起。

接入 AI 客户端时它是一个 HTTP 形态的 MCP server，端点 `http://127.0.0.1:8777/mcp`：

```bash
claude mcp add --transport http browser http://127.0.0.1:8777/mcp
# 设了 BRIDGE_TOKEN 时：
claude mcp add --transport http browser http://127.0.0.1:8777/mcp --header "Authorization: Bearer <token>"
```

Codex CLI / Qoder CLI / Qoder IDE 的接法写在 `README.md` 的「不用 `bx`，直接接 MCP」一节 —— 加新客户端时改那里，别在这里再抄一份。

## 对外入口：`bx` 命令行 + `browser` skill

日常使用走全局命令 `bx`（`packages/server/src/cli.ts`），而**不是**把 MCP 注册给 Claude Code。原因是注册 MCP 会把 17 个工具的 schema 常驻上下文（实测 name + description + inputSchema 共 7,606 字符，客户端若展开 outputSchema 约 17k 字符）；skill 只在触发时加载，`bx --help` 按需取。

CLI 是个瘦客户端，**内部仍然打守护进程的 `/mcp` 端点** —— 上下文开销来自"注册给模型"，不是传输协议本身，所以没必要为了 CLI 另造一套协议。MCP 端点因此也顺带保留给别的客户端用。

```bash
cd packages/server && pnpm link --global   # 装成全局 bx
```

- skill 装在 `~/.claude/skills/browser/SKILL.md`，只写工作流和铁律，命令表让模型跑 `bx --help` 现拿。
- **退出码是 skill 的分支依据**（3=插件未连、4=找不到目标或 ref 失效、6=页面禁止操作），改 `EXIT_BY_CODE` 要同步改 SKILL.md。
- **截断警告一律走 stderr**：stdout 常被 `grep` 吃掉，"你看到的是残缺内容"这件事必须还能看见。`--max 0` 表示不截断。
- 首次调用会自动 `spawn` 守护进程并**等待插件连上（最多 20 秒）**。等这么久是因为插件此时多半正处在重连退避中（退避上限 30 秒）—— 实测等 9 秒不够，会误报「插件未连接」。

## 主线：列出页面 → 选中页面 → 在该页面上操作

**这个项目不负责"打开浏览器"**，它接管用户已经开着、已经登录好的标签页 —— 这正是插件方案相对 Playwright 那类的价值所在。所以交互主线是：

1. `tabs_list` 列出现有标签页；
2. `tabs_select` 选定其中一个作为后续操作的目标（**只是选定，不会把页面切到前台**，切前台是 `tabs_activate`）；
3. 之后所有 `page_*` 动作**省略 `tabId` 就作用在选中的页面上**，不必每次重复传。

`tabId` 省略时的解释顺序是：**选中的页面 → 当前活动标签页**。前一步由服务端的 `Selection`（`server/src/selection.ts`）在 `applySelection()` 里补，后一步由插件的 `resolveTabId()` 兜底。

几条刻意的取舍：

- **显式传入的 `tabId` 永远优先于选中状态**，模型想临时看一眼别的页面时不该被选中劫持。
- **只有动作成功才记住选中** —— `tabs.select` 要真的往插件走一趟确认标签页存在，失败时保持原来的选中不变。
- **选中状态存在服务端的模块级单例里**，因为 MCP 侧是无状态的（每请求现建 server）、插件侧的 service worker 随时会被回收，两边都存不住。
- **插件一断开就清空选中**（`BridgeHub` 的 `onDetach`）。标签页 id 只在一次浏览器会话内有效，浏览器重启后同一个 id 很可能指向完全不同的页面，留着旧值会让后续操作静默打到错误的页面上。
- 选中是**全局单例**，多个 AI 客户端接同一个服务会共享它。本地单用户场景下这是想要的行为。

`browser_status` 会一并报告当前的 `selectedTabId`。

用户会陆续往下加更多页面操作 —— 加动作的步骤见下一节，主线本身不用动。

## 语义快照：`page.snapshot` 与 `page.text` 的分工

**两种意图不共用一个工具**：`page.snapshot` 用来"操作页面"，`page.text` 用来"读内容"。

`page.snapshot` 走 CDP 的 `Accessibility.getFullAXTree` 拿 Chrome 真实的无障碍树（`extension/src/ax.ts` 渲染成缩进树）。用真 AX 树而不是自己在页面里近似算 role/name，代价是必须 `chrome.debugger` 附加、目标标签页常驻「正在被调试」横幅 —— **这个代价是用户明确接受过的，不要为了去掉横幅换回手写近似**。

每个可交互节点带 `[ref=eN]`，`page.click` / `page.fill` 优先吃 ref。ref 直接指向 DOM 节点（backendNodeId），不受 class 名变化、同名元素、动态重排影响，比让模型猜 CSS 选择器可靠得多。ref 表存在 session storage 并**每次快照整表覆盖**，失效时报 `ERR_STALE_REF` 让模型重新快照。

**角色过滤是实测调出来的，别凭直觉删**（同一批页面上量的）：

| 页面 | `page.text` | 未做角色过滤 | 过滤后 + `includeStructure` | 默认（仅可操作） |
|---|---|---|---|---|
| API 文档（表格密集） | 51,829 | 65,078 | 19,449 | 9,075 |
| 视频站首页（链接密集） | 856 | 3,950 | 4,163 | 3,160 |

两条反直觉的结论：

- **`StaticText` 必须丢弃。** AX 树里几乎每个 `link "首页"` 下面都挂一个 `StaticText "首页"`，纯重复，实测占掉约一半体积。
- **表格类角色（`cell` / `row` / `columnheader` / `table`）必须当透明节点。** 它们是内容不是控件；不过滤的话 API 文档那种页面的语义快照会**比整页纯文本还大**（65k vs 52k），工具就完全失去意义了。透明节点仍会下钻，所以单元格里的链接不会丢；要读表格内容用 `page.text`。

**语义快照本身不是压缩手段**，它是"结构 + 可操作性"手段。别把"快照一定比正文小"当成前提。

### 快照只收可见元素

`ax.ts` 是两遍走：先收集可交互候选，交给 `cdp.ts` 的 `filterVisible` 判活，再渲染。**看不见的元素一个 ref 都不发。**

为什么必须查计算样式而不能只看几何：实测爱快路由后台 45 个可交互元素里 **21 个是 `opacity: 0`，而它们照样进无障碍树**。过滤前发 38 个 ref、一半是幽灵，模型只能挨个点着试；过滤后 12 个，全部可点。

| 页面 | DOM 节点 | ref（过滤前 → 后） | 快照字符 |
|---|---|---|---|
| 路由后台（SPA + 组件库） | 632 | 38 → **12**（−68%） | 1088 → **318**（−71%） |
| 视频站首页 | 1,599 | 95 → 87（−8%） | 3157 → 2884（−9%） |
| API 文档 | 11,113 | 234 → 234（0%） | 9075 → 9075（0%） |

收益集中在应用型界面 —— 正是最需要操作的那类页面。省下的不只是字符，更是**消除试错**：一次失败点击是一整轮工具调用加报错文本，比快照本身贵得多。

三个实现上的坑：

- **视口判断必须用文档坐标，不能用视口坐标。** 折叠线以下的元素是合法可点的（点击前会先滚过去），按视口过滤会把长页面的大半内容误杀。要滤掉的是被挪出画布的（如收起态菜单 `x=-44`）。
- **opacity 要沿祖先链累乘**，只查自身会漏掉"父容器整体透明"这种最常见的写法。
- **别为了"少读几个矩形"把判活拆成两趟循环。** 成本几乎全在**第一次读几何属性**上——那一下触发整篇文档的布局，11113 节点的文档页实测约 127ms，之后每个元素只要几微秒。受控实验：同一批 234 个元素，交替读样式与矩形 1ms，拆成两趟反而 2ms。纯读**不会**造成布局抖动，抖动需要「写-读」交替。

**性能实情**（别照着直觉优化）：快照耗时主要由 `getFullAXTree` 决定，随 DOM 规模走 —— 11k 节点的文档页约 1.1 秒，这部分省不掉。逐节点判活只占约 **0.8ms/节点**。`filterVisible` 里有条短路：先在页面内花约 30ms 数一次隐藏元素，为 0 就跳过逐节点检查，内容型页面因此省下约 188ms。这是温和优化，不是关键路径 —— 当初我误把文档页的 1.4 秒归因于过滤，实际那是它一贯的耗时。

### 点击必须用真实鼠标事件，不能用 `element.click()`

`cdp.ts` 的 `clickElement` 走的是「`DOM.scrollIntoViewIfNeeded` → `DOM.getContentQuads` 取中心 → `Input.dispatchMouseEvent`」，**不要"简化"回 `element.click()`**。

原因是实测踩过的坑：Chrome 无障碍树会把整张卡片折叠成一个 `button` 节点，但它关联的 DOM 节点可能是**外层包裹 div**，而点击处理器挂在其**子元素**上（antd / element / MUI 这类组件库极常见）。`element.click()` 的事件 target 就是那个包裹 div，只会向上冒泡、永远到不了子元素 —— 表现为"接口返回成功、页面毫无反应"，是最难查的一类失败。坐标点击命中的是该位置最顶层的元素，事件自然穿过真正带处理器的那一层。

点击前还会用 `document.elementFromPoint` 做命中检测，不通过就报 `ERR_ELEMENT_COVERED` 并说明原因（元素在视口外 / 被谁盖住）。**这个检查比它看起来重要**：没有它，点到不可见元素会静默成功。ref 与 selector 两条路都归一到这里，避免两种点击语义各自漂移。

`contains` 检测必须双向（`this.contains(hit) || hit.contains(this)`）：无障碍树给的常是外层包裹节点，而坐标命中的是它内部的文字节点，这是正常情况不是遮挡。

**参数的默认值必须让省钱的那一边是 `false`。** 现在是 `includeStructure`（默认 `false` = 只给可操作元素 = 最省），而不是反过来的 `interactiveOnly`。LLM 倾向于不传可选参数，所以默认值直接决定实际开销；参数名的极性写反，等于让每次调用都走贵的那条路。同理，**工具描述里要写清具体体积**（"约 9000 字符""开了会翻倍"），模型才有依据决定要不要加参数——只写"更省"它无法判断值不值。

## 网络监听

`extension/src/background/network.ts`。`net start` → 触发操作 → `net list` 拿 requestId → `net body <id>` 取正文 → `net stop`。

- **CDP 事件是推送，而本项目协议是请求-应答**，所以事件收进每标签页的环形缓冲区（上限 1000 条），由 `network.list` 轮询取走。**不要为了网络监听给协议加一种推送消息** —— 轮询模型同样契合 CLI 的用法。
- **`requestWillBeSent` 只内联 `maxPostDataSize`（64KB）以内的请求体**，超出的 `postData` 是 null，必须再调一次 `Network.getRequestPostData`。实测 100KB 的 POST 原本完全拿不到，大 body 接口调试就是瞎的。
- **请求体和响应体都必须截断。** 曾经只给响应体做了分页保护，请求体整个返回 —— 一次文件上传就能把调用方上下文冲垮。同一个接口里两种待遇是设计漏洞。
- **响应体是浏览器临时保留的**，导航或缓冲区淘汰后 `Network.getResponseBody` 就会失败，这不是 bug；此时摘要信息仍在缓冲区里可查。
- 录制前发生的请求抓不到 —— **必须先 start 再触发操作**。

## 审计日志

每次浏览器操作都会追加一条 JSONL 到磁盘（默认 `~/.browser-mcp/audit.jsonl`，`BRIDGE_AUDIT_FILE` 可改，`BRIDGE_AUDIT=off` 关闭），记录时间、动作、目标标签页、参数、成败、错误码、耗时和一句话结果摘要。用 `history_query` 工具查（支持按标签页、时间、只看失败过滤）。文件是逐行 JSON，也可以直接 `grep` / `jq`。

几个刻意的取舍：

- **写入点在 `mcp.ts` 的 `registerAction` 里，不在 `BridgeHub.call`。** 那里才拿得到"补过选中之后的真实 tabId"和最终的成败，而且插件没连上时的失败也能记下来 —— 这类失败根本到不了 `hub.call`。
- **`page.fill` 的 `value` 必须脱敏，只记长度。** 它完全可能是密码，而这是**永久落盘**的明文文件。`redactParams` 里的 `REDACTED_FIELDS` 别删。同理超长字符串（如 `page.eval` 的表达式）截断到 200 字符。
- **结果只存一句话摘要，不存内容。** 快照动辄几万字符，原样落盘既没人看也会让文件飞快膨胀。`summarizeResult` 里**分支顺序有讲究**：`tag` 必须排在 `text` 前面，否则 `page.click` 返回的 `{ tag, text }` 会被误记成"正文 N 字符"（这个 bug 被单测抓出来过）。
- **只读的元操作（`browser_status` / `history_query`）不写审计**，否则查一次历史就往日志里塞一条，很快自我淹没。
- 写审计一律 fire-and-forget 且吞掉所有异常 —— **磁盘满不能让浏览器操作跟着失败**。

## 单一真相源：`shared/src/actions.ts` 的 `ACTIONS`

这是全仓库最重要的一个对象。每条动作声明 `description` / `input` / `output`（后两者必须是 `z.object`），然后：

- **server** 遍历它自动注册 MCP 工具，`input.shape` 直接当工具的参数 schema，`output.shape` 当 `outputSchema`；
- **extension** 的 `dispatch.ts` 用映射类型 `{ [K in ActionName]: ... }` 声明 handlers，**漏实现一条就是编译错误**，不会变成运行时的未知动作；
- 下发前用 `input` 校验、收到回执后用 `output` 再校验一次。

因此**加一个新的浏览器能力**的流程是固定的：

1. 在 `ACTIONS` 里加一条；
2. 在 `extension/src/background/dispatch.ts` 的 `handlers` 里加同名实现（不加则编译失败）；
3. 需要进页面取数据就去 `extension/src/background/inject.ts` 加一个 `page*` 函数；
4. **server 不用动** —— 工具是遍历出来的；
5. 跑 `pnpm --filter @browser-mcp/server smoke` 验证。

`ActionInput` / `ActionPayload` 是两个不同的类型，别混：`ActionInput` 是 `z.input`（调用方视角，带默认值的字段可省略），`ActionPayload` 是 `z.output`（handler 视角，默认值已填好）。当初把 handler 也写成 `ActionInput` 会导致调用方被迫传本该有默认值的字段。

MCP 工具名不能带点，`toolNameFor()` 把 `page.navigate` 转成 `page_navigate`。

## 改了 shared 必须重新构建

`server` 和 `extension` 通过 `@browser-mcp/shared` 的 **dist** 引用它（不是源码）。只改 `shared/src` 而不重新构建，另外两个包看到的还是旧的。`pnpm build` 和 `pnpm dev` 都已处理（`pnpm -r` 按依赖拓扑序，shared 一定先于其余两个），但单独跑 `pnpm --filter @browser-mcp/server dev` 时要自己注意。

## 服务端

**WS 服务与 MCP 端点必须在同一个进程里**，这是刻意的，别拆成两个：只有一个进程能持有插件那条 WebSocket 连接。若 MCP 改成 stdio 形态，每个 AI 客户端都会 spawn 一份进程，第二份起来就会抢不到端口、也拿不到插件连接。所以 MCP 走 Streamable HTTP，桥是模块级单例。

**MCP 侧是无状态的**：每个请求现建一对 `McpServer` + transport，用完即弃（`sessionIdGenerator: undefined`）。需要长活的是桥而不是 MCP 会话。

`BridgeHub`（`server/src/bridge.ts`）承载的不变式，都有对应测试（`server/test/bridge.test.ts`），改坏了测试会红：

- **同一时刻只保留一条插件连接**，新连接顶掉旧的；被顶掉的旧连接迟到的 `close` 事件不能污染新连接的状态（用 `socket !== this.#socket` 判别）。
- **只有收到 `hello` 才算连上。** 光有 TCP 连接不代表插件那边跑起来了。
- **每个在途请求都有超时**；连接关闭时必须把待处理表全部拒掉，否则调用方要一直挂到超时、且 Map 只增不减。
- **回执一律重新校验。** 插件是独立安装的、版本可能比服务端旧，它回什么都当不可信输入，不符合 `output` 就报 `ERR_INVALID_RESULT`，绝不把脏数据透传给模型。
- **必须监听 socket 的 `error` 事件。** ws 对没有监听器的 `'error'` 直接 throw，会崩掉整个服务进程。
- 工具执行失败走 `isError: true` 而不是抛异常 —— 模型需要看见 `ERR_*` 码才能判断是重试还是换个选择器。

`BridgeStatus` 必须是 `type` 而不是 `interface`：MCP 的 `structuredContent` 要求 `Record<string, unknown>`，interface 拿不到隐式索引签名，换成 interface 直接编译不过。

## 插件：MV3 的几条硬约束

**service worker 空闲约 30 秒就会被回收**，这条决定了下面一串设计，改动时别当成冗余删掉：

- 服务端每 **20 秒**发一次 ping（`HEARTBEAT_MS`）。WebSocket 上的收发会重置那个空闲计时器，间隔必须明显小于 30 秒。
- SW 被回收后 `setTimeout` 排的重连也一起没了，所以用 **`chrome.alarms` 每分钟兜底**唤醒一次并 `ensure()` 补连接（alarm 最小周期就是 1 分钟）。
- 重连用指数退避 + **全抖动**。抖动不是锦上添花：服务端重启时所有窗口会同时掉线，没有抖动它们会在同一毫秒一起回来。

**注入进页面的函数必须自包含。** `chrome.scripting.executeScript({ func })` 是把函数 `toString()` 后送进页面执行的，**不能引用任何外层作用域的东西**（import、模块级常量、闭包变量都不行），输入一律经 `args` 传。打包器不会报这个错，只会在运行时抛 `xxx is not defined`。`inject.ts` 里所有 `page*` 函数都必须守住这一点。

**ISOLATED 与 MAIN world 的取舍**：DOM 操作留在默认的 ISOLATED（够用且更安全），只有 `page.eval` 用 MAIN —— 它要看见页面自己的变量。相应地 `page.eval` 受页面 CSP 限制，严格 CSP 的站点上会失败，这是机制本身的限制不是 bug。

**给输入框填值要走原生 setter。** React/Vue 会劫持 `value` 的 setter 来跟踪状态，直接赋值它们收不到变更；`pageFill` 取原型链上的原生 setter 再补派发 `input` / `change`，受控组件才认。

连接状态通过 `chrome.action` 的**徽标**呈现（ON 绿 / ··· 黄 / OFF 红），同时写一份到 `chrome.storage.session` 供 popup 实时读取。用 session 而不是 local，是因为连接状态跟着浏览器会话走，重启后不该残留上次的"已连接"。

插件产物在 `packages/extension/dist`，Chrome 里用「加载已解压的扩展程序」指向该目录。`manifest.json` 和 `popup.html` 不经打包，放在 `public/`，由 `scripts/copy-static.ts` 原样拷进 dist。

## 安全不变式

这个服务能让调用方在用户浏览器里执行任意 JS、读取任何已登录页面的内容，下面几条别"顺手优化"掉：

- **WebSocket 升级必须校验 `Origin`**（`server/src/auth.ts` 的 `isOriginAllowed`）。**WebSocket 不受同源策略约束** —— 用户访问的任意网页都能打开一条到 `ws://127.0.0.1:8777/bridge` 的连接。配合"新连接顶掉旧连接"的单连接模型，恶意页面连上来发个 `hello` 就能把真插件挤下线，之后 AI 的每个请求都由它伪造应答。**"只听回环"完全挡不住这个**，因为发起方就在本机浏览器里。
  - 规则是"带了 Origin 就必须是 `chrome-extension://`，没带则放行"。浏览器一定会带 Origin，所以"不带"不是绕过手段；而 curl / 联调脚本这类本机进程本来就不在威胁模型里（能在本机跑代码的人已经赢了）。
  - `BRIDGE_ALLOWED_ORIGIN` 可以收紧到具体的扩展 id，防止**其他已安装的扩展**冒名连接。
- **默认只绑 `127.0.0.1`。** `assertConfigSafe()` 会在非回环地址且没设 `BRIDGE_TOKEN` 时**拒绝启动** —— 绑 `0.0.0.0` 等于把同网段的任何人变成用户浏览器的主人。
- 设了 `BRIDGE_TOKEN` 则两条路径都校验：插件走 `?token=`（WebSocket 构造器不支持自定义请求头，只能挂 query），MCP 走 `Authorization: Bearer`。比较用 `timingSafeEqual`，注意它在长度不等时会抛异常，必须先挡。
- 请求体有大小上限，日志一律走 stderr（留出 stdout 以便日后接 stdio 形态的 MCP）。

配置项：`BRIDGE_HOST` / `BRIDGE_PORT`（默认 8777）/ `BRIDGE_TOKEN` / `BRIDGE_ALLOWED_ORIGIN` / `BRIDGE_REQUEST_TIMEOUT_MS`（默认 30000）/ `BRIDGE_LOG=off`。

## 联调脚本

`packages/server/scripts/smoke.ts` 会起一个真的服务端，用一个**假插件**接到 `/bridge`，再按 MCP 协议打 `/mcp`，把「MCP 工具 → 桥 → 插件 → 回执」整条链路跑一遍。它按上面那条主线逐步断言：未选中时落到活动页 → 选中后落到选中页 → 显式 `tabId` 覆盖选中 → 选中不存在的页面时报错且不改变原选中。

插件那一半没法在单元测试里覆盖，**改动协议、`ACTIONS`、选中逻辑或 MCP 装配后请跑它**。假插件的 `resolveTab()` 刻意复刻了真插件 `resolveTabId()` 的兜底行为，改其中一个时另一个要跟着改。

**但它的假插件是手写镜像，绿了不代表真插件是对的** —— 真插件有 bug（chrome API 用错、manifest 权限缺失、service worker 起不来）时 smoke 照样全绿。涉及 `packages/extension` 的改动必须另外在真 Chrome 里手验一遍：

```bash
pnpm build
pnpm --filter @browser-mcp/server start        # 另起一个终端
# chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → packages/extension/dist
curl -s http://127.0.0.1:8777/healthz          # connected 应为 true
```

手验时打 MCP 端点可以用 `POST /mcp` 发 `tools/call`（注意 `accept` 头要同时带 `application/json, text/event-stream`，响应可能是 SSE）。

## 代码风格

Biome 统一管理格式与 lint，配置在根 `biome.json`：**2 空格缩进、单引号、必加分号、尾随逗号、行宽 100**。不要手动调格式，跑 `pnpm lint:fix`。

相对导入一律带 `.ts` 扩展名（`rewriteRelativeImportExtensions` + `allowImportingTsExtensions`），与同目录下的 `infra/ikuai` 保持一致。

提交信息用中文。代码注释里解释"为什么这么写"的部分请保留 —— 上面这些约束大多只在注释里留了痕迹，删掉后很容易被下一次重构还原成 bug。

## 当前状态

`pnpm check` 全绿（35 个测试），三个包都能构建。

**已在真实 Chrome（152）里验过**：插件加载与握手；`tabs_list` 拿到真实标签页；`tabs_select` 后省略 `tabId` 的操作确实落在选中页而非活动页，显式 `tabId` 能覆盖选中；`page_snapshot` 拿到真 AX 树并带 ref；`page_click {ref}` 能点中真实按钮；失效 ref 报 `ERR_STALE_REF`；`page_text` / `page_query` / `page_eval` 都能取到真实页面数据；`chrome://` 页面如期返回 `ERR_TAB_BLOCKED`；CDP 会话在多次调用间正确复用。

**自动重连与鉴权已实测通过**：服务端 SIGTERM 重启后插件 3 秒自动恢复；被别的连接顶下线后也是秒级恢复（靠服务端主动关旧连接，见下）；插件自身的判活兜底也验过（服务端不发关闭事件时约 72 秒恢复）。`BRIDGE_TOKEN` 的 WS 与 MCP 两条路径、非回环无 token 拒绝启动、`Origin` 拦截网页来源（403）全部实测通过。

**还没在真 Chrome 里验过的**：`page_fill`（ref 与 selector 两条路都没验）、`page_navigate`、`tabs_activate`。写到这些地方时别默认它们是对的。

> **顶掉旧连接时必须主动 `close()` 它**（`BridgeHub.#detach`）。曾经漏掉这一句：服务端只是把旧 socket 丢掉不管，插件那侧收不到任何事件、也不再收到心跳，只能等自己的判活超时才恢复 —— 实测 **72 秒 vs 0 秒**的差别。

> **「服务端重启后插件永远不重连」的真凶是服务端的关闭流程，不在插件侧**（已修，但这个坑值得完整记住）。
>
> `httpServer.close()` 只是停止 accept，它会等现有连接结束；而 WebSocket 是长连接永远不会自己结束，于是 close 回调不触发、`process.exit()` 执行不到。结果是一个**没有 LISTEN 套接字、却仍攥着插件连接并继续每 20s 发心跳的僵尸进程**。新进程能正常绑定端口，插件却一直连在僵尸上，且看到的是一条完全健康的连接。`lsof -nP -iTCP:8777` 能一眼看穿：一个进程持 LISTEN，另一个只持 ESTABLISHED。
>
> 所以信号处理里**必须先 `wss.clients.forEach(c => c.terminate())` 再 `httpServer.close()`**，并加一个兜底的强制退出定时器。删掉那句 terminate，这个 bug 会原样回来。
>
> **排查过程中我连续错了三次，每次都是"看着像"就动手改**：先怀疑 `chrome.alarms` 没唤醒 SW（改了，其实 alarm 每分钟都准时触发）、再怀疑 WebSocket 半开（加了判活，其实连接是真活着）。真正解决问题的是把**判断依据本身**打进日志（`ensure_check` 记录 `readyState` 与"多久没收到消息"）—— 一看到 `readyState=1 idle=20s` **恒定不变**，就知道插件在正常收心跳，矛头立刻转向服务端。
>
> 教训：**后台间歇性问题，先加可观测性，不要先改代码。** 日志要记"看到了什么"（判断依据），不能只记"做了什么"（行为），否则查不出是哪个分支吃掉了逻辑。`debug.log`（跨 SW 存活）和 popup 里的日志面板（不依赖桥接，断线时也能看）就是为此保留的，别当成临时调试代码删掉。

**开发循环的固有摩擦**：unpacked 扩展改了代码必须去 `chrome://extensions` 手动点 ↻ 重新加载，改 manifest 权限尤其如此。所以涉及插件的改动要尽量攒成一批再让用户 reload，别一次改一点。

页面操作目前这批是占位性质的通用动作，用户会按实际场景陆续定义更贴合的。图标资源也还没做（目前只有徽标，动作图标是 Chrome 默认的拼图块）。
