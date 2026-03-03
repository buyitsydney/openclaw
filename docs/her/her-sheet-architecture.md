# Her Sheet Architecture

> 日期: 2026-03-03  
> 状态: 方案已确认可行（docker1 实测通过），待实现

---

## 1. 目标

在 Her 体系中补齐飞书 Sheet（电子表格）单元格级读写能力，满足以下业务目标：

- AI 可以读取指定范围单元格数据（单范围、多范围）。
- AI 可以写入指定范围单元格数据（单范围、多范围）。
- AI 可以在表格中追加新行数据（append）。
- 全流程行为可预测、可验证，不做不确定分支。

---

## 2. 现状结论

当前 upstream 飞书插件已支持 `doc/wiki/drive/perm/bitable`，但不支持 Sheet 单元格读写工具。

- 已有能力:
  - 文档读写（`feishu_doc`）
  - 知识库节点管理（`feishu_wiki`）
  - 云盘文件管理（`feishu_drive`）
  - 权限管理（`feishu_perm`）
  - 多维表格记录读写（`feishu_bitable`）
- 缺失能力:
  - `sheets/v2` 的 `values`、`values_batch_get`、`values_batch_update`、`values_append`

结论：需要新增独立 Sheet 工具层，不能依赖现有工具覆盖该场景。

---

## 3. 官方 API 方案

### 3.1 核心 API 映射

基于飞书开放平台电子表格 API（v2/v3）进行实现：

- 创建表格: `POST /open-apis/sheets/v3/spreadsheets`
- 获取表格元数据（含 sheetId）: `GET /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/metainfo`
- 读取单范围: `GET /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values/{range}`
- 读取多范围: `GET /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values_batch_get`
- 写入单范围: `PUT /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values`
- 写入多范围: `POST /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values_batch_update`
- 追加数据: `POST /open-apis/sheets/v2/spreadsheets/{spreadsheetToken}/values_append`

### 3.2 Her 工具层设计

新增工具：`feishu_sheet`

建议 action：

- `get_meta`: URL 或 token 解析 + 元数据获取
- `read_range`: 读取单范围
- `read_ranges`: 读取多范围
- `write_range`: 写入单范围
- `write_ranges`: 写入多范围
- `append`: 追加数据

参数设计原则：

- 强约束参数，不做模糊推断。
- 范围参数统一使用飞书标准格式：`{sheetId}!A1:B5`。
- 所有错误直接透传飞书错误码与 `msg`，不做 silent fallback。

返回设计原则：

- 原始业务结果 + 精简统计字段（如 `updatedRows`、`updatedColumns`、`updatedCells`）。
- 对读写操作保留 `revision`，用于后续一致性校验。

---

## 4. 测试结论（docker1 实验）

### 4.1 实验环境

- 执行环境: Mac 本地 `carher-1`（docker1）容器
- 调用方式: 容器内直接调用飞书开放平台 REST API
- 鉴权方式: `tenant_access_token`

### 4.2 实验步骤

1. 获取 `tenant_access_token`
2. 创建测试表格
3. 读取 metainfo 获取首个 `sheet_id`
4. 写入 `A1:B2`
5. 读取 `A1:B2` 并做逐值一致性比对
6. append 一行
7. 读取 `A3` 验证 append 结果
8. 读取多范围验证 batch 接口

### 4.3 结果

实验通过，核心结论如下：

- 写入单范围成功，返回更新统计字段（`updatedRows/updatedColumns/updatedCells`）。
- 单范围读取回值与写入值完全一致。
- append 成功，回读目标单元格值完全一致。
- 多范围读取成功，返回范围数量和内容正确。

结论：在 docker1 当前权限与网络条件下，Sheet 读写链路 100% 可行。

---

## 5. 风险

### 5.1 权限风险

- 若租户未授予电子表格相关权限，读写会返回权限错误。
- 风险控制：上线前强制执行 `scopes` 检查与验收脚本。

### 5.2 数据格式风险

- 飞书单元格支持字符串、数值、公式、链接等多类型。
- 若字段类型与值不匹配，会出现写入报错或展示异常。
- 风险控制：参数 schema 明确约束，复杂类型按官方结构透传。

### 5.3 并发写入风险

- 多 Agent 或多请求并发写同一范围时，后写覆盖前写。
- 风险控制：写路径保持幂等接口语义，必要时在调用侧增加串行化约束。

### 5.4 范围编码风险

- `values/{range}` 路径参数需要正确 URL 编码。
- 风险控制：统一编码函数，测试覆盖包含 `!`、`:` 的范围字符串。

---

## 6. TODO

- [ ] 在 `extensions/feishu-her/src/tools/` 新增 `sheet.ts`
- [ ] 在 `extensions/feishu-her/src/tools/index.ts` 注册 `feishu_sheet`
- [ ] 按 action 拆分读写实现（`read_range/read_ranges/write_range/write_ranges/append`）
- [ ] 新增单测文件 `extensions/feishu-her/src/tools/sheet.test.ts`
- [ ] 提供 docker1 一键验收脚本（创建→写入→回读→append→回读）
- [ ] 在 `extensions/feishu-her/skills/feishu/SKILL.md` 补充 Sheet 工具说明
- [ ] 完成一次端到端验收并固化验收 checklist

---

## 7. 决策建议

建议按“先最小可用、再扩展”的顺序推进：

1. 第一阶段只交付 `read_range/write_range/append`（核心闭环）
2. 第二阶段补齐 `read_ranges/write_ranges`
3. 第三阶段再考虑样式、查找替换、图片写入等高级能力

这样可以最快落地可用能力，同时把风险面控制在最小范围。
