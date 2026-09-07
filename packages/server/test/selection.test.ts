import { describe, expect, it } from 'vitest';
import { applySelection, toolNameFor } from '../src/mcp.ts';
import { Selection } from '../src/selection.ts';

describe('Selection', () => {
  it('初始没有选中任何页面', () => {
    expect(new Selection().current).toBeNull();
  });

  it('清空后回到未选中', () => {
    const selection = new Selection();
    selection.set(7);
    expect(selection.current).toBe(7);
    selection.clear();
    expect(selection.current).toBeNull();
  });
});

describe('选中页面的注入', () => {
  it('没选过时不动参数', () => {
    expect(applySelection('page.snapshot', {}, null)).toEqual({});
  });

  it('选过之后为省略 tabId 的页面动作补上目标', () => {
    expect(applySelection('page.snapshot', {}, 42)).toEqual({ tabId: 42 });
    expect(applySelection('page.click', { selector: '#a' }, 42)).toEqual({
      selector: '#a',
      tabId: 42,
    });
  });

  it('显式传入的 tabId 优先，不会被选中状态劫持', () => {
    expect(applySelection('page.snapshot', { tabId: 9 }, 42)).toEqual({ tabId: 9 });
  });

  it('不给没有 tabId 参数的动作乱塞字段', () => {
    expect(applySelection('tabs.list', {}, 42)).toEqual({});
  });

  it('tabs.select / tabs.activate 的 tabId 是必填，不受选中状态影响', () => {
    expect(applySelection('tabs.select', { tabId: 3 }, 42)).toEqual({ tabId: 3 });
    expect(applySelection('tabs.activate', { tabId: 3 }, 42)).toEqual({ tabId: 3 });
  });
});

describe('MCP 工具名', () => {
  it('把点换成下划线', () => {
    expect(toolNameFor('page.navigate')).toBe('page_navigate');
    expect(toolNameFor('tabs.select')).toBe('tabs_select');
  });
});
