import { filterVisible, send } from './cdp.ts';

interface AXValue {
  value?: unknown;
}

interface AXProperty {
  name: string;
  value: AXValue;
}

interface AXNode {
  nodeId: string;
  ignored: boolean;
  role?: AXValue;
  name?: AXValue;
  value?: AXValue;
  properties?: AXProperty[];
  childIds?: string[];
  backendDOMNodeId?: number;
}

/**
 * 纯容器角色：本身不携带信息，只会把树撑深。渲染时跳过它们但继续下钻子节点，
 * 这样 `generic > generic > button` 会被压平成一行 button。
 */
const TRANSPARENT_ROLES = new Set([
  'generic',
  'none',
  'presentation',
  'GenericContainer',
  'Section',
  'InlineTextBox',
  'LineBreak',
  'RootWebArea',
  'paragraph',
  'list',
  'listitem',
  'group',
  // StaticText 几乎总是在重复父节点的可访问名（`link "首页" > StaticText "首页"`），
  // 实测能占到整个快照一半的体积。要读正文用 page.text，这里一律不要。
  'StaticText',
  // 表格单元格是**内容**不是控件。API 文档那类页面动辄上千个 cell，实测能让语义快照
  // （65k）反过来比整页纯文本（52k）还大 —— 那就完全失去意义了。
  // 透明角色仍会下钻子节点，所以单元格里的链接、按钮不会丢。要读表格内容请用 page.text。
  'cell',
  'row',
  'rowgroup',
  'columnheader',
  'rowheader',
  'table',
  'LayoutTable',
  'LayoutTableRow',
  'LayoutTableCell',
  'ListMarker',
  'DescriptionList',
  'term',
  'definition',
]);

/** 即使没有可访问名也值得保留 —— 空名的输入框恰恰是模型需要填的那个。 */
const ALWAYS_KEEP_ROLES = new Set([
  'textbox',
  'searchbox',
  'combobox',
  'checkbox',
  'radio',
  'slider',
  'spinbutton',
  'switch',
  'textarea',
]);

const INTERACTIVE_ROLES = new Set([
  ...ALWAYS_KEEP_ROLES,
  'button',
  'link',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'option',
  'tab',
  'treeitem',
  'listbox',
  'menu',
  'menubar',
]);

/** 这几个状态会影响模型的下一步决策，值得占那几个字符。 */
const USEFUL_PROPERTIES = ['disabled', 'checked', 'expanded', 'selected', 'required', 'level'];

function textOf(value: AXValue | undefined): string {
  if (value?.value === undefined || value.value === null) return '';
  return String(value.value).replace(/\s+/g, ' ').trim();
}

export interface SnapshotResult {
  snapshot: string;
  refCount: number;
  /** 因不可见而被滤掉的可交互元素数量，用于判断"是不是滤过头了" */
  hiddenCount: number;
  totalChars: number;
  truncated: boolean;
  /** ref → backendNodeId，供 page.click / page.fill 用 */
  refs: Record<string, number>;
}

export async function buildSnapshot(
  tabId: number,
  includeStructure: boolean,
  maxChars: number,
): Promise<SnapshotResult> {
  const { nodes } = await send<{ nodes: AXNode[] }>(tabId, 'Accessibility.getFullAXTree');

  const byId = new Map<string, AXNode>();
  for (const node of nodes) byId.set(node.nodeId, node);

  const root = nodes[0];
  if (!root)
    return { snapshot: '', refCount: 0, hiddenCount: 0, totalChars: 0, truncated: false, refs: {} };

  const childrenOf = (node: AXNode): AXNode[] =>
    (node.childIds ?? []).flatMap((id) => {
      const child = byId.get(id);
      return child ? [child] : [];
    });

  // 第一遍：收集可交互候选，交给页面统一判活。
  // 必须先收集再批量查：逐个节点同步查会把快照拖成几百毫秒。
  const candidates: number[] = [];
  const collect = (node: AXNode): void => {
    if (
      !node.ignored &&
      INTERACTIVE_ROLES.has(textOf(node.role)) &&
      node.backendDOMNodeId !== undefined
    ) {
      candidates.push(node.backendDOMNodeId);
    }
    for (const child of childrenOf(node)) collect(child);
  };
  collect(root);

  const visible = await filterVisible(tabId, candidates);

  const refs: Record<string, number> = {};
  const lines: string[] = [];
  let refCounter = 0;
  let hidden = 0;

  const render = (node: AXNode, depth: number, parentName: string): void => {
    const role = textOf(node.role);
    const name = textOf(node.name);
    const interactive = INTERACTIVE_ROLES.has(role);

    // 用户看不见、也点不到的元素一律不进快照：它们既是干扰项，又白占上下文
    const usable =
      !interactive || (node.backendDOMNodeId !== undefined && visible.has(node.backendDOMNodeId));
    if (interactive && !usable) hidden++;

    const worthEmitting =
      !node.ignored &&
      !TRANSPARENT_ROLES.has(role) &&
      role !== '' &&
      (name !== '' || ALWAYS_KEEP_ROLES.has(role)) &&
      (includeStructure || interactive) &&
      usable &&
      // 名字和父节点一模一样又不能操作的节点纯属噪音，典型是 `link "X" > image "X"`
      !(name !== '' && name === parentName && !interactive);

    let nextDepth = depth;
    if (worthEmitting) {
      const parts = [`${'  '.repeat(depth)}- ${role}`];
      if (name) parts.push(` "${name}"`);

      // 只有能操作的元素才发 ref：标题之类给了也用不上，白白占字符
      if (interactive && node.backendDOMNodeId !== undefined) {
        const ref = `e${refCounter++}`;
        refs[ref] = node.backendDOMNodeId;
        parts.push(` [ref=${ref}]`);
      }

      const value = textOf(node.value);
      if (value) parts.push(` value="${value}"`);

      for (const property of node.properties ?? []) {
        if (!USEFUL_PROPERTIES.includes(property.name)) continue;
        const raw = property.value?.value;
        if (raw === false || raw === undefined || raw === '') continue;
        parts.push(raw === true ? ` ${property.name}` : ` ${property.name}=${String(raw)}`);
      }

      lines.push(parts.join(''));
      nextDepth = depth + 1;
    }

    // 透明节点不改变缩进层级，也把父名继续往下传，这样多层包裹的重复名字都能被识别出来
    const nextParentName = worthEmitting ? name : parentName;
    for (const child of childrenOf(node)) render(child, nextDepth, nextParentName);
  };

  render(root, 0, '');

  const full = lines.join('\n');
  const truncated = full.length > maxChars;
  return {
    snapshot: truncated ? full.slice(0, maxChars) : full,
    refCount: refCounter,
    hiddenCount: hidden,
    totalChars: full.length,
    truncated,
    refs,
  };
}
