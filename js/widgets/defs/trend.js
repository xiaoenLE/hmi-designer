/**
 * trend.js — 波形 控件定义
 *
 * 一个控件一个文件：改这个控件只看这一个文件；新加控件 = 新建一个同类文件 + 在 defs/index.js 里 import 一行。
 * 属性面板 / 工具箱 / 运行态都从 register() 走的注册表读，这里不用管它们。
 *
 * 这个控件是**自绘 canvas**（selfDrawn）：画/采/交互都在 js/runtime/trend.js，
 * 这里只声明「有哪些属性、哪些可绑变量」。
 *
 * 现场增强（属性面板里都能配）：
 *   · 导出 CSV：运行态右上角一个按钮，导出当前缓冲（属性里可关、可改文字，文字进多语言）；
 *   · 双 Y 轴：右轴单独选通道（1 开始的通道号，如 2,4），左右各自量程/刻度，图例给右轴通道标「(右)」。
 *
 * ⚠ 原「XY 曲线」模式已**移除**：X 轴要自己选变量、多对 X/Y、数组描点 → 用独立的「XY 波形」控件。
 *   老工程里残留的 props.mode='xy' / bindings.xVar / autoX / xMin… 一律忽略，照旧按时间轴画（不报错）。
 */
/* 波形 / 趋势图（多通道抓取） */
import { register, rutil } from '../registry.js';
import { tr } from '../../core/i18n.js';
const { escapeHtml } = rutil;

/** 通道只认能画成数的类型（bool 按 0/1 画） */
const NUM_TYPES = ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal'];

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
    autoY: true, yMin: 0, yMax: 100,       // 左纵轴：自动 或 固定范围
    // 双 Y 轴（默认关 = 老行为一个字不变）：右轴通道用 1 开始的通道号，逗号分隔
    dualAxis: false, rightChannels: '', autoY2: true, y2Min: 0, y2Max: 100,
    // 导出 CSV 按钮（运行态右上角）：可关、文字可改（文字走多语言）
    showCsvBtn: false, csvBtnText: '导出 CSV',
    showGrid: true, showLegend: true, lineWidth: 2, decimals: 1, fontSize: 11,
    colors: {},                            // { 变量名: 颜色 } 逐通道改色
    scales: {},                            // { 变量名: {k,b} } 逐通道量程：显示值 = 原值×k+b
  },
  props: [
    { key: 'windowSec', label: '时间窗口', type: 'number', min: 5, max: 600 },
    { key: 'sampleMs', label: '采样周期ms', type: 'number', min: 20, max: 2000 },
    // ⚠ 现场要求：控件属性里保持干净，**不摆说明文字**（只留属性名 label；口径写在本文件注释/文档里）
    { key: 'autoY', label: '纵轴自动', type: 'check', defVal: true },
    { key: 'yMin', label: '纵轴最小', type: 'number' },
    { key: 'yMax', label: '纵轴最大', type: 'number' },
    // ── 双 Y 轴（单独一栏，可折叠）──
    { key: 'dualAxis', label: '双 Y 轴', type: 'check', defVal: false, group: '双 Y 轴' },
    { key: 'rightChannels', label: '右轴通道号', type: 'text', group: '双 Y 轴' },
    { key: 'autoY2', label: '右轴自动', type: 'check', defVal: true, group: '双 Y 轴' },
    { key: 'y2Min', label: '右轴最小', type: 'number', group: '双 Y 轴' },
    { key: 'y2Max', label: '右轴最大', type: 'number', group: '双 Y 轴' },
    // ── 导出 CSV（单独一栏）──
    { key: 'showCsvBtn', label: '显示导出按钮', type: 'check', defVal: false, group: '导出 CSV' },
    { key: 'csvBtnText', label: '按钮文字', type: 'text', group: '导出 CSV', i18n: 'text', defVal: '导出 CSV' },
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
  binding: {
    variables: { types: NUM_TYPES, label: '数据通道（可多选）', max: 8 },
    // ── 可选控制变量（同一栏显示，留空 = 不影响）──
    //   · 启动抓取 / 清除数据：口径见下面 hint（悬停提示，不占面板）。
    //   ⚠ 现场要求：控件属性里不摆说明文字（面板上不出现 hint 行）——
    //     口径挪到输入格的**悬停提示**里（binding 的 hint 只当 title，不占面板）。
    //   ⚠ 原 xVar（XY 模式的 X 轴变量）已随 XY 模式一起移除；老工程残留的 bindings.xVar 忽略。
    startVar: {
      types: ['bool'], label: '启动抓取', group: '控制变量',
      placeholder: '（留空 = 一直抓）',
      hint: '留空（默认）= 这台设备一直抓数据；填了变量 = 它为真才抓（为假时曲线停住，老数据不丢）。',
    },
    clearVar: {
      types: ['bool'], label: '清除数据', group: '控制变量',
      placeholder: '（留空 = 不清）',
      hint: '填了变量 = 它从 0 变 1 那一刻清空曲线一次（一直保持 1 不会反复清，得回 0 再来一次）。',
    },
  },
  actions: [],
  render(w, mode) {
    // ⚠ 别写可选链（w?.props）：hmi-mcp 的静态提取器靠朴素解析器扫 register({...}) 字面量，
    //   遇到 `?.` 会整块解析失败、props 变成空数组（MCP 目录里波形就没有属性了）。
    const p = (w && w.props) || {};
    let html = '<canvas class="trend-cv"></canvas>';
    // 导出按钮只在运行态出现（编辑态不挡拖拽/选中；导出也没意义）
    if (mode === 'run' && p.showCsvBtn === true) {
      const label = tr(p.csvBtnText || '导出 CSV');
      html += `<button type="button" class="trend-csv-btn" tabindex="-1"
        title="导出当前曲线数据为 CSV（UTF-8，Excel 直接打开）"
        style="position:absolute;top:4px;right:6px;z-index:5;padding:2px 8px;
          font:11px 'Microsoft YaHei',sans-serif;line-height:16px;color:#e2e8f0;
          background:rgba(30,41,59,.9);border:1px solid #475569;border-radius:4px;
          cursor:pointer;user-select:none">${escapeHtml(label)}</button>`;
    }
    // .w-trend 是定位容器（按钮贴在控件右上角），宽高 100% 跟 .wd 一致
    return `<div class="w-trend" style="position:relative">${html}</div>`;
  },
});
