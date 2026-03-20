# SiYuan Facts Used By This Repo

这份文件只记录当前仓库工具实现里实际依赖到的 SiYuan 本体事实，不记录模型、UI、LangChain 或排障推测。

## 1. 通用返回格式

当前仓库通过 `fetchPost` 调用 SiYuan API，按 `api.md` 的约定，接口返回格式为：

```json
{
  "code": 0,
  "msg": "",
  "data": {}
}
```

- `code = 0` 表示成功
- `data` 的具体结构由接口决定

## 2. 笔记本

### `/api/notebook/lsNotebooks`

当前仓库用它列出笔记本。

仓库里实际读取的字段：

- `id`
- `name`
- `icon`
- `closed`

## 3. 文档树与路径

当前仓库的 `list_documents` 不再直接通过 SQL 枚举文档，而是依赖 SiYuan 的原生文件树 API。

### `/api/filetree/getIDsByHPath`

当前仓库在用户传入人类可读路径 `hpath` 时，先用这个接口把 `hpath` 解析为文档 ID 列表。

请求里实际使用：

- `notebook`
- `path`

返回值当前实现视为：

- `data` 是文档 ID 数组

### `/api/filetree/getPathByID`

当前仓库用它把文档 ID 转成 SiYuan 文件树路径。

当前实现实际依赖返回中的字段：

- `notebook`
- `path`

其中：

- `path` 是内部文件树路径，文档通常以 `.sy` 结尾
- 当前实现会去掉 `.sy` 后再继续列该文档下的子文档

### `/api/filetree/getHPathByID`

当前仓库用它把文档 ID 转回准确的人类可读路径。

请求里实际使用：

- `id`

返回值当前实现视为：

- `data` 是人类可读路径字符串

## 4. 文档列表

### `/api/filetree/listDocsByPath`

当前仓库通过这个接口列出某个文件树路径下的直接子文档。

请求里实际使用：

- `notebook`
- `path`
- `maxListCount`
- `ignoreMaxListHint`

当前实现实际读取返回中 `files` 数组里这些字段：

- `id`
- `name`
- `path`
- `mtime`
- `subFileCount`

其中：

- `name` 当前实现会去掉 `.sy` 后作为文档标题
- `mtime` 当前实现会转成 `YYYYMMDDHHmmss` 字符串作为 `updated`
- `subFileCount` 用来判断是否有子文档以及子文档数量

当前实现的返回控制方式是：

- 当前层先全量获取后本地分页
- 子层级展开时通过 `child_limit` 限制每个节点实际返回的子文档数量

## 5. 读取整篇文档

### `/api/export/exportMdContent`

当前仓库用它读取整篇 Markdown 文档内容。

当前实现实际依赖返回中的字段：

- `hPath`
- `content`

其中：

- `hPath` 表示文档的人类可读路径
- `content` 表示导出的 Markdown 文本

## 6. 全文搜索

### `/api/search/fullTextSearchBlock`

当前仓库使用这个接口做全文搜索。

请求中当前使用的参数包括：

- `query`
- `page`
- `pageSize`
- `types`
- `method`
- `orderBy`
- `groupBy`

当前实现里传入的 `types` 包括：

- `document`
- `heading`
- `paragraph`
- `code`
- `list`
- `listItem`
- `blockquote`

当前仓库实际读取搜索结果中的字段：

- `id`
- `rootID`
- `content`
- `hPath`
- `type`

同时也读取搜索结果统计字段：

- `matchedBlockCount`
- `matchedRootCount`
- `pageCount`

## 7. 读取文档子块

### `/api/block/getChildBlocks`

当前仓库用它读取某个文档的直接子块。

当前实现实际读取这些字段：

- `id`
- `type`
- `subType`
- `markdown`
- `content`

当前仓库的处理方式是：

- 优先取 `markdown`
- 没有时退回 `content`

## 8. 编辑块时依赖的事实

### `/api/block/getBlockKramdowns`

当前仓库用它读取待编辑块的原始内容，键是 block ID。

### `/api/block/getBlockTreeInfos`

当前仓库用它读取块的树信息，实际依赖字段：

- `previousID`
- `parentID`
- `rootID`

### `/api/block/insertBlock`

当前仓库在块有前一个兄弟块时，用它插入新的 Markdown 块。

请求里实际使用：

- `data`
- `dataType = "markdown"`
- `previousID`

### `/api/block/prependBlock`

当前仓库在块没有前一个兄弟块时，用它把新的 Markdown 块插到父块最前面。

请求里实际使用：

- `data`
- `dataType = "markdown"`
- `parentID`

### `/api/block/deleteBlock`

当前仓库在插入新块后，再删除旧块。

请求里实际使用：

- `id`

## 9. 追加块

### `/api/block/appendBlock`

当前仓库使用它向目标文档或块追加 Markdown。

请求里实际使用：

- `data`
- `dataType = "markdown"`
- `parentID`

当前实现从返回值里继续读取：

- `doOperations[0].id`

## 10. 新建、移动、重命名文档

### `/api/filetree/createDocWithMd`

当前仓库用它创建文档。

请求里实际使用：

- `notebook`
- `path`
- `markdown`

### `/api/filetree/moveDocsByID`

当前仓库用它移动文档。

请求里实际使用：

- `fromIDs`
- `toID`

### `/api/filetree/renameDocByID`

当前仓库用它重命名文档。

请求里实际使用：

- `id`
- `title`

## 11. 当前仓库里关于 SiYuan 的最小事实集合

如果只保留当前工具实现直接依赖的最小事实，可以收敛成下面几条：

1. 笔记本通过 `/api/notebook/lsNotebooks` 获取
2. 文档树通过 `filetree` 相关接口而不是直接 SQL 枚举
3. 用户可见路径使用 `hpath`，内部列树路径使用 `path`
4. 整篇文档 Markdown 通过 `/api/export/exportMdContent` 获取
5. 文档子块通过 `/api/block/getChildBlocks` 获取
6. 全文搜索通过 `/api/search/fullTextSearchBlock` 获取
7. 块编辑依赖 `previousID`、`parentID`、`rootID`
8. 文档创建、移动、重命名分别走 `filetree` 相关接口
