/**
 * defs/index.js — 控件库清单：**只做 import**（顺序 = 工具箱里的排列顺序）
 *
 * 加一个控件：把它的文件放进这个目录，然后在下面 import 一行即可。
 * ⚠ registry 是插入有序的 Map，toolbox.js 按 registry.list() 的顺序排版 ——
 *   想把某个控件排前面就把 import 往上挪，别的什么都不用改。
 */
import './button.js';
import './lamp.js';
import './label.js';
import './value.js';
import './input.js';
import './number.js';
import './clock.js';
import './line.js';            // 直线（分割线 / 边框线：实线、虚线、点线）
import './rect.js';
import './circle.js';
import './image.js';
import './table.js';
import './select.js';
import './bar.js';              // 棒图（进度条）—— 放在下拉框后面、报警条前面
// 纯显示类控件：仪表盘 → 多状态图片 → 计时 → 管道 → 箭头（顺序 = 工具箱里的排列顺序）
import './gauge.js';
import './stateImage.js';
import './timer.js';
import './pipe.js';
import './arrow.js';
import './alarmBar.js';
import './alarmList.js';
import './alarmHistory.js';
import './trend.js';
// XY 波形：多对 X/Y 两两组合 + 数组描点（独立控件，排在波形后面）
import './xyplot.js';
// 交互类控件：滑动条 → 拨动开关 → 多档位（运行态可操作，顺序 = 工具箱里的排列顺序）
import './slider.js';
import './switch.js';
import './multiPosition.js';
// 输入类交互控件：条码输入 → 参数表
import './barcode.js';
import './paramTable.js';
// 配方：查看、应用和独立编辑（后端 /api/recipes）
import './recipe.js';
import './recipeEditor.js';
// 班次产量：总产量 / OK / NG / 每小时计数（运行态每秒采样）
import './shift.js';
import './operations.js';

// ⚠ 上面这一串 import **全部执行完**之后才轮到这两行 —— 把内置的 16 种类型记成「内置快照」：
//   之后导入控件包时，包里跟内置重名的定义一律拒绝（不许别人用假控件顶掉真控件）。
import { markBuiltins } from '../pack.js';
markBuiltins();
