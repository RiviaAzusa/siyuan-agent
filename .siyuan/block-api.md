# SiYuan Block API Reference

思源笔记 Kernel API 中与 Block 相关的接口汇总。
源码位置: `/Users/azusa/projects/research/siyuan/kernel/api/`

## 核心概念

### Block 结构
```
Block {
  ID       string    // 块 ID, 格式: "20230512083858-mjdwkbn"
  Box      string    // 笔记本 ID
  Path     string    // 文件路径
  HPath    string    // 人类可读路径
  RootID   string    // 文档根块 ID
  ParentID string    // 父块 ID
  Type     string    // 类型: NodeDocument, NodeHeading, NodeParagraph, NodeList, ...
  SubType  string    // 子类型: h1-h6 等
  Content  string    // 渲染后文本
  Markdown string    // Markdown 内容
  IAL      map       // Inline Attribute List (自定义属性)
}
```

### Block 类型缩写 (用于 getChildBlocks 返回)
| 缩写 | 全称 | 说明 |
|------|------|------|
| d | NodeDocument | 文档 |
| h | NodeHeading | 标题 (subType: h1-h6) |
| p | NodeParagraph | 段落 |
| l | NodeList | 列表 |
| li | NodeListItem | 列表项 |
| b | NodeBlockquote | 引用 |
| c | NodeCodeBlock | 代码块 |
| t | NodeTable | 表格 |
| s | NodeSuperBlock | 超级块 |
| m | NodeMathBlock | 数学公式 |
| html | NodeHTMLBlock | HTML 块 |
| av | NodeAttributeView | 属性视图 (数据库) |

### 内容格式
- **Kramdown**: 思源内部格式, 带 IAL 标记 `{: id="..." updated="..."}`
- **Markdown**: 标准 Markdown, `updateBlock` 的 `dataType:"markdown"` 使用
- **DOM**: 思源私有 HTML 格式, `<div data-node-id="..." data-type="NodeParagraph">`

---

## 读取 API

### /api/block/getChildBlocks
获取容器块的直接子块列表。

```json
POST { "id": "文档块ID" }
Response: [{ "id": "块ID", "type": "p", "subType": "", "content": "纯文本", "markdown": "Markdown内容" }]
```

### /api/block/getBlockKramdown
获取单个块的 Kramdown 内容。

```json
POST { "id": "块ID", "mode": "md" }
Response: { "id": "块ID", "kramdown": "Kramdown内容(含IAL)" }
```
- `mode`: `"md"` (标准) 或 `"textmark"` (span标签格式)

### /api/block/getBlockKramdowns
批量获取多个块的 Kramdown 内容。

```json
POST { "ids": ["id1", "id2", ...] }
Response: { "id1": "kramdown1", "id2": "kramdown2", ... }
```
- 不存在的 ID 不会出现在返回 map 中 (不报错)

### /api/block/getBlockDOM
获取块的 HTML DOM。

```json
POST { "id": "块ID" }
Response: { "id": "块ID", "dom": "<div data-node-id=...>...</div>" }
```

### /api/block/getBlockInfo
获取块元信息。

```json
POST { "id": "块ID" }
Response: { "box": "笔记本ID", "path": "/路径.sy", "rootID": "文档ID", "rootTitle": "文档标题", "rootChildID": "首子块ID", "rootIcon": "图标" }
```

### /api/block/getTailChildBlocks
获取容器块的最后 N 个子块。

```json
POST { "id": "块ID", "n": 7 }
Response: [ChildBlock, ...]
```

### /api/block/getBlockBreadcrumb
获取块的路径面包屑。

```json
POST { "id": "块ID", "excludeTypes": [] }
Response: [{ "id", "name", "type", "subType", "children" }]
```

### /api/block/getBlockSiblingID
获取兄弟块 ID。

```json
POST { "id": "块ID" }
Response: { "parent": "父ID", "previous": "前一个ID", "next": "下一个ID" }
```

---

## 写入 API

### /api/block/updateBlock
更新单个块内容。

```json
POST { "id": "块ID", "data": "新内容", "dataType": "markdown" }
Response: { "doOperations": [...], "undoOperations": [...] }
```
- `dataType`: `"markdown"` 或 `"dom"`
- 文档块 (type=d) 的更新会删除所有子块再重建

### /api/block/batchUpdateBlock
批量更新多个块。

```json
POST { "blocks": [{ "id": "块ID", "data": "内容", "dataType": "markdown" }] }
```
- 原子操作: 全部成功或全部失败

### /api/block/insertBlock
在指定位置插入块。

```json
POST { "data": "内容", "dataType": "markdown", "parentID": "父ID", "previousID": "前一个兄弟ID" }
```
- `previousID` 和 `nextID` 用于定位, 至少需要一个

### /api/block/appendBlock
追加块到父块末尾。

```json
POST { "data": "Markdown内容", "dataType": "markdown", "parentID": "父块ID" }
```

### /api/block/prependBlock
在父块开头插入块。

```json
POST { "data": "内容", "dataType": "markdown", "parentID": "父ID" }
```

### /api/block/deleteBlock
删除块。

```json
POST { "id": "块ID" }
```

### /api/block/moveBlock
移动块到新位置。

```json
POST { "id": "块ID", "parentID": "新父ID", "previousID": "新前兄弟ID" }
```

### /api/block/foldBlock / unfoldBlock
折叠/展开块。

```json
POST { "id": "块ID" }
```

---

## 批量 API

| 端点 | 操作 |
|------|------|
| `/api/block/batchInsertBlock` | 批量插入 |
| `/api/block/batchAppendBlock` | 批量追加 |
| `/api/block/batchPrependBlock` | 批量前插 |
| `/api/block/batchUpdateBlock` | 批量更新 |

格式: `{ "blocks": [{ ... }] }`, 每个 block 参数同对应单块 API。

---

## 属性 API

### /api/attr/getBlockAttrs
```json
POST { "id": "块ID" }
Response: { "id": "...", "updated": "...", "custom-key": "value", ... }
```

### /api/attr/setBlockAttrs
```json
POST { "id": "块ID", "attrs": { "custom-key": "value" } }
```

### /api/attr/batchGetBlockAttrs / batchSetBlockAttrs
批量版本, 接收 `ids` 数组 / `blockAttrs` 数组。

---

## 导出 API

### /api/export/exportMdContent
导出文档为 Markdown。

```json
POST { "id": "文档ID" }
Response: { "hPath": "人类路径", "content": "Markdown内容" }
```
- 不保留 block ID, 返回纯 Markdown
- 可选参数: `refMode`, `embedMode`, `yfm`, `addTitle`

---

## 查询 API

### /api/query/sql
执行 SQL 查询 blocks 表。

```json
POST { "stmt": "SELECT * FROM blocks WHERE type='d' AND box='notebook_id' ORDER BY updated DESC LIMIT 50" }
Response: [Block, ...]
```

blocks 表重要字段: `id`, `parent_id`, `root_id`, `box`, `type`, `content`, `markdown`, `hpath`, `created`, `updated`

### /api/search/fullTextSearchBlock
全文搜索。

```json
POST {
  "query": "关键词",
  "page": 1, "pageSize": 10,
  "types": { "document": true, "heading": true, "paragraph": true, ... },
  "method": 0,   // 0=关键词 1=查询语法 2=SQL 3=正则
  "orderBy": 0,  // 0=相关度 1=创建时间升 ... 7=内容降
  "groupBy": 0   // 0=不分组 1=按文档分组
}
Response: { "blocks": [...], "matchedBlockCount": N, "matchedRootCount": N, "pageCount": N }
```

---

## 事务 API

### /api/transactions
底层事务接口, 前端编辑器直接使用。

```json
POST {
  "session": "会话ID",
  "app": "应用ID",
  "transactions": [{
    "doOperations": [{ "action": "update", "id": "块ID", "data": "HTML DOM" }],
    "undoOperations": [{ "action": "update", "id": "块ID", "data": "旧HTML DOM" }]
  }]
}
```

操作类型: `update`, `insert`, `appendInsert`, `prependInsert`, `delete`, `move`, `setAttrs`, `foldHeading`, `unfoldHeading`

**注意**: 高级接口 (`updateBlock` 等) 内部封装了事务, 插件开发优先使用高级接口。

---

## 笔记本 API

### /api/notebook/lsNotebooks
```json
POST {}
Response: { "notebooks": [{ "id", "name", "icon", "sort", "closed" }] }
```

### /api/notebook/openNotebook / closeNotebook
```json
POST { "notebook": "笔记本ID" }
```

---

## 注意事项

- 所有写入 API 需要非只读模式
- Block ID 格式: `YYYYMMDDHHMMSS-7位随机` (如 `20230512083858-mjdwkbn`)
- Kramdown 格式含 IAL, updateBlock 用 `dataType:"markdown"` 会自动转换
- 文档块 update 会重建所有子块 (慎用), 编辑单块用对应块 ID
- `getBlockKramdowns` 返回 map, 不存在的 ID 静默忽略
