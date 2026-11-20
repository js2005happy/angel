# 成品级办公套件直出（缺口 23）

Genspark AI Slides/Sheets/Docs 与 Manus 的核心卖点是“交成品”：直出可继续
编辑的真 PPTX/XLSX/DOCX，而不是一段文字或一页截图。Nyra 的做法：三个
确定性写出器（纯 TS 手写最小 OOXML，不引重型原生依赖、不引 zip 库），
产出的文件用 Office/WPS 打开能直接编辑；附事实核查（每个数字须有来源，
与证据链同口径）——别家的成品只管“能打开”，Nyra 管“打开了能验证”。

## 用法

```bash
# 先把结构化内容写成 JSON，再导出（内容 JSON 见下一节）
nyra export --format docx --from 内容.json --out out/报告.docx
nyra export --format xlsx --from 内容.json --out out/数据.xlsx
nyra export --format pptx --from 内容.json --out out/路演.pptx
```

也可以在任务里让 agent 直接调 `export_office` 工具（参数与内容 JSON
同结构），写文件照常过审批与独立审查层。

内容 JSON 结构：

```json
{
  "format": "docx",
  "title": "季度总结",
  "blocks": [
    { "kind": "heading", "level": 1, "text": "概览", "source": "证据A" },
    { "kind": "paragraph", "text": "收入 100 万元，增长 20%。", "source": "证据A" },
    { "kind": "bullets", "items": [{ "text": "续费率 95%。", "source": "证据B" }] },
    { "kind": "table", "table": {
      "headers": [{ "value": "指标" }, { "value": "数值" }],
      "rows": [[{ "value": "收入" }, { "value": 100, "source": "证据A" }]]
    } },
    { "kind": "image", "image": "chart.png", "caption": "趋势图" }
  ]
}
```

XLSX 用 `sheets` 代替 `blocks`：

```json
{
  "format": "xlsx",
  "title": "销售表",
  "sheets": [{
    "name": "销售",
    "headers": [{ "value": "产品" }, { "value": "金额" }, { "value": "占比" }],
    "rows": [
      [{ "value": "A" }, { "value": 1000, "format": "currency", "source": "财报" }, { "value": 0.25, "format": "percent", "source": "财报" }],
      [{ "value": "合计" }, { "value": 3000, "formula": "SUM(B2:B2)", "source": "财报" }, { "value": 0.75, "format": "percent", "source": "财报" }]
    ]
  }]
}
```

单元格字段：`value`（字符串或数字）；`source`（来源标注，见事实核查）；
`format`（数值格式：`text` / `number` / `currency` / `percent` / `date`，
`date` 的值写 `YYYY-MM-DD`，写出时转 Excel 日期序列）；`formula`（Excel
公式，如 `SUM(B2:B3)`，`value` 当缓存值）。

PPTX 图片：`images` 里给 `name` 与图片字节 base64（只认 PNG/JPEG，按文件
头识别，不看扩展名）；`blocks` 里用 `{ "kind": "image", "image": "chart.png",
"caption": "趋势图" }` 引用。图片在 PPTX 里占单独一页。

## 三种格式的支持范围

| 能力 | DOCX | XLSX | PPTX |
| --- | --- | --- | --- |
| 标题/段落/列表 | 是 | — | 是（标题页 + 要点页） |
| 表格 | 是（表头加粗 + 灰底） | 是（多表） | 是（表格页） |
| 公式 | — | 是（`formula` + 缓存值） | — |
| 数值格式 | — | currency / percent / date / 常规 | — |
| 图片 | 否（只留一行 `[图片：…]` 文字说明） | — | 是（图片页，按原比例缩放） |
| 事实核查小节 | 文末“事实核查”一节 | 另附“核查”表 | 文末“事实核查”一页 |

写出器用 stored（不压缩）方式写 zip：文件仍是合法 zip，Office 能正常
打开；条目原样存放，测试可直接读回校验。不引 jszip/fflate 等依赖（仓库
此前零 zip 依赖）。

## 事实核查：标“未核实”，不拒绝写出

文件里的每一个数字与断言须能回溯到证据：段落/条目/单元格的 `source`
字段就是来源（证据编号、文件名或链接）。写出前跑一遍核查：

- 有来源的数字 = 已核实；无来源的数字 = 未核实。
- 未核实的数字在正文里标“未核实”：DOCX/PPTX 在段落、条目、单元格文本
  后追加 `（未核实）`；XLSX 里字符串格同样追加，**数值格保持数值类型
  不变**（改成文本就没法求和了），未核实项另附一张“核查”表逐项列出
  （位置、值、状态）。
- DOCX/PPTX 文末另附“事实核查”一节/一页（共几项数字、几项已核实、
  几项未核实）；全部有来源时写“全部数字均有来源”，XLSX 则不附核查表。
- 核查结论进工具返回与 `office_exported` 事件（格式、字节数、已核实/
  未核实数、文件 SHA-256 前 12 位指纹），也进时间线（`nyra timeline`
  能看到）。

为什么是“标”而不是“拒绝写出”：拒绝会让“先出草稿再补来源”的正常流程
走不通；标出来既不拦事、也不让没来源的数字蒙混过关。想关掉正文里的标
记（只留核查小节与事件），在 `config.json` 的 `office` 一节把
`mark_unverified` 设为 `false`。

不计入核查的数字：四位年份（1900–2099，如 2026 年）与 `date` 格式的
日期格（`YYYY-MM-DD`）——它们是时间标注，不是事实断言。

## 审批与路径

- `export_office` 是写操作：进 `MUTATING_TOOLS`、`HOOKED_TOOLS`、
  `SESSION_FILE_TOOLS` 与 `DEFAULT_REVIEWED_TOOLS`，照常走审批与独立
  审查层；队列/定时任务里不自动放行。写前拍影子快照（可 `/restore` 恢复）。
- 路径只允许在工作区内（复用 `workspaceWritePath` 的 containment 与受
  保护路径守卫）；`../` 逃逸直接拒绝。
- 远端后端（`ctx.backend`）不支持导出二进制办公文件，直接报错，请在
  本地运行。
- 单个文件默认上限 10MB（`office.max_bytes`），超了拒绝写出；落盘 0600。

## 已知局限

- 产出的文件未在真 Office/WPS 里打开验证过，只在解析器层面验过
  （zip 结构 + 核心 XML + 条目集合）；复杂版式（母版、图表、动画、
  页眉页脚、批注）本批不支持。
- PPTX 只有一种空白版式：标题页 + 要点页 + 表格页 + 图片页，没有设计
  模板；DOCX 没有页眉页脚。
- XLSX 公式只写公式文本与缓存值，不计算（打开时 Office 会重算）。
- Windows/macOS 真机未验证。
