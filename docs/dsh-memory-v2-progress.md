# dsh-memory v2 执行进度

对照 [dsh-memory-roadmap-v2.md](dsh-memory-roadmap-v2.md)。只记录已验证的事实；未验证的一律标注。

## 阶段 2.1 Host↔Client 通道最小实验

**状态：代码完成，等待重启 DSH 后做界面验证。**

新增内容：

| 文件 | 变化 |
|---|---|
| `packages/dsh-memory/index.js` | 从空壳变为 Host 半边：回环请求守卫、`GET /api/dsh-memory/ping` 路由、`dsh_memory_ping` 工具 |
| `packages/dsh-memory/client.js` | 新增「测试 Host 连接」按钮，区分 404 / 403 / 超时 / 网络错误 |
| `packages/dsh-memory/package.json` | description 去掉误导性的 "read-only" |
| `test/host.test.mjs` | 9 项：路由形状、守卫、方法、工具定义、注册 |
| `test/host-http.test.mjs` | 4 项：真实 socket 上的 200 / 403 / 404 / 405 |

### 已验证（我这边可复现）

- `node --check` 两个文件均通过。
- 三个测试文件共 **28 项全部通过**（原有 15 项 + Host 9 项 + 真实 HTTP 4 项）。
- 真实 socket 验证：回环 + 同源请求返回 JSON 200；伪造 Host 头返回 403；跨站返回 403；未知路径 404；POST 返回 405。
- `apply()` 在缺少服务、注册抛异常、传入 undefined 时都不抛出（启动安全，有测试覆盖）。

### 未验证（必须由重启后的界面确认）

1. DSH 是否真的挂载了这个路由（`webServer.register` 的实际行为）。
2. 页面的同源 `fetch` 是否能通过 DSH 的认证层。
3. 重启后 DSH 是否正常启动。

命令行请求 `/api/dsh-memory/ping` 返回 **401**，这是 Web 服务器认证层在前，说明命令行验证不了路由本身，必须用页面内的按钮验证。

### 一个额外的验证通道

Host 半边还注册了 `dsh_memory_ping` 工具。重启后我可以用 `cordis_inspect_query` 的 `Tool.listTools` 直接看到它是否存在，从而独立确认 Host 已被加载，不必只依赖界面点击。

### 已确认需要重启

重启前查了一次 `Tool.listTools`，返回的几十个工具里**没有** `dsh_memory_ping`。这符合 Cordis 的加载方式：Host 半边在进程启动时加载，文件改动不会热更新（只有 Client 半边的界面会在刷新页面时重新加载）。所以阶段 2.1 的界面验证必须重启 DSH 应用。

## 下一步

重启 DSH → 界面点「测试 Host 连接」→ 再看 `listTools`。两项都通过后进入 2.3 正式迁移设计。
