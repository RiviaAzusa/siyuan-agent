# Human-in-the-Loop 机制调查

状态: **暂缓 (低优先级)**

## 背景

对于危险工具（`edit_blocks`, `delete_document` 等），需要在执行前让用户确认。

LangGraph 官方的 `interrupt()` 需要 checkpointer 持久化图状态，在浏览器插件环境（JSON 持久化）中难以实现。

## 结论：不用 LangGraph interrupt，用 Promise 挂起代替

agent 的 async generator 在 `await` 时天然挂起，无需序列化状态。

### 实现方案

**tools.ts** — 添加 confirm 机制：

```typescript
let pendingConfirm: ((approved: boolean) => void) | null = null;

export function resolveConfirm(approved: boolean) {
    pendingConfirm?.(approved);
    pendingConfirm = null;
}

async function waitForConfirm(payload: any): Promise<boolean> {
    return new Promise((resolve) => {
        pendingConfirm = resolve;
        window.dispatchEvent(new CustomEvent("siyuan-agent:confirm-request", { detail: payload }));
    });
}
```

危险工具（`edit_blocks` 等）在执行前调用 `await waitForConfirm(...)`:

```typescript
const editBlocksTool = tool(async ({ blocks }) => {
    const approved = await waitForConfirm({ tool: "edit_blocks", blocks });
    if (!approved) return "User cancelled the operation.";
    // ... 实际执行
});
```

**chat-panel.ts** — 监听事件，渲染确认 UI：

```typescript
window.addEventListener("siyuan-agent:confirm-request", (e: CustomEvent) => {
    // 渲染确认弹窗（tool 名称 + 参数预览）
    // 用户点 OK → resolveConfirm(true)
    // 用户点 Cancel → resolveConfirm(false)
});
```

### 优势
- 不需要 checkpoint，不需要序列化
- 页面刷新自然中断（视为取消，合理）
- 符合现有代码风格，改动集中

### 需要标记为危险的工具
- `edit_blocks` — 修改笔记内容
- `delete_document` — 删除笔记（目前未注册，手动启用时需加确认）
- `move_document` — 移动笔记位置
