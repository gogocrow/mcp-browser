# Chrome 插件（`@browser-mcp/extension`）

安装、用法、权限说明、故障排查与错误码，全部在**仓库根目录的 [`README.md`](../../README.md)** ——
那份文档覆盖整条链路（中转服务 + `bx` 命令行 + 本插件），不要在这里再维护一份。

两件最常用的事：

```bash
pnpm build      # 在仓库根目录跑；产物在 packages/extension/dist
```

然后 `chrome://extensions` → 开发者模式 → 「加载已解压的扩展程序」→ 选 `packages/extension/dist`
（**是 `dist`，不是本目录**）。改了代码之后必须回那个页面点 ↻ 手动重新加载，没有捷径。
