/**
 * defs.js — 控件库入口（**薄壳**）
 *
 * 16 个控件的定义已经拆成 `defs/` 目录下一控件一个文件（见 defs/index.js）。
 * 这个文件保留原路径，只做转出 —— main.js 的 `import './widgets/defs.js'`、
 * README 和测试里的老写法都还指着它，不破。
 *
 *   想加控件 → 在 defs/ 里新建一个文件，再到 defs/index.js import 一行
 *   只想看某个控件 → 直接开 defs/<type>.js
 */
import './defs/index.js';

export { registry, register, ACTION_DEFS, renderWidgetDOM, refreshWidgetBody, rutil } from './registry.js';
