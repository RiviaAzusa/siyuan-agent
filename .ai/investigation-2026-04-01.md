# Transparent Window Freeze Bug — Investigation 2026-04-01

## Symptom
- SiYuan (Electron) 窗口变完全透明，只剩 macOS 左上角 traffic light 按钮
- 应用卡死无响应，只能强制退出
- 100% 复现路径：发送消息、定时任务执行、立即执行

## 环境
- macOS (Darwin), SiYuan Electron
- SiYuan BrowserWindow 配置: `transparent: "darwin" === process.platform` (electron/main.js:270)
- Electron: `nodeIntegration: true`, `contextIsolation: false`, `webSecurity: false`
- 插件 bundle 包含 `require("node:async_hooks")` (LangChain 依赖)

## 根因分析

### 关键发现: 未处理的 Promise Rejection

所有三条崩溃路径都有一个共同模式——从同步事件处理器调用 async 函数时使用 `void` 丢弃 Promise：

```typescript
// 发送按钮
sendBtn.onclick = () => { void this.send(text); };

// 定时任务
void this.drainQueue();
void this.processDueTasks();

// 设置/任务视图
void this.saveForm();
void this.render();
```

**`void` 会丢弃 Promise，导致其中任何 rejection 都变成 unhandled rejection。**

在 Electron renderer 进程中 (`nodeIntegration: true`), unhandled rejection 的行为与浏览器不同:
- 浏览器: 仅 console warning
- Electron renderer with nodeIntegration: 可能触发 Node.js 的 unhandledRejection 行为，导致进程崩溃
- 窗口 `transparent: true` 时: renderer 崩溃后 native 窗口壳还在（traffic lights 可见），但 web content 消失 → 表现为"透明+卡死"

### `send()` 的具体问题

`send()` 内部有 try/catch，但在 try 之前有大量可能抛异常的代码:

```typescript
async send(text: string) {
    // 这些在 try 之前，抛错 = unhandled rejection
    const config = getConfig();           // 可能抛
    this.mergeState(...);                 // 可能抛
    // ... DOM 操作 ...

    try {
        // agent 执行
    } catch (e) {
        // 只能捕获 try 块内的错误
    }
}
```

### 定时任务的具体问题

```typescript
enqueueRun(taskId) {
    this.queue.push(taskId);
    void this.drainQueue();  // ← 整个执行链的错误全部丢失
}
```

`drainQueue()` → `executeTask()` → `executeTaskInner()` → `makeAgent()` → `runAgentStream()`
整条链路的任何异常都不会被捕获。

## 修复方案

### 1. `guard()` 方法 — 统一 fire-and-forget 错误处理

在每个有 fire-and-forget 调用的类中添加:

```typescript
private guard(p: Promise<unknown>): void {
    p.catch(e => console.error("SiYuan Agent:", e));
}
```

替换所有 `void this.xxx()` 为 `this.guard(this.xxx())`。

### 2. 全局安全网

在 `index.ts` onload() 中添加:

```typescript
this._onUnhandledRejection = (ev: PromiseRejectionEvent) => {
    ev.preventDefault();
    console.error("SiYuan Agent: unhandled rejection", ev.reason);
};
window.addEventListener("unhandledrejection", this._onUnhandledRejection);
```

`onunload()` 中清理 listener。

### 3. 定时任务特殊处理

```typescript
// Before
void this.drainQueue();
void this.processDueTasks();

// After
this.drainQueue().catch(e => console.error("SiYuan Agent: drainQueue error", e));
this.processDueTasks().catch(e => console.error("SiYuan Agent: processDueTasks error", e));
```

## 修改的文件

| 文件 | 改动 |
|------|------|
| `src/ui/chat-panel.ts` | 添加 `guard()`, 替换 ~15 处 `void` 调用 |
| `src/index.ts` | 添加 `guard()` + 全局 unhandledrejection listener |
| `src/core/scheduled-task-manager.ts` | `void` → `.catch()` 3 处 |
| `src/ui/settings-view.ts` | 添加 `guard()`, 替换 ~15 处 `void` 调用 |
| `src/ui/tasks-view.ts` | 添加 `guard()`, 替换 ~7 处 `void` 调用 |

## 排除的可能原因

以下在历史调查中已排除:
- GC 压力测试 — 未复现 (archive/transparent_bug/diagnostic-mode.ts)
- FormData / font / localStorage — 未复现
- structuredClone — bundle 中仅 1 处使用
- node:async_hooks — 作为 external 引入，LangChain 标准用法

## 后续观察

如果修复后仍偶发，可进一步排查:
1. LangChain/OpenAI SDK 内部是否有未 catch 的 rejection
2. `__includeRawResponse = true` (ChatQwen) 是否在某些响应下触发异常
3. 考虑将 LLM 调用移到 Web Worker 隔离 renderer
