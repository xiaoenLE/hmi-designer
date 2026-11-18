/**
 * trend.js — 波形 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 */
/* 波形 / 趋势图（多通道抓取） */
import { register } from '../registry.js';

register({
  type: 'trend',
  title: '波形',
  sub: '多通道趋势抓取',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="4" y="6" width="28" height="24" rx="3" fill="#0f172a" stroke="#334155"/><path d="M6 24l5-7 4 4 5-9 4 6 6-4" fill="none" stroke="#38bdf8" stroke-width="2" stroke-linejoin="round"/></svg>',
  // 自己用 canvas 逐帧重绘：变量变化时不要重建 DOM（否则画布每帧被销毁重建）
  selfDrawn: true,
  defaults: {
    w: 360, h: 180,
    bgColor: '#0f172a', gridColor: '#1e3a5f', textColor: '#cbd5e1',
    borderColor: '#334155', borderWidth: 1, radius: 6,
    windowSec: 20, sampleMs: 100,          // 时间窗口(秒) / 采样周期(ms)
    autoY: true, yMin: 0, yMax: 100,       // 纵轴：自动 或 固定范围
    showGrid: true, showLegend: true, lineWidth: 2, decimals: 1, fontSize: 11,
    colors: {},                            // { 变量名: 颜色 } 逐通道改色
    scales: {},                            // { 变量名: {k,b} } 逐通道量程：显示值 = 原值×k+b
  },
  props: [
    { key: 'windowSec', label: '时间窗口', type: 'number', min: 5, max: 600 },
    { key: 'sampleMs', label: '采样周期ms', type: 'number', min: 20, max: 2000 },
    { key: 'autoY', label: '纵轴自动', type: 'check', defVal: true },
    { key: 'yMin', label: '纵轴最小', type: 'number' },
    { key: 'yMax', label: '纵轴最大', type: 'number' },
    { key: 'showGrid', label: '显示网格', type: 'check', defVal: true },
    { key: 'showLegend', label: '显示图例', type: 'check', defVal: true },
    { key: 'lineWidth', label: '线宽', type: 'number', min: 1, max: 6 },
    { key: 'decimals', label: '小数位', type: 'number', min: 0, max: 3 },
    { key: 'fontSize', label: '图例字号', type: 'number', min: 9, max: 16 },
    { key: 'bgColor', label: '背景色', type: 'color' },
    { key: 'gridColor', label: '网格色', type: 'color' },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 30 },
  ],
  // 多通道绑定：用 bindings.variables 数组（其它控件是 bindings.variable 单个变量）
  binding: { variables: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal'], label: '数据通道（可多选）', max: 8 } },
  actions: [],
  render() {
    return '<canvas class="trend-cv"></canvas>';
  },
});
