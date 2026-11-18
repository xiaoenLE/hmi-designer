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
import './rect.js';
import './circle.js';
import './image.js';
import './table.js';
import './select.js';
import './bar.js';              // 棒图（进度条）—— 放在下拉框后面、报警条前面
import './alarmBar.js';
import './alarmList.js';
import './alarmHistory.js';
import './trend.js';

// ⚠ 上面这一串 import **全部执行完**之后才轮到这两行 —— 把内置的 16 种类型记成「内置快照」：
//   之后导入控件包时，包里跟内置重名的定义一律拒绝（不许别人用假控件顶掉真控件）。
import { markBuiltins } from '../pack.js';
markBuiltins();
