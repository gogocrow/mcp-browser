import { z } from 'zod';

export const TabInfo = z.object({
  id: z.number().int(),
  windowId: z.number().int(),
  url: z.string(),
  title: z.string(),
  active: z.boolean(),
});

/**
 * 所有页面级动作共用的可选目标。省略时的解释顺序是：
 * 已经 tabs.select 选中过 → 用选中的那个；否则 → 当前窗口的活动标签页。
 * 前一步由 server 填充，后一步由 extension 兜底。
 */
const tabId = z
  .number()
  .int()
  .optional()
  .describe('目标标签页 id；省略则用 tabs.select 选中的页面，没选过则用当前活动标签页');

const selector = z.string().min(1).describe('CSS 选择器');

const optionalSelector = z.string().min(1).optional().describe('CSS 选择器；与 ref 二选一');

/**
 * page.snapshot 产出的元素标识。ref 与 selector 必须至少给一个 —— 这条约束**不能**写成
 * `.refine()`，那会把 ZodObject 变成 ZodEffects、丢掉 `.shape`，server 就没法拿它当 MCP
 * 工具的参数 schema 了。所以只能在 extension 的 handler 里运行时校验。
 */
const ref = z
  .string()
  .regex(/^e\d+$/)
  .optional()
  .describe('page.snapshot 里的元素标识，形如 e12；与 selector 二选一，优先用 ref');

/**
 * 动作注册表 —— 全仓库唯一的动作真相源。
 *
 * server 用它生成 MCP 工具（input 直接当作工具的参数 schema），extension 用它校验下发的
 * payload 与回传的 result。新增一个浏览器能力 = 在这里加一条 + 在 extension 的 handlers 里
 * 实现同名函数，两边的类型由 ActionInput/ActionOutput 自动对齐。
 */
export const ACTIONS = {
  'tabs.list': {
    description: '列出当前所有标签页（id、url、标题、是否活动）',
    input: z.object({}),
    output: z.object({ tabs: z.array(TabInfo) }),
  },
  'tabs.select': {
    description:
      '选定后续操作的目标标签页。选中后，page.* 动作省略 tabId 即作用于它，不必每次重复传。不会把页面切到前台',
    input: z.object({ tabId: z.number().int() }),
    output: z.object({ tab: TabInfo }),
  },
  'tabs.activate': {
    description: '把指定标签页切到前台并聚焦其窗口（只是切前台，不改变 tabs.select 的选中目标）',
    input: z.object({ tabId: z.number().int() }),
    output: z.object({ tab: TabInfo }),
  },
  'page.navigate': {
    description: '让标签页导航到指定 URL，等待加载完成',
    input: z.object({
      url: z.url(),
      tabId,
      timeoutMs: z.number().int().positive().max(120_000).default(30_000),
    }),
    output: z.object({ tab: TabInfo }),
  },
  'page.snapshot': {
    description:
      '抓取页面的语义快照，用于在页面上做操作。以缩进树输出元素的角色与名称，可操作元素带 [ref=eN]，把 ref 交给 page.click / page.fill 即可操作，比猜 CSS 选择器可靠得多。' +
      '默认只输出可交互元素（链接、按钮、输入框），大型页面实测约 9000 字符，约为整页纯文本的 1/6。' +
      '只有当你需要判断页面结构、当前处在文档哪一节时，才把 includeStructure 设为 true —— 它会额外带上全部标题，体积翻倍（同页实测约 19000 字符）。' +
      '要阅读正文内容不要用本工具，改用 page.text。',
    input: z.object({
      tabId,
      includeStructure: z
        .boolean()
        .default(false)
        .describe(
          '是否附带标题等结构性元素。默认 false 只给可交互元素，体积最小；确实需要理解页面结构时才开，会让快照大一倍',
        ),
      maxChars: z.number().int().positive().max(200_000).default(20_000),
    }),
    output: z.object({
      url: z.string(),
      title: z.string(),
      snapshot: z.string(),
      refCount: z.number().int(),
      hiddenCount: z.number().int().describe('因不可见（透明/隐藏/画布外）被滤掉的可交互元素数'),
      totalChars: z.number().int().describe('截断前的完整长度，供调用方判断要不要取全'),
      truncated: z.boolean(),
    }),
  },
  'page.text': {
    description:
      '抓取页面的可见纯文本，用于"读内容"而非操作。大页面很容易上万字符，优先用 page.snapshot 或配合 selector 缩小范围',
    input: z.object({
      tabId,
      selector: z.string().min(1).optional().describe('只取该元素内的文本；省略则取整页'),
      maxChars: z.number().int().positive().max(200_000).default(20_000),
    }),
    output: z.object({
      url: z.string(),
      title: z.string(),
      text: z.string(),
      totalChars: z.number().int().describe('截断前的完整长度'),
      truncated: z.boolean(),
    }),
  },
  'page.query': {
    description: '按选择器列出匹配元素的摘要（标签名、文本、关键属性）',
    input: z.object({
      selector,
      tabId,
      limit: z.number().int().positive().max(200).default(30),
    }),
    output: z.object({
      matches: z.array(
        z.object({
          index: z.number().int(),
          tag: z.string(),
          text: z.string(),
          attributes: z.record(z.string(), z.string()),
        }),
      ),
      total: z.number().int(),
    }),
  },
  'page.click': {
    description: '点击一个元素。优先用 page.snapshot 给出的 ref；也可以退回 CSS 选择器',
    input: z.object({ ref, selector: optionalSelector, tabId }),
    output: z.object({ tag: z.string(), text: z.string() }),
  },
  'page.fill': {
    description:
      '给 input/textarea/contenteditable 填值并派发 input+change 事件。优先用 ref，也可退回 CSS 选择器',
    input: z.object({ ref, selector: optionalSelector, value: z.string(), tabId }),
    output: z.object({ tag: z.string() }),
  },
  'network.start': {
    description:
      '开始录制该标签页的网络请求。有性能开销，用完请 network.stop。录制期间的请求用 network.list 查看',
    input: z.object({ tabId }),
    output: z.object({ recording: z.boolean(), cleared: z.number().int() }),
  },
  'network.list': {
    description:
      '列出已录到的网络请求，只给 method + URL + requestId 等摘要，**不含响应体**。要看正文再用 network.body 按 requestId 取。支持分页与过滤',
    input: z.object({
      tabId,
      offset: z.number().int().min(0).default(0),
      limit: z.number().int().positive().max(200).default(30),
      urlContains: z.string().optional().describe('只看 URL 含该子串的'),
      method: z.string().optional().describe('只看该方法，如 POST'),
      onlyApi: z.boolean().default(false).describe('只看 XHR/fetch，滤掉图片脚本样式'),
      onlyFailed: z.boolean().default(false).describe('只看失败或非 2xx 的'),
    }),
    output: z.object({
      recording: z.boolean(),
      total: z.number().int().describe('过滤后的总数，用于翻页'),
      offset: z.number().int(),
      entries: z.array(
        z.object({
          requestId: z.string(),
          method: z.string(),
          url: z.string(),
          status: z.number().int().nullable(),
          type: z.string().nullable(),
          bytes: z.number().nullable(),
          durationMs: z.number().nullable(),
          failed: z.string().nullable(),
        }),
      ),
    }),
  },
  'network.body': {
    description:
      '按 requestId 取单条请求的详情与响应体。响应体可能极大，默认只给一段，用 offset 继续往后取',
    input: z.object({
      tabId,
      requestId: z.string(),
      offset: z.number().int().min(0).default(0),
      maxChars: z.number().int().positive().max(100_000).default(2_000),
      includeHeaders: z.boolean().default(false).describe('是否附带请求/响应头'),
    }),
    output: z.object({
      requestId: z.string(),
      method: z.string(),
      url: z.string(),
      status: z.number().int().nullable(),
      mimeType: z.string().nullable(),
      postData: z.string().nullable().describe('请求体（同样受 maxChars 截断，仅 POST 之类才有）'),
      postDataTotalChars: z.number().int().describe('请求体截断前的完整长度'),
      requestHeaders: z.record(z.string(), z.string()).nullable(),
      responseHeaders: z.record(z.string(), z.string()).nullable(),
      base64Encoded: z.boolean(),
      totalChars: z.number().int(),
      offset: z.number().int(),
      chunk: z.string(),
      truncated: z.boolean(),
    }),
  },
  'network.stop': {
    description: '停止录制并释放开销。已录到的记录仍可继续用 network.list 查看',
    input: z.object({ tabId, clear: z.boolean().default(false).describe('顺便清空已录记录') }),
    output: z.object({ recording: z.boolean(), kept: z.number().int() }),
  },
  'debug.log': {
    description:
      '读取插件内部的事件日志（service worker 启动、alarm 触发、WebSocket 开关等），用于排查断线不重连一类的问题',
    input: z.object({ clear: z.boolean().default(false).describe('读完顺便清空') }),
    output: z.object({
      entries: z.array(
        z.object({
          at: z.string(),
          event: z.string(),
          detail: z.string().optional(),
        }),
      ),
      alarms: z.array(z.object({ name: z.string(), scheduledTime: z.number() })),
    }),
  },
  'page.eval': {
    description: '在页面上下文里求值一段 JS 表达式，返回可 JSON 序列化的结果',
    input: z.object({
      expression: z.string().min(1),
      tabId,
    }),
    output: z.object({ value: z.unknown() }),
  },
} as const satisfies Record<string, ActionDef>;

/** input/output 固定是 ZodObject —— server 需要 `.shape` 才能把它直接当 MCP 工具的参数 schema。 */
export interface ActionDef {
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  output: z.ZodObject<z.ZodRawShape>;
}

export type ActionName = keyof typeof ACTIONS;

/** 调用方要传的参数：带默认值的字段可以省略。 */
export type ActionInput<K extends ActionName> = z.input<(typeof ACTIONS)[K]['input']>;

/** 校验之后交给 handler 的参数：默认值已经填好，不再有可选的"其实必填"字段。 */
export type ActionPayload<K extends ActionName> = z.output<(typeof ACTIONS)[K]['input']>;

export type ActionOutput<K extends ActionName> = z.output<(typeof ACTIONS)[K]['output']>;

export const ACTION_NAMES = Object.keys(ACTIONS) as ActionName[];

export function isActionName(value: string): value is ActionName {
  return Object.hasOwn(ACTIONS, value);
}
