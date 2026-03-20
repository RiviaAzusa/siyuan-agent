## 问题

- 现象：安装插件后，SiYuan 右下角原生 `显示/隐藏停靠栏` 按钮默认态显示异常，呈现为残缺的紫色胶囊；鼠标悬停时会恢复成正常图标。
- 用户反馈：不是单纯遮挡，悬停后原生按钮外观正常，默认态异常。

## 观察与线索

- SiYuan 原生按钮不是 dock item，而是状态栏里的 `#barDock.toolbar__item`。
- 原生按钮图标来自 `#iconDock` / `#iconHideDock`，定义在 SiYuan app resources 的 icon symbols 中。
- 本插件没有重定义 `iconDock` / `iconHideDock`，只新增了 `iconAgent`。
- 在插件代码中，没有直接命中 `#barDock`、`.toolbar__item`、`.status` 的选择器。

## 本次尝试

- 尝试 1：给聊天面板底部操作区右侧增加安全留白，避免 `Send` 与右下角原生按钮重叠。
- 结果：用户确认未解决。

- 尝试 2：把聊天面板从半透明/模糊背景改为更强隔离的实底面板，怀疑是透视或层叠导致默认态异常。
- 结果：未验证通过；已按用户要求撤回本次相关样式修改。

## 后续建议

- 优先在运行态 DevTools 中直接检查 `#barDock` 的 computed styles、stacking context 和实际命中的元素。
- 重点排查默认态与 hover 态在 DOM class、mask、opacity、background、pointer-events 上的差异。
- 也要确认插件 custom tab 打开后，是否改变了状态栏右下区域的覆盖层、裁剪区域或合成层。
