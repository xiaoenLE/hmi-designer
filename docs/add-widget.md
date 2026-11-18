# 新增控件 / 手写 .hmiw.json —— 完全指南

两条路，先分清你要哪条：

| 你想要什么 | 走哪条 | 要不要改代码 | 落点 |
|---|---|---|---|
| **一个新的控件类型**（全工程都能拖、能出现在控件栏） | [Part A](#part-a-新增一个控件类型写代码) 写一个 `defs/<type>.js` | 要（一个新文件 + index 一行） | `js/widgets/defs/` |
| **一套现成的控件**（别人做好的 / 脚本批量生成的），不改代码 | [Part B](#part-b-手写一个-hmiwjson) 手写或生成 `.hmiw.json` | 不要 | 画布空白处右键 → 导入控件包 |

> 还常有第三种需求：「把现在画面上这块搬到别的工程」。那个不用看这份文档 ——
> 选中控件 → 右键 →「导出为控件包…」，对方导入即可（见 [widget-pack.md](widget-pack.md)）。

---

# Part A. 新增一个控件类型（写代码）

## A0. 先想清楚三件事

写代码之前先把这三个问题答了，后面全是填表格：

1. **类型名 `type` 叫什么？** —— 这是**永久 id**：存进工程 JSON、决定外层 CSS 类名 `wd-<type>`。
   ⚠ 一旦有工程用过它，**就不能再改**（改了老工程里那个控件会因为 `registry.get()` 拿不到定义而变成「未知控件」占位）。
   小写、用英文/数字/下划线，例：`bar`、`gauge`、`tankLevel`。
2. **用户要在右侧属性面板上调什么？** —— 这就是 `props` 数组（最小/最大/颜色/单位/小数位…）。
3. **它长什么样？** —— 这就是 `render(w, mode, vars)`，返回一段 HTML 字符串。

## A1. 三步建好

```bash
# 第 1 步：新建 js/widgets/defs/<type>.js，照抄一个最像的改
# 第 2 步：在 js/widgets/defs/index.js 里加一行 import（位置 = 它在控件栏里的位置）
# 第 3 步：刷新编辑器页面（F5）—— 零构建、no-store，不用重启服务
```

`defs/index.js`：

```js
import './select.js';
import './bar.js';          // ← 就这一行。放哪排哪
import './alarmBar.js';
```

刷新后：**左侧控件栏出现它** → 拖到画布 → **右侧属性面板自动长出你定义的那几行** →
绑变量就有数了。`properties.js` / `toolbox.js` / `runtime.js` / `project.js` **一行都不用改**。

## A2. def 的字段清单

```js
register({
  type: 'bar',            // 必填。永久 id（见 A0）
  title: '棒图',           // 必填。控件栏显示名；属性面板那栏标题也用「<title> 属性」
  sub: '按变量比例填充（可超限变色）',   // 控件栏副标题，一句话说清它是干嘛的
  icon: '<svg viewBox="0 0 36 36" …></svg>',   // 控件栏图标（SVG 字符串，尺寸按 36×36 画）
  hidden: false,          // true = 不进控件栏，但**老工程里的实例照样渲染**（value/input 就是这么留的）
  defaultBind: false,     // true = 新建时自动绑变量表第一个变量（按钮/数值是 true）
  selfDrawn: false,       // true = canvas 逐帧自绘，变量变化时**不重建 DOM**（波形那样，见 A5.6）
  defaults: { … },        // 见 A2.1
  props: [ … ],           // 见 A3（属性面板 schema）
  binding: { … },         // 见 A4
  actions: [ … ],         // 见 A7
  render(w, mode, vars) { … },   // 见 A5
});
```

### A2.1 `defaults` —— 新控件的初值

```js
defaults: { w: 200, h: 28, min: 0, max: 100, unit: '', barColor: '#22c55e' },
```

* **`w` / `h` 是几何**，会被拿出来放进控件自己的 `w`/`h` 字段，**不进 `props`**；
  其余所有键**原样拷进新实例的 `props`**（`project.addWidget` 干的）。
* ⚠ **`defaults` 里的键 = 新建控件的 `props` 初值**，所以它必须和 `props[].key`、`render` 里读的
  `w.props.xxx` **三处对齐**。只在 `defaults` 里、`props` 里没写的键 → 值存在但**面板上改不了**；
  只在 `props` 里、`defaults` 里没写的键 → 新建时是 `undefined`，靠 `defVal` 和 render 里的兜底显示。

## A3. `props` —— 属性面板 schema（一行一条，顺序就是面板顺序）

每条是 `{ key, label, type, …修饰 }`：

| `type` | 面板上长什么样 | 该条常用字段 |
|---|---|---|
| `text`（默认，也可不写） | 单行输入框 | `defVal` `defFrom` |
| `number` | 数字输入框（带上下限与步进） | `min` `max` `defVal` |
| `color` | 色块 + **「透明」按钮**（清空 = 透明，全工程统一约定：空串表示透明） | — |
| `check` | 勾选框 | `defVal`（新旧工程缺键时按它显示勾选态） |
| `select` | 下拉框 | `options: [{ v: '值', t: '显示文字' }]` |
| `textarea` | 多行文本（表格的「内容」那种） | `rows`（默认 5）`placeholder` `defFrom` |
| `image` | 地址输入 + 「选图」+ 预览 + 清除（选图会内嵌成 data:） | — |
| `dtype` | 数据类型下拉 + 小数位（**和变量表联动**，数值类控件专用） | — |
| `stateColors` | 每个选项一个色块（配合 `parseOptions(w.props.items)`，写回选项行末尾） | 一般配 `uiOnly: true` |

**通用修饰字段**（哪种 type 都能加）：

| 字段 | 作用 |
|---|---|
| `label` | 面板上的中文标签（不写就用 `key` 自动转） |
| `group: '状态显示'` | 这一条**单独成一栏可折叠**（按钮的「状态显示」就是这么分出来的） |
| `hint: '…'` | 面板上这一行**下面**加一句灰色小字说明 |
| `showVarType: 'notBool'` | 绑的变量是 **bool 或没绑**时**这一行不显示**（比较符/比较值用；bool 直接开/关不需要比较） |
| `defVal` | 工程里缺这个键时，面板显示什么（`check`/`number` 最常用） |
| `defFrom` | 缺键时**回落另一个键**的值（如 lamp 的 `offText` 回落旧的 `text`） |
| `uiOnly: true` | **这一行不存进 `w.props`** —— 它只是面板里的自绘编辑器（如 `stateColors` 写回的是 `items`）。生成给 AI 的控件库目录时会跳过它 |

## A4. `binding` —— 能绑哪些变量

```js
// 单变量控件（绝大多数）
binding: { variable: { types: ['int', 'real'], label: '绑定变量' } },

// 多通道控件（波形那种，固定 N 路）
binding: { variables: { types: ['int', 'real'], label: '数据通道', max: 8 } },

// 纯显示/装饰控件（矩形、文本、时钟…）
binding: null,
```

`types` 可用的类型字符串：
`bool` `int` `uint` `dint` `udint` `real` `lreal` `string`
以及数组：`bool[]` `int[]` `uint[]` `dint[]` `udint[]` `real[]` `lreal[]` `string[]`

* 面板里给变量候选表标「类型不匹配」用它；**列表里没有的类型照样能选**（会标红提示）。
* `binding: null` = 这个控件不出「数据绑定」那一栏。
* ⚠ 数值类控件**必须把数组类型也列上**：OPC UA 导进来的数组变量（`int[]`）绑上去时，
  下拉按类型过滤，没列数组的话当前绑定会被滤掉、面板显示「（未绑定）」。

## A5. `render(w, mode, vars)` —— 长什么样

### A5.1 签名与返回

* `w` = 控件数据（**属性面板里改的值都在 `w.props`**，绑定在 `w.bindings`，动作在 `w.actions`）
* `mode` = `'edit'`（组态画布）/ `'run'`（运行态）
* `vars` = 变量运行值（用 `varValue(w, vars)` 取，别自己翻 `w.bindings`）
* **返回 body 的 `innerHTML` 字符串**

> 编辑态和运行态**共用这一个函数** —— 所以它俩长得一模一样（所见即所得）。
> 想区分就判 `mode`（例：`input` 控件组态时把 `<input>` 加 `disabled`）。

### A5.2 取变量值

```js
const { escapeHtml, varValue, stateVarOf } = rutil;   // 文件顶部先解构
const v = varValue(w, vars);      // 绑定变量当前值；没绑/没值 → null
const sv = stateVarOf(w);         // 「状态变量」：优先显式绑定，**没绑但动作里有变量就用那个**
                                  // （点动按钮最常用的配法就是只配动作变量）
```

### A5.3 一定要转义 + 一定要兜底

```js
escapeHtml(String(用户填的文字))       // 不加，用户名字里一个引号就把 DOM 打坏
p.borderWidth ?? 1                    // 老工程缺这个键 → 用默认值（这套代码的固定风格）
```

### A5.4 变量一变会自动重画

运行态按 `stateVarOf(w)` 建「变量名 → 控件」索引（`runtime.js`），绑了变量就自动刷新，
**不用写任何代码**。只有 canvas 自绘的控件例外 —— 给它加 `selfDrawn: true`，
避免重建 DOM 把画布毁掉（`refreshWidgetBody` 会跳过它，由它自己逐帧重绘）。

### A5.5 常见写法示例（节选，完整见 `defs/bar.js`）

```js
render(w, mode, vars) {
  const p = w.props;
  const v = varValue(w, vars);
  const num = (v === null || v === undefined || v === '') ? null : Number(v);
  const min = Number.isFinite(+p.min) ? +p.min : 0;
  const max = Number.isFinite(+p.max) ? +p.max : 100;
  const span = (max - min) || 1;                        // 防 0：别除出 Infinity
  const pct = num === null ? 0 : Math.max(0, Math.min(100, ((num - min) / span) * 100));
  const text = num === null ? (mode === 'edit' ? '未绑定变量' : '--')
                            : `${num.toFixed(Math.max(0, Math.min(6, +p.decimals || 0)))}${p.unit || ''}`;
  return `<div class="w-bar" style="background:${p.bgColor || 'transparent'}">
    <i class="w-bar-fill" style="width:${pct.toFixed(1)}%"></i>
    <span class="w-bar-txt">${escapeHtml(text)}</span></div>`;
}
```

### A5.6 特殊情况

| 情况 | 怎么做 |
|---|---|
| canvas 逐帧自绘（图表/波形） | `selfDrawn: true`，render 只返回 `<canvas class="xxx-cv"></canvas>`，自己起定时器画 |
| 运行态要能"点进去输入" | 得去 `runtime.js` 里**按 type 挂钩子**（`w.type === 'input'` / `'number'` 是硬编码的），光写 def 不够 |
| 控件要读运行态引擎的数据（报警时钟之类） | 内置报警控件是从 `js/runtime/alarms.js` 取的，时钟是 `widgets/clock.js` 的定时器统一刷新 |
| 值的显示要和"读回来的"一致 | 浮点别用 `String(v)`（`12.34567928314209` 会整条露出来），用 `fmtValue(v, numberFmtOf(p))` |

## A6. CSS —— 外观写在 `css/widgets.css`

```css
/* 外层 .wd / .wd-body 由注册表自动加，别自己加定位 */
.w-bar { position: relative; width: 100%; height: 100%; overflow: hidden; box-sizing: border-box; }
```

⚠ **类名请用 `.w-<type>`**（或 `.wd-<type>`，那是外层自动加的）。
因为导出控件包时，`pack.js` 就是靠这两个前缀从样式表里挑规则 —— 用别的名字，**样式不会跟着包走**。

## A7. `actions` —— 要能点击/带动作就填

```js
actions: ['tap', 'toggle', 'gotoPage', 'setValue'],   // 允许这个控件配哪些动作
actions: [],                                          // 纯显示控件 → 属性面板不出「动作」栏
```

可用的动作类型（定义在 `registry.js` 的 `ACTION_DEFS`）：

| 动作 | 参数 |
|---|---|
| `tap` | 点动（按住 = TRUE / 松开 = FALSE）· `variable` |
| `toggle` | 切换（点击翻转保持）· `variable` |
| `setValue` | 置变量值 · `variable` + `value` |
| `gotoPage` | 跳转页面 · `page` |
| `showPopup` | 打开弹窗 · `page` |
| `hidePopup` | 关闭弹窗 |
| `back` | 返回上一页 |
| `clearAlarm` | 清空报警记录 |
| `exitPerm` | 退出权限（锁定） |

**属性面板的动作编辑器、运行态的动作执行都是通用的** —— 新控件只填这个数组，不用写代码。
（动作里配的变量要和 `binding.variable` 同源时，用户可以在面板上勾「变量与状态显示的变量一致」。）

## A8. 抄哪个：现有 17 个控件索引

| 想做什么 | 抄这个文件 |
|---|---|
| 纯装饰（矩形/圆/图片） | `defs/rect.js` `defs/circle.js` `defs/image.js` |
| 纯文本/数值显示 | `defs/label.js` `defs/number.js` |
| 带状态显示的按钮 | `defs/button.js`（`group:'状态显示'` 分栏的样板） |
| 多项选择 + 状态色 | `defs/select.js`（`stateColors` / `uiOnly` / `options` 的样板） |
| 画表格 | `defs/table.js`（`textarea` 多行属性 + 数组填充） |
| 时钟（定时刷新） | `defs/clock.js` + `js/widgets/clock.js` |
| 报警三件套 | `defs/alarmBar.js` `defs/alarmList.js` `defs/alarmHistory.js` + `defs/alarmShared.js` |
| canvas 逐帧自绘 | `defs/trend.js` + `js/runtime/trend.js` |
| **最小可抄的完整样板（进度条）** | **`defs/bar.js`** |
| 隐藏兼容控件怎么写 | `defs/value.js` `defs/input.js`（`hidden: true`） |

## A9. 收尾两条命令（别漏）

```bash
# 1) 控件库基线：加了控件是有意改动 → 重建基线（否则护栏会报"和基线不一致"）
node test/verify-widget-split.mjs --update

# 2) MCP 控件库目录：是快照，不自动跟（不跑的话 AI 不知道有这个控件、属性名校验也会说没有）
node ../hmi-mcp/tools/extract-catalog.mjs
node ../hmi-mcp/tools/extract-catalog.mjs --check       # 和现有 catalog.json 比一比
```

## A10. 常见坑（照症状查）

| 症状 | 原因 | 改法 |
|---|---|---|
| 控件栏里没有它 | 文件没建 / `index.js` 没 import / 浏览器没刷新 | 三步重走一遍；控制台看有没有 404 |
| 属性面板上**少了一行** | `props` 里没写这一条 | `props` / `defaults` / render 三处对齐 |
| 面板上有这行，但改了**画布不变** | 那条属性的 `key` 和 render 里读的键**不一致** | 对齐 `key` |
| 控件是**一块空白** | render 抛异常了（少 import / 用了没定义的变量） | 看控制台；用 `test/verify-widget-split.mjs` 跑一遍，它会逐个控件两态渲染 |
| 数字/文字显示 `NaN` `undefinedpx` | 老工程没有这个键，读出来是 `undefined` | 每个键 `?? 默认值` 兜底 |
| 用户填的文字把布局打坏 | 没 `escapeHtml` | 所有插进 HTML 的用户文本都转义 |
| 绑了变量但**不跟着变** | 没走 `stateVarOf` / 或加了 `selfDrawn` 却指望自动重建 | 用 `rutil.stateVarOf(w)` 建索引才会被刷新 |
| 浮点显示一整条尾巴 | `String(v)` 直接拼 | `fmtValue(v, numberFmtOf(p))` |
| 导出的控件包**样式丢了** | 类名不是 `.w-<type>` / `.wd-<type>` | 按 A6 改名 |
| 面板整块渲染不出来（点了控件没反应） | render **之外**的属性面板代码抛了异常（如没绑变量时无脑取字段） | 见 `properties.js` 里的注释：拼模板串前先判空 |

## A11. 已固化在代码里的两条硬规矩

1. **`type` 是永久 id**：已经在工程里用过的类型不要删/改名。真要淘汰 → 改成 `hidden: true` 留着兼容渲染。
2. **工程里出现"没有定义的控件类型"不会炸了**：画布上画成橙色斜纹「⚠ 未知控件 + 类型名」占位
   （选得中、删得掉），属性面板会说清原因和办法。这是兜底，不是给你随便删类型的许可。

---

# Part B. 手写一个 .hmiw.json

## B0. 什么时候该手写

* 用**脚本批量生成**（几十个点位各一块面板）
* 从**别的系统/Excel/表格**导出转换
* 想给某人一份"能直接导入就有一套画面"的东西（演示、模板、交付包）

> **但注意**：手写最容易漏 `props`（见 B4.3）。能用设计器做的，就"摆一遍 → 选中 → 导出"，
> 那份包和你手写的格式**完全一致**，拿它当模板改最稳。

## B1. 整体结构

下面只是**结构示意**（`…` 是占位，不能直接当文件用；能直接抄的完整例子在 B6）：

```jsonc
{
  "app": "hmi-designer",
  "kind": "widgets",
  "version": 1,
  "exportedAt": "2025-10-04T07:00:00.000Z",
  "projectName": "示例（工位A）",
  "canvas": { "w": 1024, "h": 600 },
  "widgets":   [ … ],     // 要导进去的控件（B3）
  "variables": [ … ],     // 它们用到的变量（B4）
  "defs":      [ … ],     // 【可选】自定义控件定义（B5）—— 不带就是"只用内置控件"
  "pageRefs":  { "旧页id": { "name": "主画面", "type": "page" } }
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `app` / `kind` | 建议 | `kind` 必须等于 `"widgets"`，否则导入时会说「这不像控件包（kind=page）」 |
| `version` | 建议 | 现在是 `1` |
| `canvas` | 不必须 | 原工程画布尺寸（导进小画布时做参照；导入位置会夹进画布范围） |
| `widgets` | **必需** | 空数组会被拒：「这个文件里没有控件（找不到 widgets 字段）」 |
| `variables` | 建议 | 不带 → 导入后绑定是空名字，会提示「这些变量包里没有」 |
| `defs` | 可选 | **只有 `widgets` 里出现"本机没有的控件类型"时才需要**；带 `defs` 的包导入时会先弹代码确认框 |
| `pageRefs` | 可选 | 配合 `gotoPage`/`showPopup` 动作：按**页名**重新对上，对不上就清空并提示 |

## B2. 导入时会发生什么（先知道，手写时才好设计）

1. **`defs` 先注册**（这一步会执行 `renderSrc` 里的代码 → 界面会先弹确认框，你点「知道了，导入」才继续）：
   ① 带 `defs` 但没允许代码 → **直接拒绝**；② 定义**和内置类型重名** → 忽略那条并报告；
   ③ 定义**语法错 / 渲染跑不起来** → 拒掉并**回滚**（不留半成品），原因写在报告里。
2. **变量按名字 upsert**：缺的补进变量表（含初值）；同名的**保留你现有的**，地址不一样只提醒不静默改。
3. **控件落在当前页**：id 重新生成（不会撞）、z 排到最上层、整体**+16px** 再夹进画布、
   组关系重新分配（同一次导入的成员仍是同一组）。
4. **跳转/弹窗动作按页名重对**，对不上就清空并提示。
5. **类型没有定义的控件会被跳过**（宁可少一个，也不留一块渲染不出来的空白），并在报告里点名。
6. 整件事**算一步**：`Ctrl+Z` 一次全撤回。

## B3. `widgets[]` 里每个对象

```json
{
  "id": "w_1",
  "type": "button",
  "name": "启停按钮",
  "x": 500, "y": 190, "w": 130, "h": 46,
  "z": 12,
  "locked": false,
  "group": "g1",
  "props": { "text": "启动 / 停止", "fontSize": 15 },
  "bindings": { "variable": "bMachineRun" },
  "actions": [
    { "trigger": "click", "type": "toggle", "params": { "variable": "bMachineRun" } }
  ]
}
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `type` | **是** | 内置类型名，或你 `defs` 里定义的类型。本机没有这个类型 → 这个控件会被跳过 |
| `name` | 建议 | 控件名（清单 / 属性面板显示，查引用时也用） |
| `x` `y` `w` `h` | 建议 | 缺了按 `0 / 0 / 40 / 24` 兜底，位置会很怪 |
| `id` | 可选 | 写什么都不影响（导入时统一换成新 id，不会和现有控件撞） |
| `z` | 可选 | 叠放次序。导入后整批会被排到最上层 |
| `locked` | 可选 | `true` = 导入后在画布上锁住不能拖 |
| `group` | 可选 | 同一次导入里 `group` 相同的算一组（组内一起选中/移动） |
| `props` | **要写全** | 属性值；**缺键就吃不到默认值**，见 B7 |
| `bindings` | 可选 | `{ "variable": "名字" }`（单变量）/ `{ "variables": ["a","b"] }`（波形多通道） |
| `actions` | 可选 | `trigger` 现在只有 `"click"`；`type` 见 A7 那张表；`params` 按类型给 |

> 波形控件的逐通道配色 / 量程放在 **`props.colors` / `props.scales`**（键是变量名），不在 `bindings` 里。

## B4. `variables[]`

```json
{ "name": "rSpindle", "type": "real", "address": "", "value": 1680, "len": 0 }
```

| 字段 | 说明 |
|---|---|
| `name` | 变量名（中文也行，绑定时按名字） |
| `type` | `bool` `int` `uint` `dint` `udint` `real` `lreal` `string`（数组写 `int[]` 这种） |
| `address` | **Modbus**：`%MW100`（字）/ `%MX0.0`（位）/ `%MD50`；**OPC UA**：完整 NodeId。**留空 = 内部变量**（HMI 自己维护，不读不写 PLC —— 演示包建议全用这个，不接 PLC 也能看效果） |
| `value` | 初值（内部变量开机就是这个值；PLC 变量会被通讯读回的值盖掉） |
| `len` | 字符串字符数 / 数组元素个数（其他类型填 0） |
| `retain` | 可选。`true` = **掉电保持**（只对内部变量有意义；值落盘在后端） |

### B4.1 变量名别撞演示工程

演示工程的种子变量是 `bRunCmd` `bRunStatus` `bAlarm` `rSpeed` `rSetSpeed` `iCount`。
同名会"保留现有的"→ 你包里的初值用不上（实测踩过：仪表盘显示的是种子里的 `12.5`→`13`）。

## B5. `defs[]` —— 自定义控件定义（带代码的那部分）

```json
{
  "type": "gauge",
  "title": "仪表盘",
  "sub": "半圆表盘（别人做好的控件）",
  "icon": "<svg viewBox=\"0 0 36 36\" …></svg>",
  "hidden": false,
  "defaults": { "w": 200, "h": 120, "min": 0, "max": 3000, "unit": " m/min", "caption": "主轴转速" },
  "props": [
    { "key": "min", "label": "最小", "type": "number" },
    { "key": "max", "label": "最大", "type": "number" },
    { "key": "unit", "label": "单位", "type": "text", "hint": "显示在数值后面" }
  ],
  "binding": { "variable": { "types": ["int", "real"], "label": "绑定变量" } },
  "actions": [],
  "renderSrc": "render(w, mode, vars) {\n  …\n}",
  "css": ".w-gauge { display:block; width:100%; height:100% }"
}
```

字段含义和 Part A 的 def **一一对应**，只有两点不同：

| def（代码里） | defs[]（JSON 里） | 说明 |
|---|---|---|
| `render` 是函数 | `renderSrc` 是**函数源码字符串** | 见 B5.1 |
| 样式在 `css/widgets.css` | `css` 是字符串 | 导入时注入 `<style id="wd-css-<type>">` |

### B5.1 `renderSrc` 的硬性约束（这是手写包最容易翻车的地方）

1. **必须是函数写法**：`render(w, mode, vars) { … }` 或 `function render(w) { … }`。
   **箭头函数 / async 不支持** → 导入时报「render 源码认不出来（不是函数写法？）」。
2. **形参不超过 6 个**，且都是合法标识符。
3. **没有 `import`**。能用什么全看白名单 —— 这些名字**直接当全局变量用**（不用声明、不用 import）：

```
rutil  varValue  stateVarOf  escapeHtml  fmtValue  numberFmtOf  compareVal
parseOptions  optionIndexByValue  comboMode  contrastTextOn  fmtTime  fmtDate
dayStart  isArrayType  TIME_PRESETS  ARR_TYPES  SCALAR_NUM  splitLines  splitRow
pickTimeFmt  esc  activeAlarms  alarmHistory  historyOfDay  alarmHistoryDay  levelOf
```

4. **语法合法 ≠ 能跑**：引用了白名单外的名字，`new Function` 是能建出来的，
   但**导入时会先"冒烟渲染"一次**（编辑态 + 运行态，用默认属性 + 假变量值）——
   跑不起来就当场拒掉并回滚，报告里写「运行态渲染跑不起来：xxx is not defined」。
5. 里面写的字符串要**自己注意转义**（`renderSrc` 是 JSON 字符串，换行写 `\n`、双引号写 `\"`）。
   👉 所以**手写时建议用单引号拼 HTML**，别用模板字符串（反引号在 JSON 里也要转义，容易错）。

### B5.2 建议：别手写 renderSrc，让脚本生成

`test/demo-pack.mjs` 就是**用设计器自己生成包**的模板（`registerCustomDefChecked` → `addWidget` →
`widgetExportPayload` → 写文件）。它保证：
实例 `props` 齐全、`renderSrc` 转义正确、格式和真实导出**一模一样**。
要批量生成就先跑它，再改里面的 `SPEC` 表。

## B6. 三个可直接抄的完整例子

> 下面三个块都是**完整的包**：整个复制 → 存成 `xxx.hmiw.json` → 画布空白处右键导入，就能用。
> （`test/verify-doc-examples.mjs` 会把这份文档里的 json 块**全部抽出来跑一遍**，所以它们不会失效。）

### B6.1 只用内置控件（导入时不弹代码确认框）

```json
{
  "app": "hmi-designer",
  "kind": "widgets",
  "version": 1,
  "canvas": { "w": 1024, "h": 600 },
  "variables": [
    { "name": "bPump", "type": "bool", "address": "", "value": false },
    { "name": "rLevel", "type": "real", "address": "", "value": 62.5 }
  ],
  "defs": [],
  "pageRefs": {},
  "widgets": [
    { "type": "rect", "name": "底板", "x": 40, "y": 40, "w": 360, "h": 160,
      "props": { "bgColor": "#ffffff", "borderColor": "#c3cbd6", "borderWidth": 1, "radius": 8 } },
    { "type": "lamp", "name": "泵运行", "x": 70, "y": 70, "w": 50, "h": 50,
      "props": { "onColor": "#22c55e", "offColor": "#9ca3af" },
      "bindings": { "variable": "bPump" } },
    { "type": "number", "name": "液位", "x": 140, "y": 78, "w": 150, "h": 34,
      "props": { "unit": " %", "decimals": 1, "fontSize": 16, "textColor": "#1f2329", "bgColor": "#ffffff", "borderColor": "#c3cbd6", "borderWidth": 1, "radius": 4 },
      "bindings": { "variable": "rLevel" } },
    { "type": "button", "name": "启停", "x": 70, "y": 140, "w": 120, "h": 44,
      "props": { "text": "启动 / 停止", "fontSize": 15, "textColor": "#ffffff", "bgColor": "#2563eb", "borderColor": "", "borderWidth": 1, "radius": 7, "showState": true },
      "bindings": { "variable": "bPump" },
      "actions": [{ "trigger": "click", "type": "toggle", "params": { "variable": "bPump" } }] }
  ]
}
```

### B6.2 带一个自定义控件（导入时会弹代码确认框）

在 B6.1 的基础上多了一个 `defs`（`tank` 液位柱）和它的实例。**注意 `props` 写全了** —— 见 B7。

```json
{
  "app": "hmi-designer",
  "kind": "widgets",
  "version": 1,
  "canvas": { "w": 1024, "h": 600 },
  "variables": [
    { "name": "rTankLevel", "type": "real", "address": "", "value": 62.5 }
  ],
  "defs": [
    {
      "type": "tank",
      "title": "液位柱",
      "sub": "竖着的液位（示例自定义控件）",
      "icon": "<svg viewBox=\"0 0 36 36\" width=\"30\" height=\"30\"><rect x=\"13\" y=\"6\" width=\"10\" height=\"24\" rx=\"2\" fill=\"#e5e7eb\"/><rect x=\"13\" y=\"18\" width=\"10\" height=\"12\" fill=\"#38bdf8\"/></svg>",
      "hidden": false,
      "defaults": { "w": 44, "h": 140, "min": 0, "max": 100, "unit": " %", "color": "#38bdf8", "bg": "#e5e7eb" },
      "props": [
        { "key": "min", "label": "最小", "type": "number" },
        { "key": "max", "label": "最大", "type": "number" },
        { "key": "unit", "label": "单位", "type": "text", "hint": "显示在数值后面" },
        { "key": "color", "label": "液位色", "type": "color" },
        { "key": "bg", "label": "柱底色", "type": "color" }
      ],
      "binding": { "variable": { "types": ["int", "uint", "dint", "real", "lreal"], "label": "绑定变量" } },
      "actions": [],
      "renderSrc": "render(w, mode, vars) {\n  const p = w.props;\n  const v = varValue(w, vars);\n  const num = (v === null || v === undefined || v === '') ? null : Number(v);\n  const min = Number.isFinite(+p.min) ? +p.min : 0;\n  const max = Number.isFinite(+p.max) ? +p.max : 100;\n  const span = (max - min) || 1;\n  const pct = num === null ? 0 : Math.max(0, Math.min(100, ((num - min) / span) * 100));\n  const txt = num === null ? (mode === 'edit' ? '未绑定' : '--') : num.toFixed(1) + (p.unit || '');\n  return '<div class=\"w-tank\" style=\"background:' + (p.bg || '#e5e7eb') + '\">'\n    + '<i style=\"height:' + pct.toFixed(1) + '%;background:' + (p.color || '#38bdf8') + '\"></i>'\n    + '<span>' + escapeHtml(txt) + '</span></div>';\n}",
      "css": ".w-tank { position: relative; width: 100%; height: 100%; border-radius: 6px; overflow: hidden; box-sizing: border-box; border: 1px solid #c3cbd6; }\n.w-tank i { position: absolute; left: 0; bottom: 0; width: 100%; display: block; }\n.w-tank span { position: absolute; inset: 0; display: flex; align-items: flex-end; justify-content: center; font-size: 11px; color: #0f172a; padding-bottom: 2px; }"
    }
  ],
  "pageRefs": {},
  "widgets": [
    { "type": "tank", "name": "液位柱1", "x": 80, "y": 60, "w": 44, "h": 140,
      "props": { "min": 0, "max": 100, "unit": " %", "color": "#38bdf8", "bg": "#e5e7eb" },
      "bindings": { "variable": "rTankLevel" } }
  ]
}
```

### B6.3 带页面跳转

```json
{
  "app": "hmi-designer",
  "kind": "widgets",
  "version": 1,
  "canvas": { "w": 1024, "h": 600 },
  "variables": [],
  "defs": [],
  "pageRefs": { "pgOldManual": { "name": "手动", "type": "page" } },
  "widgets": [
    { "type": "button", "name": "去手动页", "x": 40, "y": 40, "w": 110, "h": 42,
      "props": { "text": "手动", "fontSize": 15, "showState": false, "bgColor": "#2563eb", "textColor": "#ffffff", "borderWidth": 1, "borderColor": "", "radius": 7 },
      "actions": [{ "trigger": "click", "type": "gotoPage", "params": { "page": "pgOldManual" } }] }
  ]
}
```

导入时按**页名「手动」**在你工程里找同类型的页对上；找不到就清空那个动作、并在报告里提示。

## B7. ⚠ 手写最容易漏的：实例的 `props` 要写全

`render` 里读 `p.max`，而实例 `props` 里没有 `max` → 只能靠 render 里的 `?? 默认值`，
表现就是"**属性值没生效/显示成默认**"（实测踩过：手写包里 `props` 空着，
仪表盘丢单位、还按 max=100 画）。

规矩：**把 def 的 `defaults`（去掉 `w`/`h`）整份抄进实例的 `props`**，再覆盖要改的那几个。
设计器导出的包永远是这样的（`addWidget` 会拷贝默认值），所以**拿一份导出的包当模板**最省事。

## B8. 导入报错对照表

| 报错 / 提示 | 原因 | 改法 |
|---|---|---|
| 「这不像控件包（kind=page）」 | `kind` 不对 | 改 `"kind": "widgets"` |
| 「这个文件里没有控件（找不到 widgets 字段）」 | `widgets` 缺失/为空 | 检查字段名是不是写成了 `widgets` |
| 「这像是一整份工程文件…」 | 传了整份工程 JSON | 单页用「页面 ▸ 导入页面…」，整工程用「工程 ▾ → 打开」 |
| 「这些控件跳过了（本工程没有对应的控件类型）」 | 包里用了本机没有的类型，而 `defs` 没带/没导成功 | 补上 `defs`，或在弹框里点了取消 |
| 「包里带了内置控件的定义，已忽略」 | 想用假定义顶掉内置类型 | 改个不重名的 `type` |
| 「×××：render 源码认不出来（不是函数写法？）」 | 写了箭头函数/async | 改成 `render(w, mode, vars) { … }` |
| 「×××：运行态渲染跑不起来：yyy is not defined」 | render 里用了白名单外的名字 | 换用白名单里的 helper，或改写逻辑 |
| 「这些变量包里没有，画面上的绑定会空着」 | `variables` 里没带这些名字 | 补进 `variables`（或让对方自己建） |
| 「这些跳转/弹窗的目标页这里没有，已清空」 | `pageRefs` 的名字对不上 | 名字要和目标工程里的页名一致 |

## B9. 导完自查

1. **画面上有没有它**：控件落在当前页（可能被你原有的控件压住 → 它排在最上层）。
2. **控件栏**：包里带 `defs` 的 → 控件栏最下面多出一条（带紫色「**包**」角标）要往下滚；
   只带内置控件的 → 控件栏**不会**多条目（那是"实例"，不是"新类型"）。
3. **变量表**：看新增了哪些（同名的是复用了你现有的）。
4. **点两下**：绑变量的控件动作一下，看数值/颜色跟不跟。
5. **不喜欢就 `Ctrl+Z`**：一次全撤回。

---

# Part C. 参考

## C1. 常用命令

```bash
# 新增/改完控件之后
node test/verify-widget-split.mjs --update          # 重建控件库基线（19 项结构 + 两态渲染 + 基线比对）
node ../hmi-mcp/tools/extract-catalog.mjs           # 刷新 AI 用的控件库目录（快照，不自动跟）
node ../hmi-mcp/tools/extract-catalog.mjs --check   # 只比对，不改

# 控件包相关
node test/verify-widget-pack.mjs                    # 24 项：两层往返、鉴权、冒烟回滚、定义跟工程走、刷新后控件栏
node test/verify-widget-export.mjs                  # 14 项：点菜单→真下载→文件能被导回来（闭环）
node test/demo-pack.mjs                             # 生成示例包（桌面）+ 在干净环境里导一遍验证 + 截图
node test/shot-widget-pack.mjs                      # 出 3 张截图到 docs/
```

## C2. 相关文档

* [widget-pack.md](widget-pack.md) —— 控件包（导出/导入）的功能说明、白名单、已知限制
* 项目根 `README.md` → 「新增一个控件（一控件一个文件）」
* 控件注册表：`js/widgets/registry.js`（`register` / `registry` / `ACTION_DEFS` / `renderWidgetDOM`）
* 控件包机制：`js/widgets/pack.js`（序列化 / `new Function` 重建 / 白名单 / 冒烟测试）
* 属性面板：`js/editor/properties.js`（`renderProp` 就是 A3 那张表的实现）
