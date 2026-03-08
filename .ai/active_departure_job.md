主动触发功能实现方案
SiYuan 插件没有内置调度器，但实现起来很直接。

核心机制
1. 定时器 (最常用)


// onload() 中启动
this.timerHandle = window.setInterval(async () => {
    await this.runAutoSummary();
}, 24 * 60 * 60 * 1000); // 每天

// onunload() 中必须清理！否则插件禁用后仍会执行
window.clearInterval(this.timerHandle);
2. 事件触发 (更轻量)


// 同步完成后触发（适合"每次同步后做总结"）
this.eventBus.on("sync-end", () => this.runAutoSummary());
3. 可用的事件总线事件

事件	触发时机
sync-end	同步完成后
ws-main	所有内核消息（最底层）
opened-notebook / closed-notebook	笔记本开关
定时自动总结的实现思路

export default class SiYuanAgent extends Plugin {
    private summaryTimer: number | null = null;

    onload() {
        // 启动定时任务
        this.scheduleSummary();
    }

    onunload() {
        if (this.summaryTimer) {
            window.clearInterval(this.summaryTimer);
            this.summaryTimer = null;
        }
    }

    private scheduleSummary() {
        const config = this.data["agent-config"];
        const intervalMs = (config?.summaryIntervalHours ?? 24) * 3600_000;

        this.summaryTimer = window.setInterval(async () => {
            if (!this.shouldRunSummary()) return;
            await this.runAutoSummary();
        }, intervalMs);
    }

    private shouldRunSummary(): boolean {
        // 检查上次运行时间，避免重复执行
        const lastRun = this.data["last-summary-time"] as number | undefined;
        if (!lastRun) return true;
        return Date.now() - lastRun > 23 * 3600_000; // 距上次超过23小时
    }

    private async runAutoSummary() {
        const config: AgentConfig = { ...DEFAULT_CONFIG, ...this.data["agent-config"] };
        if (!config.apiKey) return; // 没配置就跳过

        await this.saveData("last-summary-time", Date.now());

        // 直接调用 Agent（不需要 ChatPanel）
        const agent = createAgent(config, getDefaultTools());
        const result = await agent.invoke({
            messages: [{ role: "user", content: "请总结今天修改过的笔记..." }]
        });

        // 调用 create_document 工具把结果写入笔记
        await fetch("/api/filetree/createDocWithMd", { ... });
    }
}
关键注意事项
onunload() 必须清理所有 timer，否则插件禁用后后台任务仍在跑
需要持久化上次运行时间，用 saveData() / loadData()，避免重启后重复触发
后台 Agent 调用不依赖 ChatPanel，直接调用 agent.invoke() 即可，结果写入笔记
错误要捕获，后台任务出错不会有 UI 反馈，要 console.error 记录
如果需要我实现这个功能，可以告诉我具体的需求（触发频率、总结范围、写入位置等）。