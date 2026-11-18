// 按钮：点动/切换/跳页…；身上的文字和底色**跟着状态显示走**（满足/未满两态）
// —— 面板上不再有单独的「文本」「背景色」「状态显示」三行：前两行跟「未满文字/未满底色」是同一回事，
//    「状态显示」这个勾也取消了（一直启用）。没绑变量/没读到值时按「未满」那一态画。
//    ⚠ 老工程兼容：旧 text/bgColor 会迁到 offText/offColor，并继续镜像写回；
//      showState:false 已不再代表静态按钮，所有按钮都按变量条件显示满足/未满两态。
import { register, rutil } from '../registry.js';
const { escapeHtml, stateVarOf } = rutil;
import { compareVal } from '../../core/utils.js';
import { tr } from '../../core/i18n.js';

register({
  type: 'button',
  title: '按钮',
  sub: '点动/切换/状态显示',
  icon: '<svg viewBox="0 0 36 36" width="30" height="30"><rect x="5" y="10" width="26" height="16" rx="4" fill="#2563eb"/><text x="18" y="22" font-size="10" fill="#fff" text-anchor="middle">启停</text></svg>',
  defaults: { w: 110, h: 46, fontSize: 15, textColor: '#ffffff', borderColor: '', radius: 7, borderWidth: 1,
    // 图标（emoji 或图片 URL/dataURL）：显示在文字左边；空 = 纯文字
    icon: '', iconSize: 18,
    holdMs: 0,   // 延迟触发（长按）毫秒数，0 = 点一下立即触发（老工程缺键按 0，行为不变）
    // 状态显示（一直启用）：满足 = 比较条件成立；bool 变量本身为真即满足
    onText: '开', offText: '关', op: '>=', threshold: '1', onColor: '#22c55e', offColor: '#9ca3af' },
  defaultBind: true,   // 新建时默认绑定变量表第一个变量（状态显示与操作变量同源）
  // 新建时**默认勾上**「变量与显示的变量一致」：动作里的变量跟状态变量同源。
  // ⚠ 只作用于**新建**的按钮：老工程里没这个键的控件照旧当没勾（行为一个字不变）。
  defaultFollow: true,
  props: [
    // 状态显示（常开）：文字和底色都取「满足/未满」两态，没有变量/没读到值按未满画
    // showVarType='notBool'：绑定变量为数值/字符串时才显示比较行（bool 直接开/关，无需比较）
    { key: 'onText', label: '满足文字', type: 'text', i18n: 'text' },
    { key: 'offText', label: '未满文字', type: 'text', i18n: 'text' },
    { key: 'op', label: '比较', type: 'select', showVarType: 'notBool', options: [
      { v: '==', t: '== 等于' }, { v: '!=', t: '!= 不等' },
      { v: '>', t: '> 大于' }, { v: '<', t: '< 小于' },
      { v: '>=', t: '>= 不小于' }, { v: '<=', t: '<= 不大于' }] },
    { key: 'threshold', label: '比较值', type: 'text', showVarType: 'notBool' },
    { key: 'onColor', label: '满足底色', type: 'color' },
    { key: 'offColor', label: '未满底色', type: 'color' },
    // 图标：emoji 直接填（如 ▶ ⏹ ⚙），也可以填图片 URL / dataURL（显示在文字左边）
    { key: 'icon', label: '图标', type: 'text' },
    { key: 'iconSize', label: '图标大小', type: 'number', min: 8, max: 96, defVal: 18 },
    { key: 'fontSize', label: '字号', type: 'number', min: 8, max: 72 },
    { key: 'textColor', label: '文字色', type: 'color' },
    { key: 'borderColor', label: '边框色', type: 'color' },
    { key: 'radius', label: '圆角', type: 'number', min: 0, max: 40 },
    { key: 'borderWidth', label: '边框宽', type: 'number', min: 0, max: 8 },
    // 延迟触发（长按）：按住够久才执行动作 —— 启停、清记录这类怕误碰的操作要求「按住 1 秒」。
    // 点动(tap) 同样受这道闸管：按住够久才置 TRUE，中途松手一个字节都不下发，松开立即置 FALSE。
    // ⚠ 这行的说明文字**不在属性面板里显示**（用户要求）：README「按钮延迟触发」那节里都有。
    { key: 'holdMs', label: '延迟触发(ms)', type: 'number', min: 0, max: 60000, defVal: 0 },
  ],
  binding: { variable: { types: ['bool', 'int', 'uint', 'dint', 'udint', 'real', 'lreal', 'string'], label: '状态变量(可选)' } },
  actions: ['tap', 'toggle', 'gotoPage', 'showPopup', 'hidePopup', 'back', 'setValue', 'clearAlarm', 'exitPerm'],
  render(w, mode, vars) {
    const p = w.props;
    const bw = p.borderWidth ?? 1;
    const sv = stateVarOf(w);
    const v = sv ? (vars && vars.get ? vars.get(sv) : undefined) : null;
    // 老键（text/bgColor）当「未满」的兜底：老工程迁移后两者一致；新工程没有这两个键
    const onTxt = p.onText ?? '开';
    const offTxt = p.offText ?? p.text ?? '关';
    const onBg = p.onColor ?? '';
    const offBg = p.offColor ?? p.bgColor ?? '';
    let text;
    let bg;
    if (v === null || v === undefined) {
      text = offTxt;                    // 没变量/没读到值：按「未满」画
      bg = offBg;
    } else {
      // op/threshold 缺键兜底（老工程），与新默认一致
      const active = compareVal(v, p.op ?? '>=', p.threshold ?? '1');
      text = active ? onTxt : offTxt;
      bg = active ? onBg : offBg;
    }
    // 背景色有效性：空串/transparent = 真透明。此前直接拼进 linear-gradient
    // 产生非法 CSS（如 "transparentdd"），整条 background 声明被浏览器丢弃，
    // 回落 .w-btn 的蓝色渐变默认样式 → 「选透明变蓝色」bug
    // ⚠️ bgOn/bgStyle/bd 必须在状态覆盖 bg【之后】计算，否则状态色不生效（第 16 轮回归教训）
    const bgOn = !!bg && bg !== 'transparent';
    const bgStyle = bgOn ? `background:linear-gradient(180deg,${bg}dd,${bg})` : 'background:none';
    // 边框色：显式设置优先；未设置时跟随背景色（背景透明则边框也透明 = 纯文字按钮）
    const bd = p.borderColor || (bgOn ? bg : 'transparent');
    // 图标：图片 URL/dataURL 用 <img>，其它（emoji/字符）按文字画；没有图标时 DOM 与老版本一致
    const iconRaw = String(p.icon == null ? '' : p.icon).trim();
    let iconHTML = '';
    if (iconRaw) {
      const szRaw = Number(p.iconSize);
      const sz = Number.isFinite(szRaw) ? Math.max(8, Math.min(96, Math.round(szRaw))) : 18;
      const isImg = /^(https?:|data:|\/|\.\/|\.\.\/)/i.test(iconRaw);
      iconHTML = isImg
        ? `<img class="w-btn-icon" src="${escapeHtml(iconRaw)}" alt="" style="width:${sz}px;height:${sz}px;object-fit:contain;flex:none;margin-right:5px">`
        : `<span class="w-btn-icon" style="font-size:${sz}px;line-height:1;flex:none;margin-right:5px">${escapeHtml(iconRaw)}</span>`;
    }
    return `<button class="w-btn" type="button" tabindex="-1" style="font-size:${p.fontSize}px;color:${p.textColor};${bgStyle};border:${bw}px solid ${bd};border-radius:${p.radius}px">${iconHTML}${escapeHtml(tr(text))}</button>`;
  },
});
