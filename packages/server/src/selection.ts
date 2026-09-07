/**
 * "当前正在操作哪个页面"这件事的存放处。
 *
 * 必须放在服务端的模块级单例里：MCP 侧是无状态的（每个请求现建一个 McpServer），
 * 插件侧的 service worker 随时会被回收，两边都存不住。
 */
export class Selection {
  #tabId: number | null = null;

  get current(): number | null {
    return this.#tabId;
  }

  set(tabId: number): void {
    this.#tabId = tabId;
  }

  /**
   * 插件断开时必须清空。标签页 id 只在一次浏览器会话内有效，浏览器重启后同一个 id
   * 很可能指向完全不同的页面 —— 留着旧值会让后续操作静默打到错误的页面上。
   */
  clear(): void {
    this.#tabId = null;
  }
}
