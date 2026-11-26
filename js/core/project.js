/**
 * project.js — 工程数据模型（唯一数据源 Single Source of Truth）
 *
 * 数据结构：
 *   meta     { name, canvas:{w,h,bg} }
 *   pages    [{ id, name, type:'page'|'popup'|'base', popupW, popupH, baseId, widgets:[...] }]
 *            type:'base' = **公共底**（页面套用的那一层），普通页面用 baseId 指它
 *            （见下面「公共底」那段说明；底也是页面对象，所以画布/撤销/导出/MCP 全都直接复用）
 *   widgets  [{ id, type, name, x, y, w, h, z, props:{...}, bindings:{variable}, actions:[...] }]
 *   variables[{ name, type:'bool|int|real|string', address, value }]
 *   alarms   [{ id, name, variable, op, value, level, delaySec, enabled, text }]
 *   alarmLevels [{ v, t, color, rank }]   ← 工程自定义报警级别，规则与控件保存级别 ID
 *   scripts  [{ id, name, trig, ms, variable, op, value, code, enabled }]
 *   permissions { enabled, lockAfterMin, levels:[{ id, name, salt, hash, iter }] }
 *              ← 运行态**操作权限**：等级自己配（名字 + 密码，只存哈希）。数组顺序 = 等级高低
 *                （越靠后越高）；控件上用 props.permLevel 记它要哪一级（'' = 不限）
 *   keypad   { mode:'edit'|'replace', label:'var'|'widget'|'none' }
 *              ← 运行态**软键盘**的设置（一处管所有输入控件，见「工程 ▾ → 软键盘设置…」）：
 *                mode  = 起手方式：replace 首键清空重输（**默认**）/ edit 接着原值改（老行为，得显式选）
 *                label = 键盘标题栏显示哪个名字：var 变量名（默认）/ widget 控件名 / none 不显示
 *   layout   { dock:{...} }   ← 编辑器面板布局（哪个面板停在哪、分屏、浮动窗位置）
 *                               跟着工程存/导出：换台机器、新开的浏览器（pywebview 每次
 *                               都是新 profile）打开工程，面板还是你摆的那个样子
 *
 * 约定：
 *   touch()  — 数据变化仅通知刷新（不进撤销栈）
 *   commit() — 数据变化 + 推入撤销栈快照
 *
 * ─────────── 公共底（type:'base'） ───────────
 * 页面上总有一部分东西是「每页都一样」的（底部导航条、标题栏、报警条、logo 底板…）。
 * 公共底就是**写一次、多页共用**的那一层：
 *   · 底本身是一个页面对象（type:'base'），在左区「页面」面板里和页面/弹窗并列，双击就能像
 *     普通页一样编辑控件 —— 复用了画布、撤销、变量、导出、MCP 这一整套，不另起一套机制。
 *   · **普通页面**用 page.baseIds 指它套的底（数组，顺序 = 从下到上，可以叠多层；不套 = 没有这个键）。
 *     `page.baseId` 仍同步成第一层（老版本读新工程还能显示第一层）。弹窗不套底（弹窗有自己的
 *     尺寸和标题栏，坐标系对不上）。
 *   · 渲染顺序：底的控件在**前**（也就是在下面那一层），页面自己的控件盖在上面；
 *     两层的 z 不混着比 —— 底那一层整体加一个偏移量（见 pageLayers()），
 *     免得"底上后画的导航条"把页面内容压住。
 *   · 底上的控件在运行态**照常能点、能亮、能显示变量**（公共导航条就是靠它）；
 *     但在**别的页面**上编辑时点不动（防止误改影响所有页面），双击跳到底页去改。
 *   · 改底 = 所有套用它的页面一起变，这就是"相同的只写一次"的意思。
 */
import { bus } from './eventBus.js';
import { normalizeAlarmLevels } from './alarmLevels.js';
import { genId, deepClone, normAddr, bumpAddr, wordsFor, setProfile,
  protocolOfConfig, profileForProtocol,
  isArrayType, elemTypeOf, arrayLenOf, parseArrayText, isOpcAddr,
  dtypeOfVarType, fmtOfDtype, fmtOfDecimals, isIntDtype, intDecimalsOf, decimalsFromFmt,
  isIdentName, scriptVarPropRe } from './utils.js';
import { registry } from '../widgets/registry.js';
// 控件包（导出/导入别人做好的控件）。pack.js 只依赖 registry/shared/utils，不会绕回 project —— 无环。
import { PACK_KIND, PACK_VERSION, isBuiltin, defToPack, registerPackDefs, registerProjectDefs } from '../widgets/pack.js';
import { history } from './history.js';
// 内置工程模板（一份真工程转出来的，生成文件，别手改；换模板见 tools/gen-demo-project.py）
import { DEMO_PROJECT } from '../data/demo-project.js';

const LS_KEY = 'hmi-designer-project-v1';
/** 脚本触发方式（面板/引擎共用一份，别两处各写一套） */
export const SCRIPT_TRIGS = ['init', 'interval', 'cycle', 'change', 'cond'];
export const SCRIPT_TRIG_CN = {
  init: '进入运行态时一次',
  interval: '定时（每 N 毫秒）',
  cycle: '循环（每个运行周期）',
  change: '变量变化时',
  cond: '变量条件成立时',
};
export { LS_KEY };

/** 软键盘（运行态触摸输入）的起手方式 —— 工程级一处设置，运行态所有输入控件共用 */
export const PAD_EDIT = 'edit';          // 接着原值改（老行为：打开键盘显示当前值，按的键接在后面）
export const PAD_REPLACE = 'replace';    // 首键清空重输（**默认**：打开照样显示当前值，第一个字符键一按就让掉原值）
/** 软键盘标题栏那一行显示哪个名字 */
export const PAD_LABEL_VAR = 'var';      // 变量名（老行为）
export const PAD_LABEL_WIDGET = 'widget'; // 控件名（现场认"线速度设定"比认 Hr_LineSpd 快）
export const PAD_LABEL_NONE = 'none';    // 什么都不显示（现场要求：标题栏只留右上角那个 ✕）
/** 三种标题写法都认（识别不了的一律按变量名 = 老行为） */
export const PAD_LABELS = [PAD_LABEL_VAR, PAD_LABEL_WIDGET, PAD_LABEL_NONE];

/* ─────────── 内置工程模板（首次打开 / 新建 ▾「带示例的演示工程」） ───────────
   模板内容在 js/data/demo-project.js —— **生成文件，别手改**：
   它是一份真工程（页面/变量/报警/脚本/权限/面板布局）转出来的，改模板的唯一方法是
   用设计器改那份工程、保存，再跑 tools/gen-demo-project.py（用法见脚本头部）。
   以前这份演示工程是手写在这个文件里的（单线切割机 3 页），现在换成真工程模板：
   现场开箱看到的就是一套能直接照着改的画面，而不是"示例控件堆"。 */
export const SEED_VERSION = 3;      // ⚠ 换了模板内容就 +1，见下面 staleDemo 的说明

function seedProject() {
  const d = deepClone(DEMO_PROJECT);      // 每次新建/首次打开都是一份独立副本，改一个不影响另一个
  d.meta = {
    ...d.meta,
    // template/seedVersion：这份是内置模板的第几版（换模板后，机器上那份"没人动过的旧模板"要能自动换掉）
    // autoSeed：这份是"没人动过的默认模板"。带着它 → 启动时允许用服务器上那份替换掉
    //   （客户机/PyWebView 每次都是新浏览器，本地只剩"上次自动保存下来的模板"，
    //     不认这个标记就会永远看着模板，以为自己的工程丢了）。用户一改就没了这个标记（见 commit）。
    template: 'demo', seedVersion: SEED_VERSION, autoSeed: true,
  };
  return normalize(d);
}

/** 控件定义里 w/h 是几何字段，不进 props（否则每个控件都多存一份冗余 w/h） */
function propDefaults(def) {
  const { w, h, ...rest } = def.defaults;
  return deepClone(rest);
}

/**
 * 规范化工程数据：补齐缺失字段，避免导入残缺 JSON 时整个界面崩。
 * （只补结构，不臆造内容；返回同一对象引用）
 */
function normalize(data) {
  if (!data || typeof data !== 'object') return seedProject();
  if (!data.meta || typeof data.meta !== 'object') data.meta = {};
  /* 协议/地址模型跟着工程走：工程里记了 meta.plc（连 PLC 时存的那份：protocol + addr_profile）
     就按它恢复「三项协议」的选择 —— TS600 的落盘口径是 protocol:"modbus" + addr_profile:"ts600-modbus-tcp"，
     光看 protocol 会误判成 Modbus；老工程只有 protocol 就按 modbus/opcua 处理。
     什么都没记 → 保持当前选择（后端 /api/plc 那份说了算，别在这儿硬改回 INVT）。 */
  if (data.meta.plc && typeof data.meta.plc === 'object') {
    const proto = protocolOfConfig(data.meta.plc);
    const prof = profileForProtocol(proto);
    if (prof) setProfile(prof, false);   // 工程自带配置：只改内存模型，不算"用户自己选过"
  }
  if (!data.meta.canvas || typeof data.meta.canvas !== 'object') data.meta.canvas = {};
  const c = data.meta.canvas;
  if (!Number.isFinite(+c.w) || +c.w <= 0) c.w = 1024;
  if (!Number.isFinite(+c.h) || +c.h <= 0) c.h = 600;
  if (!c.bg) c.bg = '#f4f5f7';
  if (typeof data.meta.name !== 'string') data.meta.name = 'HMI 工程';
  /* 多语言（画面文字翻译表）：跟着工程走。
     结构：{ default: 默认语言代码（原文所在语言）, langs: [{code,label}], dict: { 语言代码: { 原文: 译文 } } }
     老工程没有这个键 → 不补（界面上「多语言」按"只有默认语言"处理，加了语言才写进来）。 */
  if (data.meta.i18n !== undefined) {
    const s = data.meta.i18n;
    if (!s || typeof s !== 'object') data.meta.i18n = undefined;
    else {
      if (typeof s.default !== 'string' || !s.default) s.default = 'zh-CN';
      if (!Array.isArray(s.langs)) s.langs = [];
      if (!s.dict || typeof s.dict !== 'object') s.dict = {};
      s.langs = s.langs.filter(l => l && typeof l.code === 'string' && l.code && l.code !== s.default)
        .map(l => ({ code: l.code, label: String(l.label || '') }));
      Object.keys(s.dict).forEach(k => {
        if (k === s.default || !s.dict[k] || typeof s.dict[k] !== 'object') { delete s.dict[k]; return; }
        // 译文只留字符串；空译文当"没翻"
        Object.keys(s.dict[k]).forEach(src => {
          const v = s.dict[k][src];
          if (typeof v !== 'string' || !v.trim()) delete s.dict[k][src];
          else s.dict[k][src] = String(v);
        });
      });
    }
  }
  if (!Array.isArray(data.variables)) data.variables = [];
  // 地址统一成 %MW 写法：老工程里的 HR100 / 100 → %MW100（后端两种都认，转过来一张表里就不会混着写）
  data.variables.forEach(v => {
    if (typeof v.address === 'string' && v.address) {
      const norm = normAddr(v.address);
      if (norm !== v.address) v.address = norm;
    }
    // retain：**HMI 内部的掉电保持**（只有无地址的内部变量才有意义，见 varsPanel 的「保持」列）。
    // 只留 true，false/没勾的不写进 JSON —— 变量表几百条，多一个 false 键就是几百份噪音。
    if (v.retain) v.retain = true; else delete v.retain;
  });
  if (!Array.isArray(data.alarms)) data.alarms = [];
  if (data.alarmLevels !== undefined) data.alarmLevels = normalizeAlarmLevels(data.alarmLevels);
  // 操作权限：等级表跟着工程走（密码只存「盐 + 迭代哈希」，不存明文，见 core/sha256.js）
  if (!data.permissions || typeof data.permissions !== 'object') data.permissions = {};
  const pm = data.permissions;
  if (typeof pm.enabled !== 'boolean') pm.enabled = false;
  // 默认**不自动上锁**：解锁后一直有效，只有"刷新/关窗口/退出运行态"或手动「退出权限」才回到未解锁
  // （自动上锁想要就在「权限管理…」里填分钟数）
  if (!Number.isFinite(+pm.lockAfterMin)) pm.lockAfterMin = 0;
  // 「清空报警记录」那一档权限设置**已经去掉**了（现场觉得多余）：报警历史控件里的清空按钮
  // 现在按**那个控件自己的权限等级**拦。老工程里留下的 clearAlarmLevel 顺手清掉，别让人以为还有一处开关。
  if ('clearAlarmLevel' in pm) delete pm.clearAlarmLevel;
  // 老版本留下过一个全局 showBadge（"控件上要不要显示 🔒 角标"）—— 现在角标是**逐控件**管的
  // （控件属性 showPermBadge），这个键没用了，顺手清掉，别让人看着以为还有一处开关
  if ('showBadge' in pm) delete pm.showBadge;
  if (!Array.isArray(pm.levels)) pm.levels = [];
  pm.levels = pm.levels.filter(l => l && typeof l === 'object').map(l => ({
    id: l.id || genId('pm'),
    name: String(l.name || '未命名等级'),
    pw: String(l.pw || ''),          // 混淆过的密码（组态端要能回看，见 core/sha256.js 的 obfuscate）
    salt: String(l.salt || ''),      // 老工程：哈希写法（不再用，但留着还能验）
    hash: String(l.hash || ''),
    iter: Number.isFinite(+l.iter) ? +l.iter : 0,
  }));
  // 编辑器面板布局（dock）跟着工程走；形状由 dock.js 的 normalize() 清洗，这里只保证是个对象
  if (!data.layout || typeof data.layout !== 'object') data.layout = {};
  // 软键盘（运行态触摸输入）的起手方式 + 标题显示哪个名字：跟着工程走（工程 ▾ → 软键盘设置…）
  //   认不出的写法（含**所有老工程**）一律当 replace（按键清空重输）+ 显示变量名 ——
  //   现场默认要"点开就能直接输新的"；老行为（接着原值改）得在对话框里显式选一次才保留
  if (!data.keypad || typeof data.keypad !== 'object') data.keypad = {};
  if (data.keypad.mode !== PAD_EDIT) data.keypad.mode = PAD_REPLACE;
  if (data.keypad.label !== PAD_LABEL_WIDGET && data.keypad.label !== PAD_LABEL_NONE) {
    data.keypad.label = PAD_LABEL_VAR;
  }
  // 脚本：触发方式 + JS 代码（跟着工程存/导出，换台机器照样有）
  if (!Array.isArray(data.scripts)) data.scripts = [];
  data.scripts.forEach(s => {
    if (!s.id) s.id = genId('sc');
    if (!s.name) s.name = '脚本';
    if (typeof s.enabled !== 'boolean') s.enabled = true;
    if (!SCRIPT_TRIGS.includes(s.trig)) s.trig = 'interval';
    if (!Number.isFinite(+s.ms)) s.ms = 1000;
    if (typeof s.variable !== 'string') s.variable = '';
    if (!s.op) s.op = '==';
    if (s.value === undefined) s.value = 1;
    if (typeof s.code !== 'string') s.code = '';
  });
  data.alarms.forEach(a => {
    if (!a.id) a.id = genId('al');
    if (typeof a.enabled !== 'boolean') a.enabled = true;
    if (!a.op) a.op = '>=';
    if (!a.level) a.level = 'alarm';
    if (!Number.isFinite(+a.delaySec)) a.delaySec = 0;
  });
  if (!Array.isArray(data.pages) || !data.pages.length) {
    data.pages = [{ id: genId('pg'), name: '画面1', type: 'page', popupW: 420, popupH: 240, widgets: [] }];
  }
  data.pages.forEach(p => {
    if (!p.id) p.id = genId('pg');
    // 三种页面：page 普通页 / popup 弹窗 / base 公共底（认不出的老写法一律当普通页）
    if (p.type !== 'popup' && p.type !== 'base') p.type = 'page';
    if (!p.name) p.name = p.type === 'popup' ? '弹窗' : p.type === 'base' ? '公共底' : '画面';
    if (!Array.isArray(p.widgets)) p.widgets = [];
    // 只有普通页能套底：弹窗和底自己身上的 baseIds/baseId 一律清掉（避免出现"底的底"这种没定义的层）
    if (p.type !== 'page') { delete p.baseId; delete p.baseIds; }
    p.widgets.forEach(w => {
      if (!w.id) w.id = genId('w');
      if (!w.props || typeof w.props !== 'object') w.props = {};
      if (!w.bindings || typeof w.bindings !== 'object') w.bindings = {};
      if (!Array.isArray(w.actions)) w.actions = [];
      // 下拉框：老的「只显示不可选」勾（readonly）已经变成「操作方式」三选一（operate）——
      // 载入时迁过来并删掉老键，属性面板上就不会出现两处开关各说各话（见 core/utils.js comboMode）
      if (w.type === 'select') {
        if (!['pick', 'type', 'view'].includes(String(w.props.operate || ''))) {
          w.props.operate = w.props.readonly === true ? 'view' : 'pick';
        }
        delete w.props.readonly;
      }
      // 按钮状态显示常开；旧的 text/bgColor 字段迁到未满态，并继续镜像供旧客户端读取。
      // 旧按钮即使显式存了 showState:false，也不再保留静态模式：旧文本作为未满文字，
      // 旧底色作为未满底色，满足态照常由绑定变量和比较条件决定。
      if (w.type === 'button') {
        const bp = w.props;
        // text 是旧工程里未满足态文字的原字段。发现两处不一致时旧字段优先，
        // 随后统一镜像，避免旧字段残留值在下一次载入时覆盖新属性。
        if (typeof bp.text === 'string' && bp.text !== '' && bp.text !== bp.offText) {
          bp.offText = bp.text;
        } else if (bp.offText === undefined && typeof bp.text === 'string') {
          bp.offText = bp.text;
        }
        if (typeof bp.bgColor === 'string' && bp.bgColor !== '' && bp.bgColor !== bp.offColor) {
          bp.offColor = bp.bgColor;
        } else if (bp.offColor === undefined && typeof bp.bgColor === 'string') {
          bp.offColor = bp.bgColor;
        }
        bp.text = bp.offText ?? bp.text ?? '';
        bp.bgColor = bp.offColor ?? bp.bgColor ?? '';
        delete bp.showState;
      }
      /* 数值控件「数据类型」跟着变量走：老工程里控件的 props 还停在新建时的浮点默认
         （dispType:'float' + 小数位 1 + fmt:'%.1f'），绑的却是 int 变量 ——
         面板会显示浮点默认的「小数位 1」、画面上还带 .0，跟整数的默认（0 位）对不上。
         这里按变量类型纠一次（只纠，不缩放：int 走 %d，就是个整数）。
         只动「跟新建默认一模一样」的控件：用户明确设过类型的（比如 dispType:'float' 配 '%.2f'）一律不碰，
         免得把人家特意要的显示格式改掉。 */
      const bvName = typeof w.bindings.variable === 'string' ? w.bindings.variable : '';
      if (bvName && 'dispType' in w.props && w.props.dispType === 'float'
        && (w.props.decimals === undefined || w.props.decimals === 1)
        && (!w.props.fmt || w.props.fmt === '%.1f')) {
        const bv = data.variables.find(x => x && x.name === bvName);
        const bd = bv && dtypeOfVarType(bv.type);
        if (bd && bd !== 'float') applyDtypeToWidget(w, bd);
      }
    });
  });
  // 悬空引用清理 + 老工程升级：baseId（单个）→ baseIds（可叠多层，顺序 = 从下到上）。
  //   · 老工程只有 baseId：迁移成 baseIds=[baseId]；baseId 继续同步成第一层
  //     （这样老版本读新工程也还能显示第一层，不至于一片空白）
  //   · 底被删了 / 别人给的工程指向不存在的底：剔掉，不留悬空 id
  const baseSet = new Set(data.pages.filter(p => p.type === 'base').map(p => p.id));
  data.pages.forEach(p => {
    if (p.type !== 'page') return;
    const raw = Array.isArray(p.baseIds) ? p.baseIds : (p.baseId ? [p.baseId] : []);
    const ids = [];
    raw.forEach(id => { if (id && baseSet.has(id) && !ids.includes(id)) ids.push(id); });
    if (ids.length) { p.baseIds = ids; p.baseId = ids[0]; }
    else { delete p.baseIds; delete p.baseId; }
  });
  // 至少要有一个普通页：运行态得有地方落（全是弹窗/底的话进去就是一片空白）
  if (!data.pages.some(p => p.type === 'page')) {
    data.pages.push({ id: genId('pg'), name: '画面1', type: 'page', popupW: 420, popupH: 240, widgets: [] });
  }
  /* 自定义控件定义（跟着工程走）：**必须在这里就注册进 registry** ——
     画布/运行态渲染都要 registry.get(type).render，没注册的 type 会当场抛异常，
     表现就是"这份工程里有个控件是一块空白、还点不动"。逐条 try：一条坏的不能拖垮整份工程。 */
  if (!Array.isArray(data.customWidgets)) data.customWidgets = [];
  data.customWidgets = data.customWidgets.filter(d => d && typeof d === 'object' && d.type);
  if (data.customWidgets.length) {
    const r = registerProjectDefs(data.customWidgets);
    // 工具箱要重建（加载这份工程之前，列表里没有这些自定义控件）
    if (r.added.length) bus.emit('widgets:defs-changed', { added: r.added });
  }
  return data;
}

/** 把名字结尾的数字加 n（没有数字就补一个 n）：指示灯1 → 指示灯2
 *  数组元素名（arrw[3]，「展开成单个变量」生成的那种）序号在方括号里，
 *  要动括号里的数字：arrw[3] → arrw[4]（不然会变成 arrw[3]1 这种没意义的名字） */
function bumpSeq(name, n) {
  const s = String(name ?? '');
  if (/\[\d+\]$/.test(s)) return s.replace(/\[(\d+)\]$/, (m, d) => `[${Number(d) + n}]`);
  return /(\d+)$/.test(s) ? s.replace(/(\d+)$/, m => String(Number(m) + n)) : s + n;
}
/**
 * 变量类型改了 → 把**绑定它的数值控件**的「数据类型」一起改过来。
 *
 * 为什么必须同步：控件显示格式是按它自己的 dispType 算的（numberFmtOf），
 * 变量改成 real 而控件还写着 int，界面上就还是整数 —— 现场看着就是"改了没生效"。
 * 反方向（在属性面板里改控件的「数据类型」→ 改变量表）由 properties.js 负责，
 * 两个方向最后都落到同一处（变量表），不会各说各话。
 */
/**
 * 把一个数值控件的「数据类型 + 小数位」写成跟变量类型一致（d = dtypeOfVarType）。
 * 改变量类型（syncWidgetDispType）、绑定变量（updateWidgetField）、老工程加载（normalize）三处共用，
 * 保证「控件类型跟着变量走」只有一个实现，不会各改一套。
 */
function applyDtypeToWidget(w, d) {
  if (!w.props) w.props = {};
  const wasInt = isIntDtype(w.props.dispType);
  w.props.dispType = d;
  if (d === 'float' || d === 'lreal') {
    // 小数位优先取控件自己的 decimals；控件只写过 fmt（比如 AI/脚本给 fmt:'%.3f'）
    // 就从 fmt 里反推，别用浮点默认的 1 把人家设的位数盖掉
    if (w.props.decimals === undefined || w.props.decimals === null) {
      w.props.decimals = decimalsFromFmt(w.props.fmt);
    }
    w.props.fmt = fmtOfDtype(d, w.props.decimals);
  } else if (isIntDtype(d)) {
    // 整数：小数位 = 定点缩放位数（fmt 里写了几位）。只在「原来就是整数」时保留（int↔dint 互切不丢缩放）；
    // 从浮点/字符串切过来一律归 0（%d）—— 浮点小数位不是倍率，照搬会让现场数值小 10 倍，
    // 老工程 fmt 本来就是 %d（decimals 里有残留的 1 也不算缩放），升级后显示一个字不变。
    // ⚠ 不写 decimals：整数认的是 fmt（intDecimalsOf），decimals 留着浮点的值，
    //   切回浮点时还是原来那个小数位（老行为不变）。
    w.props.fmt = fmtOfDecimals(d, wasInt ? intDecimalsOf(w.props) : 0);
  } else {
    w.props.fmt = fmtOfDecimals(d, w.props.decimals);
  }
}

function syncWidgetDispType(proj, v) {
  const d = dtypeOfVarType(v.type);
  if (!d) return;                                   // bool / 认不出的类型：控件自己那份不动
  proj.data.pages.forEach(p => p.widgets.forEach(w => {
    if (w.bindings?.variable !== v.name) return;
    const def = registry.get(w.type);
    if (!def?.props?.some(pp => pp.key === 'dispType')) return;   // 只有数值类控件有这个属性
    applyDtypeToWidget(w, d);
    proj.markDirty(w.id);       // 类型/格式变了，这个控件要重画（同一变量绑了多个控件时都得跟着变）
  }));
}

/**
 * 整数控件的小数位 = 定点缩放位数，`fmt` 才是缩放开关（utils.js 的 intDecimalsOf/fixedScaleOf）。
 * 属性面板两条路（改类型 / 改小数位）都自己写 fmt，但 MCP、AI 助手和外部脚本常常只写 decimals
 * 或者只切 dispType —— 漏写 fmt 时整数控件会按 fmt 里的位数缩放，屏上数值差 10 倍。
 * 这里按面板同一套规则补 fmt：
 *   · 只改 decimals（dispType 已是整数）→ 按 decimals 写 %.Nf / %d
 *   · 只把 dispType 切成整数 → 原来是整数就保留缩放位数（int↔dint 互切不丢），从浮点/字符串过来归 0
 */
function syncIntDecimalsFmt(w, key, wasInt) {
  if (!w?.props || !('dispType' in w.props)) return;
  if (!isIntDtype(w.props.dispType)) return;
  if (key !== 'decimals' && key !== 'dispType') return;
  const n = key === 'decimals'
    ? Math.max(0, Math.min(6, Math.round(Number(w.props.decimals) || 0)))
    : (wasInt ? intDecimalsOf(w.props) : 0);
  w.props.fmt = fmtOfDecimals(w.props.dispType, n);
}

function remapKeys(obj, remap) {
  const out = {};
  Object.keys(obj || {}).forEach(k => { out[remap(k)] = obj[k]; });
  return out;
}
/**
 * 复制体的变量引用：给每一份副本算它自己的变量名 + 地址。
 *
 * 名字递增：源名字末尾带数字（bAlarm1→bAlarm2）本来就会递增；没数字的（rSpeed）
 * 默认也递增成 rSpeed1/rSpeed2（varMode='always'），这样「一排控件各自一个变量」才成立；
 * 想让所有副本共用同一个变量就选 varMode='digit'（只有带数字的名字才递增）。
 *
 * 地址递增：新变量地址 = 源变量地址 + addrStep × 第几份；addrStep 给 0 就按类型自动
 * （bool/int 1 个字、real/dint 2 个、lreal 4 个、string 按长度）。
 *
 * autoVar=true → 直接建进变量表（类型/长度/初值照抄源变量）；false → 只记进 missing 让用户自己补。
 * @param {object} opt {n, seqStep, addrStep, autoVar, varMode, vars, created, missing, noAddr}
 *   n = 这是第几份（1、2、3…），seqStep = 名字序号步长（可负），addrStep = 地址间隔（可负，0=按类型）
 */
function remapVars(src, copy, n, opt) {
  const map = {};
  const remap = name => {
    if (!name) return name;
    if (name in map) return map[name];
    const tail = /\d+$/.test(name);
    if (!tail && opt.varMode !== 'always') return name;     // 不带数字就当共用同一个变量
    const out = bumpSeq(name, n * opt.seqStep);
    map[name] = out;
    if (opt.vars.some(v => v.name === out)) return out;     // 已经存在：直接用，不重复建
    const from = opt.vars.find(v => v.name === name);
    if (!from) { opt.missing.add(out); return out; }        // 源变量不在表里 → 推不出类型/地址
    const step = opt.addrStep !== 0 ? opt.addrStep : wordsFor(from.type, from.len);
    const addr = from.address ? bumpAddr(from.address, step * n) : '';
    if (opt.autoVar) {
      opt.vars.push({ name: out, type: from.type, address: addr, len: from.len || 0, value: from.value });
      opt.created.push({ name: out, address: addr, type: from.type, from: name });
      if (from.address && !addr) opt.noAddr.push(out);      // 地址写法认不出（如 DB1.DBD4）→ 得手填
    } else {
      opt.missing.add(out);
    }
    return out;
  };
  if (copy.bindings?.variable) copy.bindings.variable = remap(copy.bindings.variable);
  if (Array.isArray(copy.bindings?.variables)) copy.bindings.variables = copy.bindings.variables.map(remap);
  if (copy.props?.colors) copy.props.colors = remapKeys(copy.props.colors, remap);
  if (copy.props?.scales) copy.props.scales = remapKeys(copy.props.scales, remap);
  // ⚠ 动作里的变量也要跟着改（点动/切换/置值）：以前漏了这一段，
  //   副本按钮看着绑了新变量，一按却在动**原来那一台的**变量 —— 现场直接是事故级误操作。
  (copy.actions || []).forEach((a, i) => {
    const nm = a.params?.variable;
    if (!nm) return;
    const out = remap(nm);
    if (out !== nm) copy.actions[i] = { ...a, params: { ...a.params, variable: out } };
  });
}

/* ─────────── 空白工程（新建用） ─────────── */
function blankProject() {
  return {
    meta: { name: '新建工程', template: 'blank', canvas: { w: 1024, h: 600, bg: '#f4f5f7' } },
    variables: [], alarms: [], scripts: [],
    pages: [{
      id: genId('pg'), name: '主画面', type: 'page',
      popupW: 420, popupH: 240, title: '', showClose: true, widgets: [],
    }],
  };
}

/* ─────────── 工程对象 ─────────── */
const EMPTY_ARR = [];
const widgetZ = widget => Number(widget.z) || 0;

// 层级相同时按页面内的绘制顺序比较，和画布叠放顺序一致。
function widgetsByZ(widgets) {
  return [...widgets].sort((a, b) => widgetZ(a) - widgetZ(b));
}

export const project = {
  data: null,
  currentId: null,   // 当前编辑页 id
  _widCache: null,   // 控件 id 索引缓存（见 _widgetIndex）
  _dirty: new Set(), // 需要重画 DOM 的控件 id
  _synced: new Set(),// DOM 已经是最新的控件 id（拖动这类直接改样式的情况）

  /* ── 加载/替换 ── */
  load() {
    try {
      const s = localStorage.getItem(LS_KEY);
      this.data = s ? JSON.parse(s) : null;
    } catch { this.data = null; }
    // ⚠️ 只有「本地压根没有可用工程」或「本地那份正是**没人动过的旧版内置模板**」才用新种子覆盖。
    // 绝不能凭 meta.seedVersion 缺失就覆盖：导入的 JSON / 读服务器拿到的工程
    // 本来就没有这个键，那样会在刷新后把用户的工程静默换成模板（丢工程）。
    // 判"没人动过"只认 autoSeed —— 用户一改（任何一次 commit）它就没了，所以
    // 动过的工程**永远不会**被模板盖掉；而现场机器上那份原封未动的旧模板，
    // 会在升级到新模板后第一次打开时自动换成新的。
    const unusable = !this.data || !Array.isArray(this.data.pages) || !this.data.pages.length;
    const staleDemo = this.data?.meta?.template === 'demo' && this.data.meta.autoSeed === true
      && (this.data.meta.seedVersion || 0) < SEED_VERSION;
    // 本机浏览器里到底有没有"用户的工程"：没有（全新浏览器 / 清过站点数据 / 换了台机器）
    // 就允许启动时自动从服务器读回来 —— 见 needServerPull() 与 main.js
    this.hadLocal = !unusable && !staleDemo;
    this.data = (unusable || staleDemo) ? seedProject() : normalize(this.data);
    this.currentId = this.data.pages[0].id;
  },
  /**
   * 启动时该不该**自动**从服务器读工程回来？
   *   ① 本机浏览器里压根没有工程（客户机/PyWebView 每次打开都是新的 profile，localStorage 空的）；或
   *   ② 现在这份还是「没动过的默认演示工程」（上次也是空的，只是被自动保存下来了）。
   * 本机有用户自己的工程时**一律不动**（绝不静默覆盖别人的东西）。
   * 两个条件都会在读了服务器工程之后自动消失（工程里没有 autoSeed 标记）。
   */
  needServerPull() {
    return !this.hadLocal || this.data?.meta?.autoSeed === true;
  },
  replaceData(data, { fromHistory = false } = {}) {
    this.data = normalize(data);
    if (!this.pages().find(p => p.id === this.currentId)) this.currentId = this.data.pages[0]?.id;
    this._widCache = null;                                        // 换工程了：控件索引缓存作废
    bus.emit('selection:changed', { ids: [] });                   // 选中的是老工程里的控件，清掉
    bus.emit('page:current', { pageId: this.currentId });
    bus.emit('project:replaced', { data: this.data, fromHistory });             // 打开/新建/恢复：工程整份换掉了
    this.touch();
  },
  /**
   * 新建工程。
   * @param {'blank'|'demo'} [kind] blank = 1 个空白页、变量表空的；demo = 带示例的演示工程
   */
  newProject(kind = 'blank') {
    this.replaceData(kind === 'demo' ? seedProject() : blankProject());
    return this.data;
  },

  /* ── 通知 ── */
  touch() { bus.emit('project:changed'); },
  /** @param {{merge?:boolean}} [opts] 透传给 history.push（连击类操作合并为 1 步撤销） */
  commit(label, opts) {
    // 用户真动过这份工程了 → 摘掉「默认演示工程」标记：
    // 之后启动不会再被服务器上那份替换掉（那是给"新浏览器里什么都没有"准备的）
    if (this.data?.meta) delete this.data.meta.autoSeed;
    history.push(label || '操作', opts);
    this.touch();
  },

  /* ── 页面 ── */
  pages() { return this.data.pages; },
  getPage(id) { return this.data.pages.find(p => p.id === id); },
  currentPage() { return this.getPage(this.currentId); },
  currentWidgets() { return this.currentPage()?.widgets || []; },
  setCurrentPage(id) {
    if (id === this.currentId) return;
    this.currentId = id;
    bus.emit('selection:changed', { ids: [] });
    bus.emit('page:current', { pageId: id });
    this.touch();
  },
  addPage(type) {
    const n = this.data.pages.filter(p => p.type === type).length + 1;
    const page = {
      id: genId('pg'),
      name: type === 'popup' ? `弹窗${n}` : type === 'base' ? `公共底${n}` : `画面${n}`,
      type,
      popupW: 420, popupH: 240,
      title: '', showClose: true,   // 弹窗标题栏配置
      widgets: [],
    };
    this.data.pages.push(page);
    this.setCurrentPage(page.id);
    this.commit('新建页面');
    return page;
  },
  /** 公共底（type:'base'）：可以被普通页面「套用」的那一层 */
  bases() { return this.data.pages.filter(p => p.type === 'base'); },
  /**
   * 这个页面套的**全部**公共底（可叠多层；顺序 = 从下到上，第 1 个在最底下）。
   * 兼容老工程：只有 baseId 的按"单层"处理（normalize 里已经迁成 baseIds）。
   * @param {object|string} pageOrId
   * @returns {Array} 底页面对象数组；没套 / 自己就是底 / 引用悬空 → []
   */
  basesOf(pageOrId) {
    const p = typeof pageOrId === 'string' ? this.getPage(pageOrId) : pageOrId;
    if (!p || p.type !== 'page') return EMPTY_ARR;
    const ids = Array.isArray(p.baseIds) ? p.baseIds : (p.baseId ? [p.baseId] : []);
    const out = [];
    ids.forEach(id => {
      const b = this.getPage(id);
      if (b && b.type === 'base' && !out.includes(b)) out.push(b);
    });
    return out;
  },
  /** 这个页面套的**第一层**公共底（老调用方沿用；要全部用 basesOf） */
  baseOf(pageOrId) {
    return this.basesOf(pageOrId)[0] || null;
  },
  /**
   * 一个页面**实际要画出来的控件**（含它套的全部公共底，按层从下到上）。
   * ⚠ 只给渲染用（编辑画布 / 运行态 / 按页采集变量）。选中、删除、对齐、复制这些
   *   编辑操作一律用 currentWidgets()（只有页面自己的控件）—— 底上的控件不能在别的页面上改。
   * @returns {Array} [底层控件…, 更上面的底控件…, 页面自己的控件…]
   */
  renderWidgets(pageOrId) {
    const p = typeof pageOrId === 'string' ? this.getPage(pageOrId) : pageOrId;
    if (!p) return EMPTY_ARR;
    const bases = this.basesOf(p);
    if (!bases.length) return p.widgets;
    const out = [];
    bases.forEach(b => out.push(...b.widgets));
    out.push(...p.widgets);
    return out;
  },
  /**
   * 页面分层 + 每层的 z 基准：公共底按顺序一层压一层，页面控件压在最上面。
   * 为什么要偏移而不是靠作者写的 z：底上后画的控件 z 会更大（比如底图 rect z=1、导航条 z=30），
   * 直接混着比就会把下面那层压住 —— 现场看到的就是"页面上的东西没了"。
   * @returns {{bases:Array<{base:object, off:number}>, base:object|null, off:number}}
   *          bases = 从下到上的各层（off = 这一层的 z 基准）；base/off 是老调用方的"第一层 / 最上面"简写
   */
  pageLayers(pageOrId) {
    const bases = this.basesOf(pageOrId);
    let off = 0;
    const layers = bases.map(b => {
      const at = off;
      const maxZ = b.widgets.reduce((m, w) => Math.max(m, w.z || 0), 0);
      off = at + maxZ + 1;
      return { base: b, off: at };
    });
    return { bases: layers, base: layers[0]?.base || null, off: layers.length ? off : 0 };
  },
  /** 哪些页面套用了这个底（底页属性面板里显示"被 N 页套用"，删之前也靠它提醒） */
  pagesUsingBase(baseId) {
    return this.data.pages.filter(p => p.type === 'page' && this.basesOf(p).some(b => b.id === baseId));
  },
  /**
   * 给页面设定**整套**公共底（顺序 = 从下到上）。
   * @param {string} pageId 普通页 id
   * @param {string[]} ids 底页 id 列表；空数组 = 全部取消
   * @returns {boolean} 成功与否（目标不是普通页 → false；不存在的/不是底的 id 静默剔掉）
   */
  setPageBases(pageId, ids) {
    const p = this.getPage(pageId);
    if (!p || p.type !== 'page') return false;
    const clean = [];
    (ids || []).forEach(id => {
      if (!id || clean.includes(id)) return;
      const b = this.getPage(id);
      if (b && b.type === 'base') clean.push(id);
    });
    if (clean.length) { p.baseIds = clean; p.baseId = clean[0]; }
    else { delete p.baseIds; delete p.baseId; }
    this.commit(clean.length ? `套用公共底（${clean.length} 层）` : '取消套用公共底');
    return true;
  },
  /** 叠加一层公共底（已经套了就忽略） */
  addPageBase(pageId, baseId) {
    const p = this.getPage(pageId);
    if (!p || p.type !== 'page') return false;
    const ids = this.basesOf(p).map(b => b.id);
    if (!baseId || ids.includes(baseId)) return false;
    return this.setPageBases(pageId, [...ids, baseId]);
  },
  /** 去掉某一层公共底 */
  removePageBase(pageId, baseId) {
    const p = this.getPage(pageId);
    if (!p || p.type !== 'page') return false;
    const ids = this.basesOf(p).map(b => b.id).filter(id => id !== baseId);
    return this.setPageBases(pageId, ids);
  },
  /**
   * 老接口：给页面套用**一个**公共底（会替换掉现有全部层）。
   * @param {string} pageId 普通页 id
   * @param {string} baseId 底页 id；'' = 取消套用
   */
  setPageBase(pageId, baseId) {
    return this.setPageBases(pageId, baseId ? [baseId] : []);
  },
  deletePage(id) {
    if (this.data.pages.filter(p => p.type === 'page').length <= 1 && this.getPage(id)?.type === 'page') {
      return alert('至少保留一个普通页面');
    }
    // 清理其他页面里指向该页的跳转/弹窗动作
    this.data.pages.forEach(p => {
      p.widgets.forEach(w => {
        w.actions = (w.actions || []).filter(a =>
          !((a.type === 'gotoPage' || a.type === 'showPopup') && a.params?.page === id));
      });
    });
    // 删的是公共底 → 套用它那些页面把这一层去掉（不留悬空 id：那会让画布和运行态都查不到底）
    this.data.pages.forEach(p => {
      if (!Array.isArray(p.baseIds) || !p.baseIds.includes(id)) return;
      const next = p.baseIds.filter(b => b !== id);
      if (next.length) { p.baseIds = next; p.baseId = next[0]; }
      else { delete p.baseIds; delete p.baseId; }
    });
    this.data.pages = this.data.pages.filter(p => p.id !== id);
    if (this.currentId === id) this.currentId = this.data.pages[0].id;
    bus.emit('page:current', { pageId: this.currentId });
    this.commit('删除页面');
  },
  updatePage(id, patch) {
    Object.assign(this.getPage(id), patch);
    this.commit('修改页面');
  },

  /* ── 控件 ── */
  addWidget(type, x, y) {
    const def = registry.get(type);
    const page = this.currentPage();
    const maxZ = page.widgets.reduce((m, w) => Math.max(m, w.z), 0);
    const widget = {
      id: genId('w'), type,
      name: `${def.title}${page.widgets.filter(w => w.type === type).length + 1}`,
      x: Math.round(x), y: Math.round(y),
      w: def.defaults.w, h: def.defaults.h,
      z: maxZ + 1,
      locked: false,
      props: propDefaults(def),
      bindings: {}, actions: [],
    };
    // defaultBind：新建时默认绑定变量表第一个变量（状态显示/操作变量同源）
    if (def.defaultBind && this.data.variables?.length) {
      widget.bindings.variable = this.data.variables[0].name;
    }
    // defaultFollow：新建时默认勾上「变量与显示的变量一致」（动作变量跟着显示变量走）。
    // 只在这里落一个新控件的初值 —— 老工程里没这个键的控件照旧当没勾，读进来不会被动改配置。
    if (def.defaultFollow) widget.followBind = true;
    page.widgets.push(widget);
    this.commit('添加控件');
    return widget;
  },
  deleteWidgets(ids) {
    const page = this.currentPage();
    if (!ids.length) return;
    page.widgets = page.widgets.filter(w => !ids.includes(w.id));
    bus.emit('selection:changed', { ids: [] });
    this.commit('删除控件');
  },
  cloneWidgets(ids) {
    const page = this.currentPage();
    const srcs = ids.map(id => page.widgets.find(w => w.id === id)).filter(Boolean);
    return this.pasteWidgets(srcs.map(w => deepClone(w)));
  },
  /**
   * 粘贴控件副本到当前页（跨页粘贴：剪贴板存的是控件数据快照，不是 id）
   * @param {Array<object>} list 控件数据副本
   */
  pasteWidgets(list) {
    const page = this.currentPage();
    if (!page || !list?.length) return [];
    const newIds = [];
    let maxZ = page.widgets.reduce((m, w) => Math.max(m, w.z), 0);
    // 复制过来的整组要成为「新的一个组」：组号重新分配，免得和原件算成同一组
    const gmap = new Map();
    list.forEach(src => {
      const copy = deepClone(src);
      copy.id = genId('w');
      copy.name = (src.name || registry.get(src.type)?.title || '控件') + '_副本';
      copy.x = Math.round((copy.x || 0) + 16);
      copy.y = Math.round((copy.y || 0) + 16);
      copy.z = ++maxZ;
      if (copy.group) {
        if (!gmap.has(copy.group)) gmap.set(copy.group, genId('g'));
        copy.group = gmap.get(copy.group);
      }
      page.widgets.push(copy);
      newIds.push(copy.id);
    });
    bus.emit('selection:changed', { ids: newIds });
    this.commit('粘贴控件');
    return newIds;
  },

  /**
   * 多重复制：把选中的一组控件整体再复制 count 份
   * @param {string[]} ids 源控件（作为一个整体块复制，保持相对布局）
   * @param {{count?:number, mode?:'right'|'down'|'grid'|'cascade', cols?:number,
   *          gapX?:number, gapY?:number, nameSeq?:boolean, varSeq?:boolean,
   *          addrStep?:number, autoVar?:boolean}} [opts]
   *   mode: right=向右排列 / down=向下排列 / grid=网格（cols 列）/ cascade=右下堆叠
   *   nameSeq: 名称末尾数字递增；varSeq: 绑定的变量名末尾数字递增（源名字带序号时才改）
   *   addrStep: 新变量地址往后挪几个寄存器（0/不填 = 按类型自动：bool/16位 1、real/dint 2、lreal 4、string 按长度）
   *   autoVar: 这些新变量直接建进变量表（默认 true）
   * @returns {{ids:string[], missingVars:string[], createdVars:Array<{name:string,address:string,type:string,from:string}>}}
   */
  duplicateWidgets(ids, opts = {}) {
    const page = this.currentPage();
    const srcs = ids.map(id => page.widgets.find(w => w.id === id)).filter(Boolean);
    if (!srcs.length) return { ids: [], missingVars: [], createdVars: [] };
    const count = Math.max(1, Math.min(100, Math.round(opts.count || 1)));
    const mode = ['right', 'down', 'grid', 'cascade'].includes(opts.mode) ? opts.mode : 'right';
    const cols = Math.max(1, Math.min(50, Math.round(opts.cols || 1)));
    const gapX = Number.isFinite(+opts.gapX) ? +opts.gapX : 8;
    const gapY = Number.isFinite(+opts.gapY) ? +opts.gapY : 8;
    // 序号步长：名称和变量名都按它递增；可以填负数（-1 → 序号倒着排 bAlarm5→bAlarm4）
    const seqStep = Number.isFinite(+opts.seqStep) ? Math.round(+opts.seqStep) : 1;
    // 选区外框：整块按 (块宽+间距) 步进，多选复制后仍是一整块
    const blockW = Math.max(...srcs.map(w => w.x + w.w)) - Math.min(...srcs.map(w => w.x));
    const blockH = Math.max(...srcs.map(w => w.y + w.h)) - Math.min(...srcs.map(w => w.y));
    const missing = new Set();
    const created = [];
    const noAddr = [];
    // 变量名/地址递增看的是「变量表」这份副本；自动创建的变量直接推进去（整批一次 commit）
    const vars = this.data.variables;
    const vopt = {
      // 序号步长只管名字；地址间隔只管地址（两者独立，序号填 -1 不会把地址方向也翻过来）
      seqStep,
      addrStep: Number.isFinite(+opts.addrStep) ? Math.round(+opts.addrStep) : 0,   // 0 = 按类型自动；负数 = 地址往前排
      autoVar: opts.autoVar !== false,
      varMode: opts.varMode === 'digit' ? 'digit' : 'always',
      vars, created, missing, noAddr,
    };
    let maxZ = page.widgets.reduce((m, w) => Math.max(m, w.z), 0);
    const newIds = [];
    for (let i = 1; i <= count; i++) {
      const gmap = new Map();          // 每一份副本各自一个独立组号
      let dx = 0, dy = 0;
      if (mode === 'right') dx = i * (blockW + gapX);
      else if (mode === 'down') dy = i * (blockH + gapY);
      else if (mode === 'grid') { dx = (i % cols) * (blockW + gapX); dy = Math.floor(i / cols) * (blockH + gapY); }
      else { dx = i * 16; dy = i * 16; }        // 右下堆叠
      srcs.forEach(src => {
        const copy = deepClone(src);
        copy.id = genId('w');
        copy.x = Math.round(src.x + dx);
        copy.y = Math.round(src.y + dy);
        copy.z = ++maxZ;
        if (opts.nameSeq !== false) copy.name = bumpSeq(src.name, i * seqStep);
        if (opts.varSeq !== false) remapVars(src, copy, i, vopt);
        // 每一份副本各自成组（同一份里的成员共用一个新组号）
        if (copy.group) {
          if (!gmap.has(copy.group)) gmap.set(copy.group, genId('g'));
          copy.group = gmap.get(copy.group);
        }
        page.widgets.push(copy);
        newIds.push(copy.id);
      });
    }
    bus.emit('selection:changed', { ids: newIds });
    this.commit('多重复制');
    return { ids: newIds, missingVars: [...missing], createdVars: created, noAddrVars: noAddr };
  },

  /**
   * 多重复制**页面**：把整页（含页内所有控件）再复制 count 份。
   *
   * 参数和「控件多重复制」同一套（份数 / 名称编号 / 变量名递增 / 地址间隔 / 自动建变量），
   * 只是复制单位从「一组控件」变成「一整页」。每份副本：
   *   · 页名自动编号（主画面 → 主画面2、主画面3…；seqStep 可负，倒着编）
   *   · 页内控件的 id / 组号 / 绑定变量 全部按份号重算（变量名·地址逐份递增）
   *   · 页内「跳转页面 / 打开弹窗」如果指向的是**被复制的页之一**，跟着指到这一份的对应副本
   * @param {string[]} pageIds 源页面 id（可以多页一起复制）
   * @param {{count?:number, seqStep?:number, nameSeq?:boolean, varSeq?:boolean,
   *          addrStep?:number, autoVar?:boolean, varMode?:'always'|'digit'}} [opts]
   * @returns {{pageIds:string[], createdVars:Array, missingVars:string[], noAddrVars:string[]}}
   */
  duplicatePages(pageIds, opts = {}) {
    const srcs = (pageIds || []).map(id => this.getPage(id)).filter(Boolean);
    if (!srcs.length) return { pageIds: [], createdVars: [], missingVars: [], noAddrVars: [] };
    const count = Math.max(1, Math.min(50, Math.round(opts.count || 1)));
    const seqStep = Number.isFinite(+opts.seqStep) ? Math.round(+opts.seqStep) : 1;
    const missing = new Set();
    const created = [];
    const noAddr = [];
    const vopt = {
      seqStep,
      addrStep: Number.isFinite(+opts.addrStep) ? Math.round(+opts.addrStep) : 0,
      autoVar: opts.autoVar !== false,
      varMode: opts.varMode === 'digit' ? 'digit' : 'always',
      vars: this.data.variables, created, missing, noAddr,
    };
    const out = [];
    for (let i = 1; i <= count; i++) {
      const idMap = new Map();          // 源页 id → 这一份副本的页 id（页内跳转跟着改）
      const copies = srcs.map(src => {
        const copy = deepClone(src);
        copy.id = genId('pg');
        if (opts.nameSeq !== false) copy.name = bumpSeq(src.name, i * seqStep);
        const gmap = new Map();         // 每一份副本各自一套新组号，免得和原件算成同一组
        let maxZ = copy.widgets.reduce((m, w) => Math.max(m, w.z), 0);
        copy.widgets = copy.widgets.map(srcW => {
          const w = deepClone(srcW);
          w.id = genId('w');
          w.z = ++maxZ;
          if (opts.nameSeq !== false) w.name = bumpSeq(srcW.name, i * seqStep);
          if (opts.varSeq !== false) remapVars(srcW, w, i, vopt);
          if (w.group) {
            if (!gmap.has(w.group)) gmap.set(w.group, genId('g'));
            w.group = gmap.get(w.group);
          }
          return w;
        });
        idMap.set(src.id, copy.id);
        return copy;
      });
      copies.forEach(copy => copy.widgets.forEach(w => {
        (w.actions || []).forEach(a => {
          if ((a.type === 'gotoPage' || a.type === 'showPopup') && idMap.has(a.params?.page)) {
            a.params.page = idMap.get(a.params.page);
          }
        });
      }));
      copies.forEach(c => { this.data.pages.push(c); out.push(c.id); });
    }
    this.commit(count > 1 ? `多重复制 ${count} 页` : '复制页面');
    return { pageIds: out, createdVars: created, missingVars: [...missing], noAddrVars: noAddr };
  },

  /* ── 单页导出 / 导入 ─────────────────────────────────────────────
     导出一页 = **这一页的控件 + 它用到的变量 + 它套的公共底**（底上控件用的变量也算）。
     在别的工程里导进来 = 多一条新页面，直接能用。
     为什么不带报警和脚本：那两样是"整机"的东西（报警条件挂在变量上、脚本是全局的），
     跟着一页搬过去很容易搬出重复报警/重复脚本；变量必须带 —— 不带的话页面一进来就是
     一堆绑着空名字的控件，看不出是坏的。 */

  /** 一页用到的所有变量名（含它套的公共底上控件用的；波形通道/配色/量程/动作都算） */
  pageVarNames(pageOrId) {
    const names = new Set();
    this.renderWidgets(pageOrId).forEach(w => {
      if (w.bindings?.variable) names.add(w.bindings.variable);
      (w.bindings?.variables || []).forEach(n => n && names.add(n));
      Object.keys(w.props?.colors || {}).forEach(n => n && names.add(n));
      Object.keys(w.props?.scales || {}).forEach(n => n && names.add(n));
      (w.actions || []).forEach(a => { if (a.params?.variable) names.add(a.params.variable); });
    });
    return names;
  },

  /**
   * 一组控件用到的所有变量名（绑定 / 波形通道 / 通道配色量程 / 动作里的变量）
   * —— 和 pageVarNames 同一套口径，只是喂给它的是"选中的那几个控件"而不是一整页。
   */
  widgetVarNames(list) {
    const names = new Set();
    (list || []).forEach(w => {
      if (w.bindings?.variable) names.add(w.bindings.variable);
      (w.bindings?.variables || []).forEach(n => n && names.add(n));
      Object.keys(w.props?.colors || {}).forEach(n => n && names.add(n));
      Object.keys(w.props?.scales || {}).forEach(n => n && names.add(n));
      (w.actions || []).forEach(a => { if (a.params?.variable) names.add(a.params.variable); });
    });
    return names;
  },

  /* ══════════════════ 控件包（导出/导入别人做好的控件） ══════════════════ */

  /**
   * 导出**选中的控件**为「控件包」（纯数据；editor/widgetIO.js 负责写成文件）
   *
   * 包里带什么：
   *   · widgets   控件实例（几何/属性/绑定/动作/组合 全带）
   *   · variables 它们用到的变量（不带的话对方导进去就是一堆空绑定）
   *   · defs      **只有"非内置"的控件类型**才带定义（属性 schema + render 源码 + CSS）——
   *               内置 16 种对方代码里本来就有，带了反而多余
   *   · pageRefs  跳转/弹窗的目标页名（导进别的工程时按名字重新对上）
   * @param {string[]} ids
   * @param {{withDefs?:boolean, withCss?:boolean}} [opt]
   */
  widgetExportPayload(ids, opt = {}) {
    const list = [];
    for (const p of this.data.pages) for (const w of p.widgets) if (ids.includes(w.id)) list.push(w);
    if (!list.length) return null;
    const names = this.widgetVarNames(list);
    const refs = {};
    list.forEach(w => (w.actions || []).forEach(a => {
      if ((a.type === 'gotoPage' || a.type === 'showPopup') && a.params?.page) {
        const t = this.getPage(a.params.page);
        if (t) refs[a.params.page] = { name: t.name, type: t.type };
      }
    }));
    const defs = [];
    if (opt.withDefs !== false) {
      const seen = new Set();
      list.forEach(w => {
        if (seen.has(w.type) || isBuiltin(w.type)) return;   // 内置的不带（对方也有）
        seen.add(w.type);
        const def = registry.get(w.type);
        if (def) defs.push(defToPack(def, { withCss: opt.withCss !== false }));
      });
    }
    return {
      app: 'hmi-designer',
      kind: PACK_KIND,
      version: PACK_VERSION,
      exportedAt: new Date().toISOString(),
      projectName: this.data.meta?.name || '',
      canvas: { ...this.data.meta.canvas },
      widgets: deepClone(list),
      variables: this.data.variables.filter(v => names.has(v.name)).map(v => deepClone(v)),
      defs,
      pageRefs: refs,
    };
  },

  /**
   * 把一份控件包导进当前工程（导到**当前页**上，一步 Ctrl+Z 可整体撤销）
   *
   * ⚠ 包里如果带自定义控件定义，这里会**执行对方的 render 源码**（registerPackDefs → new Function）。
   *   界面层（widgetIO.js）必须先把源码摊开让人确认，再带 `allowCode: true` 调进来。
   * @param {object} payload
   * @param {{allowCode?:boolean}} [opt]
   * @returns {{ok:boolean, reason?:string, ids?:string[], widgetsAdded?:number,
   *            widgetsSkipped?:string[], defsAdded?:string[], defsFailed?:string[],
   *            defsSkipped?:string[], varsAdded?:number, varsKept?:number,
   *            varsKeptDiff?:string[], unlinked?:string[], warnings?:string[]}}
   */
  importWidgetPack(payload, opt = {}) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: '文件内容不是 JSON 对象' };
    if (payload.kind && payload.kind !== PACK_KIND) return { ok: false, reason: `这不像控件包（kind=${payload.kind}）` };
    const srcWidgets = Array.isArray(payload.widgets) ? payload.widgets : null;
    if (!srcWidgets || !srcWidgets.length) {
      return {
        ok: false,
        reason: Array.isArray(payload.pages)
          ? '这像是一整份工程文件。搬单个/一组控件请用「导出选中控件」生成的 .hmiw.json；整页搬运用「页面 ▸ 导入页面…」'
          : '这个文件里没有控件（找不到 widgets 字段）',
      };
    }
    const warnings = [];
    const unlinked = [];

    /* ① 定义层：先注册自定义控件（**这步会执行代码**），成功的才记进工程 */
    let defsAdded = [], defsFailed = [], defsSkipped = [];
    if (Array.isArray(payload.defs) && payload.defs.length) {
      const needCode = payload.defs.filter(d => d && d.type && !isBuiltin(d.type)).map(d => d.type);
      if (needCode.length && opt.allowCode !== true) {
        return { ok: false, reason: `包里带自定义控件定义（${needCode.join('、')}），需要先确认允许导入代码` };
      }
      const r = registerPackDefs(payload.defs);
      defsAdded = r.added; defsFailed = r.failed; defsSkipped = r.skipped;
      const okTypes = new Set(r.added);
      const list = Array.isArray(this.data.customWidgets) ? this.data.customWidgets : (this.data.customWidgets = []);
      for (const entry of payload.defs) {
        if (!entry || !entry.type || !okTypes.has(entry.type)) continue;
        const i = list.findIndex(x => x && x.type === entry.type);
        if (i >= 0) list[i] = deepClone(entry); else list.push(deepClone(entry));
      }
      if (defsAdded.length) {
        warnings.push(`已导入 ${defsAdded.length} 个自定义控件定义（跟工程走：换台机器打开也能渲染）：${defsAdded.join('、')}`);
        // 工具箱按注册表重建 —— 新控件得当场出现在左边控件库里，不然用户不知道它导进来了
        bus.emit('widgets:defs-changed', { added: defsAdded });
      }
      if (defsFailed.length) warnings.push(`这些自定义控件没导进来：${defsFailed.join('；')}`);
      if (defsSkipped.length) warnings.push(`包里带了内置控件的定义，已忽略（不许覆盖内置）：${defsSkipped.join('、')}`);
    }

    /* ② 变量：缺的补上；同名的留着现有的（地址不一样只提醒，不静默改人家工程） */
    const addedVars = [];
    const addVar = (v) => {
      const name = String(v?.name || '');
      if (!name) return false;
      const cur = this.data.variables.find(x => x.name === name);
      if (cur) { varsKept++; if (String(cur.address || '') !== String(v.address || '')) varsKeptDiff.push(name); return false; }
      const nv = { name, type: v.type || 'real', address: v.address || '', value: v.value ?? 0, len: Number(v.len) || 0 };
      if (v.retain) nv.retain = true;
      this.data.variables.push(nv);
      addedVars.push(nv);
      varsAdded++;
      return true;
    };
    let varsAdded = 0, varsKept = 0; const varsKeptDiff = [];
    const pool = new Map((Array.isArray(payload.variables) ? payload.variables : []).map(v => [String(v?.name || ''), v]));
    const need = this.widgetVarNames(srcWidgets);
    const missing = [...need].filter(n => !this.data.variables.some(v => v.name === n) && !pool.has(n));
    pool.forEach(v => { if (need.has(String(v?.name || ''))) addVar(v); });
    if (missing.length) warnings.push(`这些变量包里没有，画面上的绑定会空着：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`);

    /* ③ 实例层：只加"类型现在注册表里有"的（缺定义的加进去就是一块渲染不出来的空白） */
    const usable = srcWidgets.filter(w => w && w.type && registry.get(w.type));
    const skipped = srcWidgets.filter(w => !(w && w.type && registry.get(w.type)))
      .map(w => `${w?.name || '控件'}(${w?.type || '?'})`);
    if (skipped.length) warnings.push(`这些控件跳过了（本工程没有对应的控件类型）：${skipped.slice(0, 5).join('、')}${skipped.length > 5 ? '…' : ''}`);

    const page = this.currentPage();
    const canvas = this.data.meta.canvas || {};
    const cw = Number(canvas.w) || 1024, ch = Number(canvas.h) || 600;
    const clampI = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
    const gmap = new Map();
    let maxZ = page.widgets.reduce((m, w) => Math.max(m, Number(w.z) || 0), 0);
    const ids = [];
    for (const srcW of usable) {
      const w = deepClone(srcW);
      w.id = genId('w');
      // 导入的控件整体往右下挪一点（别正好压在画布上原有的东西上），再夹进画布范围
      const ww = Number(w.w) || 40, wh = Number(w.h) || 24;
      w.x = clampI(Math.round((Number(w.x) || 0) + 16), 0, Math.max(0, cw - ww));
      w.y = clampI(Math.round((Number(w.y) || 0) + 16), 0, Math.max(0, ch - wh));
      w.z = ++maxZ;
      if (w.group) {
        if (!gmap.has(w.group)) gmap.set(w.group, genId('g'));
        w.group = gmap.get(w.group);
      }
      // 跳转/弹窗动作：按**页名**重新对上（导出时记了 pageRefs），对不上就清空并说一声
      (w.actions || []).forEach(a => {
        if (a.type !== 'gotoPage' && a.type !== 'showPopup') return;
        const ref = payload.pageRefs?.[a.params?.page];
        const want = ref?.name || '';
        const hit = want ? this.data.pages.find(p => p.name === want && (p.type === 'popup') === (a.type === 'showPopup')) : null;
        if (hit) a.params.page = hit.id;
        else if (a.params?.page) { a.params.page = ''; unlinked.push(`${w.name} 的${a.type === 'gotoPage' ? '跳转' : '弹窗'}「${want || '?'}」`); }
      });
      page.widgets.push(w);
      ids.push(w.id);
    }
    if (unlinked.length) warnings.push(`这些跳转/弹窗的目标页这里没有，已清空，请在属性面板重新指一下：${unlinked.slice(0, 5).join('；')}`);

    if (ids.length) {
      bus.emit('selection:changed', { ids });
      this.commit('导入控件包');   // 一步撤销
    }
    // 新变量只是进了变量表，运行值表还不知道它们 —— 补上初值再广播，
    // 否则导进来的控件绑上去显示「未绑定/空」，看着就像"这控件是坏的"（见 varstore.initMissing）
    if (addedVars.length) bus.emit('vars:new-defs', addedVars);
    return {
      ok: true, ids, widgetsAdded: ids.length, widgetsSkipped: skipped,
      defsAdded, defsFailed, defsSkipped, varsAdded, varsKept, varsKeptDiff, unlinked, warnings,
      addedVars,
    };
  },

  /**
   * 导出一页的负载（纯数据；pageIO.js 负责写成文件，测试直接用这个函数）
   * 里面还记了**跳转/弹窗目标页的名字**（pageRefs）：导进别的工程时按名字重新对上，
   * 对不上就清空那个动作并在报告里说一声（比留一个指不到哪去的 id 强）。
   */
  pageExportPayload(pageId) {
    const p = this.getPage(pageId);
    if (!p) return null;
    const names = this.pageVarNames(p);
    const bases = this.basesOf(p);          // 可叠多层：按层从下到上一起导出去
    const refs = {};
    const collectRefs = (page) => page.widgets.forEach(w => (w.actions || []).forEach(a => {
      if ((a.type === 'gotoPage' || a.type === 'showPopup') && a.params?.page) {
        const t = this.getPage(a.params.page);
        if (t) refs[a.params.page] = { name: t.name, type: t.type };
      }
    }));
    collectRefs(p);
    bases.forEach(collectRefs);
    return {
      app: 'hmi-designer',
      kind: 'page',
      version: 2,                                    // v2：bases 数组（可多层）；v1 的 base（单个）导入时仍认
      exportedAt: new Date().toISOString(),
      projectName: this.data.meta?.name || '',
      canvas: { ...this.data.meta.canvas },        // 原工程画布尺寸（导进去时好对照）
      page: deepClone(p),
      bases: bases.map(b => deepClone(b)),
      variables: this.data.variables.filter(v => names.has(v.name)).map(v => deepClone(v)),
      pageRefs: refs,
    };
  },

  /** 名字重了就在后面加序号（页名/底名通用）：排线 → 排线2 */
  uniquePageName(name, extraTaken) {
    const taken = new Set(this.data.pages.map(p => p.name));
    (extraTaken || []).forEach(n => taken.add(n));
    const base = String(name || '页面');
    if (!taken.has(base)) return base;
    for (let i = 2; i < 999; i++) {
      const n = `${base}${i}`;
      if (!taken.has(n)) return n;
    }
    return `${base}-${Date.now()}`;
  },

  /**
   * 把一份页面负载（pageExportPayload 的结果，或整份工程 JSON）导进当前工程。
   * @param {object} payload
   * @param {{pageRef?:string|number, nameSuffix?:string}} [opt]
   *        pageRef：payload 是整份工程时，指定要导哪一页（id / 名字 / 序号）
   * @returns {{ok:boolean, reason?:string, pageId?:string, pageName?:string,
   *            varsAdded?:number, varsKept?:number, varsKeptDiff?:string[],
   *            baseId?:string, baseName?:string, baseCreated?:boolean,
   *            unlinked?:string[], warnings?:string[]}}
   */
  importPage(payload, opt = {}) {
    if (!payload || typeof payload !== 'object') return { ok: false, reason: '文件内容不是 JSON 对象' };
    let src = null;
    let srcVars = [];
    let srcBases = [];                 // 这一页套的公共底（可多层；老文件只有 base 单个）
    let refs = {};
    if (payload.page && typeof payload.page === 'object') {
      // 单页导出文件
      src = payload.page;
      srcVars = Array.isArray(payload.variables) ? payload.variables : [];
      // v2 的 bases 数组优先；老的 v1 文件只有 base（单个）
      const fromArr = Array.isArray(payload.bases) ? payload.bases.filter(b => b && typeof b === 'object') : [];
      srcBases = fromArr.length ? fromArr
        : (payload.base && typeof payload.base === 'object' ? [payload.base] : []);
      refs = payload.pageRefs && typeof payload.pageRefs === 'object' ? payload.pageRefs : {};
    } else if (Array.isArray(payload.pages)) {
      // 整份工程：挑一页（默认第一页）
      const list = payload.pages;
      if (!list.length) return { ok: false, reason: '这份文件里一个页面都没有' };
      const want = opt.pageRef;
      let picked = null;
      if (want === undefined || want === null || want === '') picked = list[0];
      else if (typeof want === 'number' || /^\d+$/.test(String(want))) picked = list[Number(want)];
      else picked = list.find(p => p.id === want) || list.find(p => p.name === want);
      if (!picked) return { ok: false, reason: `这份工程里没有「${want}」这一页` };
      src = picked;
      srcVars = Array.isArray(payload.variables) ? payload.variables : [];
      // 老工程只有 baseId：按单层处理。新工程 baseIds：按顺序全带上
      const wantIds = Array.isArray(picked.baseIds) ? picked.baseIds : (picked.baseId ? [picked.baseId] : []);
      srcBases = wantIds.map(id => list.find(p => p.id === id)).filter(b => b && b.type === 'base');
      list.forEach(p => p.widgets.forEach(w => (w.actions || []).forEach(a => {
        if ((a.type === 'gotoPage' || a.type === 'showPopup') && a.params?.page) {
          const t = list.find(x => x.id === a.params.page);
          if (t) refs[a.params.page] = { name: t.name, type: t.type };
        }
      })));
    } else if (Array.isArray(payload.widgets)) {
      src = payload;                                   // 干脆就是一页的裸对象
    }
    if (!src) return { ok: false, reason: '这不像是页面导出文件（没有 page / pages / widgets 字段）' };

    const warnings = [];
    const unlinked = [];
    let varsAdded = 0, varsKept = 0;
    const varsKeptDiff = [];

    /* ① 变量：缺的补上；同名的留着现有的（地址不一样只提醒，不静默改人家工程） */
    const nameOfVar = (v) => String(v?.name || '');
    const addVar = (v) => {
      const name = nameOfVar(v);
      if (!name) return;
      const cur = this.data.variables.find(x => x.name === name);
      if (cur) {
        varsKept++;
        if (String(cur.address || '') !== String(v.address || '')) varsKeptDiff.push(name);
        return;
      }
      const nv = { name, type: v.type || 'real', address: v.address || '', value: v.value ?? 0, len: Number(v.len) || 0 };
      if (v.retain) nv.retain = true;
      this.data.variables.push(nv);
      varsAdded++;
    };
    const cloneWidgets = (widgets) => {
      const gmap = new Map();
      let maxZ = 0;
      return (widgets || []).map(srcW => {
        const w = deepClone(srcW);
        w.id = genId('w');
        maxZ = Math.max(maxZ, Number(w.z) || 0);
        if (w.group) {
          if (!gmap.has(w.group)) gmap.set(w.group, genId('g'));
          w.group = gmap.get(w.group);
        }
        w.z = ++maxZ;
        return w;
      });
    };

    /* ② 公共底（可多层）：同名底就复用，没有就把底一起建出来（底上的控件用的变量也算进去） */
    const baseIds = [];
    let basesCreated = 0;
    srcBases.forEach(srcBase => {
      const same = this.data.pages.find(x => x.type === 'base' && x.name === srcBase.name);
      if (same) {
        if (same.widgets.length !== (srcBase.widgets?.length || 0)) {
          warnings.push(`这条底用的是工程里已有的「${same.name}」（${same.widgets.length} 个控件）`
            + `，和导出文件里的（${srcBase.widgets?.length || 0} 个）不一样 —— 按已有的来`);
        }
        if (!baseIds.includes(same.id)) baseIds.push(same.id);
      } else {
        const nb = {
          id: genId('pg'),
          name: this.uniquePageName(srcBase.name || '公共底'),
          type: 'base',
          popupW: 420, popupH: 240, title: '', showClose: true,
          widgets: cloneWidgets(srcBase.widgets),
        };
        this.data.pages.push(nb);
        baseIds.push(nb.id);
        basesCreated++;
      }
    });
    // 变量：页面自己的 + **所有层**底上的（新建的读克隆后的那份，复用的读工程里那份）
    const baseVars = baseIds.flatMap(id => this.getPage(id)?.widgets || []);

    /* ③ 变量入表：页面自己的 + 底上的 */
    const pool = new Map(srcVars.map(v => [nameOfVar(v), v]));
    const need = new Set();
    [...(src.widgets || []), ...(baseVars || [])].forEach(w => {
      if (w.bindings?.variable) need.add(w.bindings.variable);
      (w.bindings?.variables || []).forEach(n => n && need.add(n));
      Object.keys(w.props?.colors || {}).forEach(n => need.add(n));
      Object.keys(w.props?.scales || {}).forEach(n => need.add(n));
      (w.actions || []).forEach(a => { if (a.params?.variable) need.add(a.params.variable); });
    });
    // 兜底：导出文件里没带变量定义（老文件/手写 JSON）→ 按名字提醒，不凭空造
    const missing = [...need].filter(n => n && !this.data.variables.some(v => v.name === n) && !pool.has(n));
    // 先建变量、再建页面：页面里的绑定按名字就都还在。
    // ⚠ 只走 srcVars 一遍（同一个变量进来两次会把"地址不一样"数两遍，报告里就会出现重复项）
    srcVars.forEach(v => { if (need.has(nameOfVar(v))) addVar(v); });
    if (missing.length) warnings.push(`这些变量导出文件里没有，页面上的绑定会空着：${missing.slice(0, 6).join('、')}${missing.length > 6 ? '…' : ''}`);

    /* ④ 页面本体 */
    const page = {
      id: genId('pg'),
      name: this.uniquePageName(opt.nameSuffix ? `${src.name}${opt.nameSuffix}` : src.name),
      type: src.type === 'popup' ? 'popup' : src.type === 'base' ? 'base' : 'page',
      popupW: Number(src.popupW) || 420,
      popupH: Number(src.popupH) || 240,
      title: src.title || '',
      showClose: src.showClose !== false,
      widgets: cloneWidgets(src.widgets),
    };
    if (page.type === 'page' && baseIds.length) { page.baseIds = [...baseIds]; page.baseId = baseIds[0]; }
    /* 跳转/弹窗动作：按**页名**重新对上（导出时记了 pageRefs）；对不上就清空并说一声 */
    page.widgets.forEach(w => (w.actions || []).forEach(a => {
      if (a.type !== 'gotoPage' && a.type !== 'showPopup') return;
      const old = a.params?.page;
      if (!old) return;
      const info = refs[old];
      const target = info ? this.data.pages.find(x => x.name === info.name) : null;
      if (target) a.params.page = target.id;
      else {
        unlinked.push(`${w.name} 的「${a.type === 'showPopup' ? '打开弹窗' : '跳转页面'}」（${info?.name || old}）`);
        a.params.page = '';
      }
    }));
    this.data.pages.push(page);
    this.commit('导入页面');
    return {
      ok: true, pageId: page.id, pageName: page.name,
      varsAdded, varsKept, varsKeptDiff,
      baseIds: [...baseIds],
      baseNames: baseIds.map(id => this.getPage(id)?.name || ''),
      basesCreated,
      // 老调用方（pageIO / 测试）沿用这两个字段：第一层 + 有没有新建
      baseId: baseIds[0] || '',
      baseName: baseIds[0] ? (this.getPage(baseIds[0])?.name || '') : '',
      baseCreated: basesCreated > 0,
      unlinked, warnings,
    };
  },
  /**
   * 控件按 id 查找（O(1)）。
   *
   * 为什么不能每次 find：画布选中、属性面板刷新、对齐/编组都会按 id 查上百上千次，
   * 挨个 find 一遍就是 O(n²) —— 1000 个控件时只选中一下就要 20ms，2000 个更糟（实测）。
   * 缓存按「页对象 + 数组引用 + 长度」判有效：加/删/换页/撤销（replaceData 换新对象）
   * 都会让缓存失效，长度不变时（改属性、拖动）继续命中。
   */
  _widgetIndex() {
    const page = this.currentPage();
    const arr = page ? page.widgets : EMPTY_ARR;
    const c = this._widCache;
    if (c && c.page === page && c.arr === arr && c.len === arr.length) return c.map;
    const map = new Map();
    for (const w of arr) map.set(w.id, w);
    this._widCache = { page, arr, len: arr.length, map };
    return map;
  },
  getWidget(id) { return this._widgetIndex().get(id); },

  /** 标脏：这些控件的 DOM 需要重画（画布据此只重画它们，不用整块重建） */
  markDirty(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) if (id) this._dirty.add(id);
  },
  /** 取走脏集合（取完即清空） */
  takeDirty() { const s = this._dirty; this._dirty = new Set(); return s; },
  /**
   * 标「DOM 已经是对的」：拖动时位置是直接改元素样式的，DOM 本来就是最新，
   * 提交后没必要再重画一遍（上千个控件时那一下很明显）。
   */
  markSynced(ids) {
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) if (id) this._synced.add(id);
  },
  takeSynced() { const s = this._synced; this._synced = new Set(); return s; },

  /* ── 编组（组合）──
     数据模型保持扁平，只在控件上打一个 group 标记：
       · 选中任一成员 = 选中整组（select 里扩展）
       · 一起拖动、一起缩放、一起删除/复制（多选那套机制直接复用）
       · 不做嵌套：整组再组合 = 换一个新组号，行为和"多选"一致 */
  groupWidgets(ids) {
    const ws = this.currentWidgets().filter(w => ids.includes(w.id));
    if (ws.length < 2) return null;
    const gid = genId('g');
    ws.forEach(w => { w.group = gid; });
    this.commit('组合');
    return gid;
  },
  ungroupWidgets(ids) {
    const ws = this.currentWidgets().filter(w => ids.includes(w.id) && w.group);
    if (!ws.length) return 0;
    ws.forEach(w => { delete w.group; });
    this.commit('取消组合');
    return ws.length;
  },
  /** 同组的全部控件 id（含自己）；没编组就只返回自己 */
  groupMembers(id) {
    const w = this.getWidget(id);
    if (!w?.group) return [id];
    return this.currentWidgets().filter(x => x.group === w.group).map(x => x.id);
  },
  /** 把一组选择扩展到整组（点选/框选/清单点行都经过这里）*/
  expandGroups(ids) {
    const out = new Set(ids);
    const groups = new Set([...ids].map(id => this.getWidget(id)?.group).filter(Boolean));
    if (groups.size) {
      this.currentWidgets().forEach(w => { if (w.group && groups.has(w.group)) out.add(w.id); });
    }
    return [...out];
  },
  /** 选择里是不是"正好一整组"（属性面板/缩放柄据此判断按组处理）*/
  isWholeGroup(ids) {
    const ws = this.currentWidgets().filter(w => ids.includes(w.id));
    if (ws.length < 2) return false;
    const g = ws[0].group;
    return !!g && ws.every(w => w.group === g) && this.expandGroups([ws[0].id]).length === ws.length;
  },

  /** 跨页查找控件（波形画布、清单跳转等需要按 id 找到任意页上的控件） */
  findWidget(id) {
    for (const p of this.data.pages) {
      const w = p.widgets.find(x => x.id === id);
      if (w) return w;
    }
    return null;
  },
  /** 批量更新几何/顶层字段 */
  updateWidgets(ids, patch) {
    this.currentWidgets().forEach(w => { if (ids.includes(w.id)) Object.assign(w, patch); });
    this.markDirty(ids);
    this.touch();
  },
  /** 更新单个控件 props 键 */
  updateWidgetProp(id, key, value, { notify = true } = {}) {
    // 整数控件的小数位 = 定点缩放位数，fmt 才是缩放开关（见 utils.js 的 intDecimalsOf/fixedScaleOf）。
    // 属性面板改小数位时会同时写 fmt，但 MCP / AI / 外部脚本常常只写 decimals 或者只切 dispType，
    // 漏写 fmt 会让屏上的数值差 10 倍，所以这里按面板的同一套规则兜一手（浮点/字符串不碰）。
    const w = this.getWidget(id);
    if (!w) return;
    // 下拉框：老的「只显示不可选」(readonly) 已经不是独立属性了 —— 统一落成「操作方式」(operate)。
    // 老脚本/老套件还在写这个键，这里转一手它们照样能用，而面板上只有一处开关（见 core/utils.js comboMode）
    if (key === 'readonly' && w.type === 'select') {
      const cur = String(w.props.operate || '');
      w.props.operate = value === true ? 'view' : (cur === 'view' || !cur ? 'pick' : cur);
      this.markDirty(id);
      if (notify) this.touch();
      return;
    }
    if (w.type === 'button' && key === 'showState') {
      // 旧调用方可能仍尝试切换这个开关；按钮现已统一按条件显示。
      delete w.props.showState;
    } else if (w.type === 'button' && key === 'text') {
      // 旧字段仍可写，但它是「未满文字」的兼容别名。
      w.props.offText = value;
      w.props.text = value;
    } else {
      const wasInt = isIntDtype(String(w.props.dispType || ''));
      w.props[key] = value;
      if (w.type === 'button' && key === 'offText') w.props.text = value;
      if (w.type === 'button' && key === 'bgColor') w.props.offColor = value;
      if (w.type === 'button' && key === 'offColor') w.props.bgColor = value;
      syncIntDecimalsFmt(w, key, wasInt);
    }
    this.markDirty(id);
    if (notify) this.touch();
  },
  updateWidgetField(id, key, value) {
    const w = this.getWidget(id);
    if (!w) return;
    if (key.startsWith('bindings.')) {
      w.bindings[key.slice(9)] = value;
      // 绑定变量时让「数据类型 / 小数位」跟着变量走 —— 和变量表改类型时同一个方向（syncWidgetDispType）。
      // 否则新绑一个 int 变量，控件还顶着默认的 dispType:'float' + fmt:'%.1f'：
      // 面板上小数位显示 1（浮点默认值），画面显示 123.0，跟「整数默认 0 位小数」对不上。
      if (key === 'bindings.variable') {
        const v = this.data.variables.find(x => x.name === value);
        if (v) syncWidgetDispType(this, v);
      }
    } else w[key] = value;
    this.markDirty(id);
    this.touch();
  },
  updateWidgetActions(id, actions) {
    const w = this.getWidget(id);
    if (!w) return;
    w.actions = actions;
    this.markDirty(id);
    this.touch();
  },
  zStepAvailability(ids) {
    const available = { up: false, down: false };
    if (!ids.length) return available;
    const selected = new Set(ids);
    const ordered = widgetsByZ(this.currentWidgets());
    for (let i = 1; i < ordered.length; i++) {
      const behind = selected.has(ordered[i - 1].id);
      const ahead = selected.has(ordered[i].id);
      if (behind && !ahead) available.up = true;
      if (!behind && ahead) available.down = true;
    }
    return available;
  },

  stepZ(ids, where) {
    const ordered = widgetsByZ(this.currentWidgets());
    const layers = ordered.map(widgetZ);
    const distinct = new Set(layers).size === layers.length;
    const selected = new Set(ids);
    const up = where === 'up';
    const direction = up ? 1 : -1;
    let moved = false;
    // 从移动方向的前端遍历，每段选中的控件整体跨过紧邻的未选中控件。
    for (let i = up ? ordered.length - 2 : 1; i >= 0 && i < ordered.length; i -= direction) {
      const neighbor = i + direction;
      if (!selected.has(ordered[i].id) || selected.has(ordered[neighbor].id)) continue;
      [ordered[i], ordered[neighbor]] = [ordered[neighbor], ordered[i]];
      moved = true;
    }
    if (!moved) return;

    const dirty = [];
    ordered.forEach((widget, i) => {
      const z = distinct ? layers[i] : i + 1;
      if (widget.z === z) return;
      widget.z = z;
      dirty.push(widget.id);
    });
    this.markDirty(dirty);
    this.commit(up ? '上移一层' : '下移一层');
  },

  setZ(ids, where) {
    if (where === 'up' || where === 'down') return this.stepZ(ids, where);
    const page = this.currentPage();
    const zs = page.widgets.map(w => w.z);
    const top = Math.max(...zs, 0), bottom = Math.min(...zs, 100000);
    page.widgets.forEach(w => {
      if (!ids.includes(w.id)) return;
      w.z = where === 'top' ? top + 1 : bottom - 1;
    });
    this.markDirty(ids);           // z 是写在元素样式上的，改层级要重画这几个
    this.commit('调整层级');
  },

  /* ── 变量 ── */
  variables() { return this.data.variables; },
  recipeVariables() {
    const names = new Set(Array.isArray(this.data.recipeVariables) ? this.data.recipeVariables : []);
    return this.variables().filter(v => names.has(v.name));
  },
  setRecipeVariables(names) {
    const selected = new Set(names);
    this.data.recipeVariables = this.variables().filter(v => selected.has(v.name)).map(v => v.name);
    this.commit('配置配方地址');
  },
  addVariable() {
    // 新变量默认：无地址（**内部变量**，不下发 PLC）+ 不保持 ——
    // 内部变量就是"HMI 自己算的东西"，勾上「保持」才会落盘（见 varsPanel 的保持列）
    const v = { name: `var${this.data.variables.length + 1}`, type: 'bool', address: '', value: false, len: 0 };
    this.data.variables.push(v);
    this.commit('添加变量');
    // ★ 喊一声"刚加的是这个"：变量面板据此**自动滚到它、并把名称格聚焦**（建完就是要改名/填地址）。
    //   放在 commit 之后发（面板的 project:changed 那趟已经重画完，这次只是"跳过去 + 聚焦"）。
    //   走 bus 而不是在面板里包一层按钮：右键菜单「添加变量」那条路也一起享受到。
    bus.emit('vars:added', { name: v.name });
    return v;
  },
  /**
   * 改一个变量的字段（名称/类型/地址/长度/初值/保持）。
   * ⚠ 地址填上以后 retain 就没意义了（保持由 PLC 负责）→ 自动摘掉，免得留下
   *   "看着勾了保持、实际后端按 PLC 变量处理"的错觉。
   */
  updateVariableRetain(name, on) {
    const v = this.data.variables.find(x => x.name === name);
    if (!v) return null;
    if (on && !String(v.address || '').trim()) v.retain = true; else delete v.retain;
    this.commit(on ? '设为掉电保持' : '取消掉电保持');
    return v;
  },
  deleteVariable(name) {
    return this.deleteVariables([name]);
  },
  /**
   * 批量删除变量（整批一次提交 = 一步撤销，不会灌爆历史）
   * 引用清理和单个删除完全一样：绑定置空、波形槽位留空不移位、动作/报警条件清掉、内容里的 {变量} 留着
   * @returns {number} 实际删掉几个
   */
  deleteVariables(names) {
    const kill = new Set((names || []).filter(Boolean));
    if (!kill.size) return 0;
    const before = this.data.variables.length;
    this.data.variables = this.data.variables.filter(v => !kill.has(v.name));
    const gone = before - this.data.variables.length;
    if (!gone) return 0;
    if (Array.isArray(this.data.recipeVariables)) {
      this.data.recipeVariables = this.data.recipeVariables.filter(name => !kill.has(name));
    }
    this.data.pages.forEach(p => p.widgets.forEach(w => {
      if (kill.has(w.bindings?.variable)) w.bindings.variable = '';
      if (Array.isArray(w.bindings?.variables)) {
        // 波形通道是固定 8 槽位：把该槽置空而不是删掉，否则后面的通道会整体前移（颜色/量程跟着错位）
        w.bindings.variables = w.bindings.variables.map(n => (kill.has(n) ? '' : n));
      }
      if (w.props?.colors) kill.forEach(n => delete w.props.colors[n]);
      if (w.props?.scales) kill.forEach(n => delete w.props.scales[n]);
      w.actions = (w.actions || []).filter(a => !kill.has(a.params?.variable));
    }));
    // 报警表：触发条件里的变量清掉（这条报警就不会再触发）；内容里的 {变量} 留着（运行时会显示 --，能看出要改）
    this.alarms().forEach(a => { if (kill.has(a.variable)) a.variable = ''; });
    this.commit(gone > 1 ? `删除 ${gone} 个变量` : '删除变量');
    return gone;
  },
  /** 变量被多少处引用（控件绑定 / 波形通道 / 动作 / 报警条件）——删除前用来提醒 */
  variableRefs(name) {
    let n = Array.isArray(this.data.recipeVariables) && this.data.recipeVariables.includes(name) ? 1 : 0;
    this.pages().forEach(p => p.widgets.forEach(w => {
      if (w.bindings?.variable === name) n++;
      if (Array.isArray(w.bindings?.variables) && w.bindings.variables.includes(name)) n++;
      if (w.props?.colors && name in w.props.colors) n++;
      if (w.props?.scales && name in w.props.scales) n++;
      (w.actions || []).forEach(a => { if (a.params?.variable === name) n++; });
    }));
    this.alarms().forEach(a => { if (a.variable === name) n++; });
    return n;
  },
  /**
   * 把数组变量展开成 N 个标量变量：arrw(int[] , 13) → arrw[1] … arrw[13]（int）。
   *
   * 为什么值得拆：CODESYS 的 OPC UA 里**数组元素本身就是独立节点**
   * （实测 `ns=4;s=|var|…GVL.arrw[1]` 能单独读、单独写）。拆成标量以后
   *   · 控件不用再管「数组元素下标」这一层，写元素也不用「整段读回来 → 改一个 → 整段写回」；
   *   · Modbus 本来就没有数组，元素就是连续寄存器 —— 一套规则同时吃两种协议。
   *
   * 下标按 **PLC 的写法**（CODESYS 是 `ARRAY[1..N]` → 从 1 起）；地址这么算：
   *   · OPC UA ：NodeId 后面直接接 [k]（…GVL.arrw → …GVL.arrw[1]）
   *   · Modbus ：按元素占几个寄存器往后排（int 元素：%MW100/%MW101/…；real 元素：%MW100/%MW102/…）
   *
   * ⚠ 展开后**原数组变量会被删掉**：否则 `arrw` 和 `arrw[1]` 会同时存在，
   *   而 `varStore.set('arrw[1]')` 那条「写数组元素」的正则会分不清该走哪条路。
   * 引用了这个数组、并且设了「数组元素」下标的控件，会自动改绑到对应元素变量。
   * @returns {{ok:boolean, reason?:string, created?:string[], remapped?:number, cleared?:number}}
   */
  expandArrayVar(name) {
    const v = this.data.variables.find(x => x.name === name);
    if (!v) return { ok: false, reason: '变量不存在' };
    if (!isArrayType(v.type)) return { ok: false, reason: '不是数组类型' };
    const n = arrayLenOf(v, 10);
    const elem = elemTypeOf(v.type);
    const initArr = Array.isArray(v.value) ? v.value : parseArrayText(v.value, elem);
    const ua = isOpcAddr(v.address);
    const step = Math.max(1, wordsFor(elem, 0));
    const created = [];
    const elements = [];
    for (let k = 1; k <= n; k++) {
      const elName = `${name}[${k}]`;
      elements.push(elName);
      if (this.data.variables.some(x => x.name === elName)) continue;      // 已经有了就不动它
      let addr = '';
      if (v.address) addr = ua ? `${v.address}[${k}]` : bumpAddr(v.address, step * (k - 1));
      this.data.variables.push({
        name: elName, type: elem, address: addr, len: 0,
        value: initArr[k - 1] ?? 0,
      });
      created.push(elName);
    }
    // ① 先改绑：老工程里设过「数组元素」下标的控件 → 直接指向那个元素变量。
    //    ⚠ 这个属性本身已经删了（数组一律走 `[]` 变量名），这段只为了**迁移老工程**：
    //      留着它，那些控件才能落到正确的 arrw[k] 上，而不是被判成「引用了整段」清掉。
    //      老下标是 0 起，PLC/变量名是 1 起，所以 +1。
    let remapped = 0;
    this.data.pages.forEach(p => p.widgets.forEach(w => {
      if (w.bindings?.variable !== name) return;
      const idx = Number(w.props?.arrIdx);
      if (Number.isInteger(idx) && idx >= 0 && idx < n) {
        w.bindings.variable = `${name}[${idx + 1}]`;
        if (w.props) delete w.props.arrIdx;
        remapped++;
      }
    }));
    // ② 剩下还引用原数组的（整段绑定 / 波形槽 / 动作 / 报警）按「删除变量」那套清掉，
    //    并且数一数有几处 —— 这些没法自动对应到某一个元素，得让用户知道
    let cleared = 0;
    this.data.pages.forEach(p => p.widgets.forEach(w => {
      if (w.bindings?.variable === name) { w.bindings.variable = ''; cleared++; }
      if (Array.isArray(w.bindings?.variables)) {
        w.bindings.variables = w.bindings.variables.map(x => {
          if (x !== name) return x;
          cleared++;
          return '';                      // 波形 8 槽位固定：置空而不是删，免得后面的通道整体前移
        });
      }
      if (w.props?.colors && name in w.props.colors) { delete w.props.colors[name]; cleared++; }
      if (w.props?.scales && name in w.props.scales) { delete w.props.scales[name]; cleared++; }
      const keep = (w.actions || []).filter(a => {
        if (a.params?.variable !== name) return true;
        cleared++;
        return false;
      });
      w.actions = keep;
    }));
    this.alarms().forEach(a => { if (a.variable === name) { a.variable = ''; cleared++; } });
    if (Array.isArray(this.data.recipeVariables) && this.data.recipeVariables.includes(name)) {
      this.data.recipeVariables = [...new Set(this.data.recipeVariables.flatMap(n => n === name ? elements : [n]))];
    }
    // ③ 删掉原数组变量、一次提交（一步撤销）
    this.data.variables = this.data.variables.filter(x => x.name !== name);
    this.commit('展开数组');
    return { ok: true, created, remapped, cleared };
  },

  /* ── 操作权限（运行态）──
     等级自己配（名字 + 密码，密码只存哈希）；数组顺序 = 等级高低（越靠后越高，
     解锁高级别 = 也能操作低级别的东西）。控件上用 props.permLevel 记它要哪一级。 */
  permissions() {
    if (!this.data.permissions || typeof this.data.permissions !== 'object') this.data.permissions = {};
    const pm = this.data.permissions;
    if (!Array.isArray(pm.levels)) pm.levels = [];
    return pm;
  },
  permLevels() { return this.permissions().levels; },
  permLevel(id) { return this.permLevels().find(l => l.id === id) || null; },
  permLevelName(id) { return this.permLevel(id)?.name || ''; },
  /** 等级高低（0 起；越靠后越高）。认不出的 id 返回 -1（= 没这个等级，当作"不限"用） */
  permRank(id) { return this.permLevels().findIndex(l => l.id === id); },
  setPermissions(patch) {
    Object.assign(this.permissions(), patch || {});
    this.commit('权限设置');
  },
  /** 加一级（默认加到最后 = 最高）。返回新等级对象（密码由调用方写 hash/salt） */
  addPermLevel(patch = {}) {
    const lv = {
      id: genId('pm'), name: patch.name || `等级${this.permLevels().length + 1}`,
      salt: '', hash: '', iter: 0, ...patch,
    };
    this.permLevels().push(lv);
    this.commit('新增权限等级');
    return lv;
  },
  updatePermLevel(id, patch) {
    const l = this.permLevel(id);
    if (!l) return;
    Object.assign(l, patch);
    this.commit('修改权限等级');
  },
  /** 删除一级：**同时把引用了这一级的控件属性清掉**（不然控件会卡在一个不存在的等级上，
   *  运行时谁都解不开 —— 现场表现就是"这个按钮按了没反应"） */
  deletePermLevel(id) {
    const pm = this.permissions();
    if (!pm.levels.some(l => l.id === id)) return false;
    pm.levels = pm.levels.filter(l => l.id !== id);
    let cleared = 0;
    this.data.pages.forEach(p => p.widgets.forEach(w => {
      if (w.props?.permLevel === id) { w.props.permLevel = ''; cleared++; }
    }));
    this.commit('删除权限等级');
    return cleared;
  },
  /** 上移/下移一级（调等级高低）。delta = -1 往低、+1 往高 */
  movePermLevel(id, delta) {
    const list = this.permLevels();
    const i = list.findIndex(l => l.id === id);
    const j = i + (delta > 0 ? 1 : -1);
    if (i < 0 || j < 0 || j >= list.length) return false;
    [list[i], list[j]] = [list[j], list[i]];
    this.commit('调整权限顺序');
    return true;
  },
  /** 设某个控件要哪一级（'' = 不限）。写的是公共属性 props.permLevel */
  setWidgetPermLevel(id, levelId) {
    const w = this.getWidget(id);
    if (!w) return false;
    if (!w.props) w.props = {};
    w.props.permLevel = levelId || '';
    this.markDirty(id);
    this.commit('设置控件权限');
    return true;
  },

  /* ── 软键盘（运行态触摸输入）──
     一处设置管所有输入控件（数值 / 文本 / 下拉框「✎ 输入…」都走同一个 openNumPad）：
       mode  replace 首键清空重输 —— 打开照样显示当前值，但第一个「字符键」一按就让掉原值（默认）
             edit    接着原值改 —— 打开键盘显示当前值，按的键接在原值后面（老行为，得显式选）
       label var     标题栏显示**变量名**（老行为）
             widget  标题栏显示**控件名**（现场认"线速度设定"比认 Hr_LineSpd 快）
             none    **什么都不显示**（标题栏只留右上角那个 ✕ —— 现场嫌那一行字碍眼/占地方）
     控件上**不再逐个配**（现场要的是"一次改全部"）；跟着工程存/导出一起走。 */
  keypad() {
    if (!this.data.keypad || typeof this.data.keypad !== 'object') this.data.keypad = {};
    const kp = this.data.keypad;
    if (kp.mode !== PAD_EDIT) kp.mode = PAD_REPLACE;
    if (!PAD_LABELS.includes(kp.label)) kp.label = PAD_LABEL_VAR;
    return kp;
  },
  setKeypad(patch) {
    Object.assign(this.keypad(), patch || {});
    this.commit('软键盘设置');
  },

  /* ── 脚本表（脚本编辑栏用）──
     一条脚本 = 触发方式（初始化/定时/循环/变量变化/条件成立） + 一段 JS 代码 */
  scripts() {
    if (!Array.isArray(this.data.scripts)) this.data.scripts = [];
    return this.data.scripts;
  },
  addScript(patch = {}) {
    const s = {
      id: genId('sc'), name: `脚本${this.scripts().length + 1}`, enabled: true,
      trig: 'interval', ms: 1000, variable: this.data.variables[0]?.name || '',
      op: '==', value: 1,
      code: '// 运行态按下面的触发方式执行\n// 可用：get/set/log/page/popup/back/alarms…（右侧速查）\n',
      ...patch,
    };
    this.scripts().push(s);
    this.commit('添加脚本');
    return s;
  },
  updateScript(id, patch) {
    const s = this.scripts().find(x => x.id === id);
    if (!s) return;
    Object.assign(s, patch);
    this.commit('修改脚本');
  },
  deleteScript(id) {
    this.data.scripts = this.scripts().filter(s => s.id !== id);
    this.commit('删除脚本');
  },
  getScript(id) { return this.scripts().find(s => s.id === id); },
  /**
   * 批量删脚本（脚本面板的「删除选中」用）。
   * 和变量/报警一样**整批一次 commit** = 一步 Ctrl+Z 撤销，不会一条一条灌历史。
   * @param {string[]} ids
   * @returns {number} 实际删掉几条
   */
  deleteScripts(ids) {
    const kill = new Set((ids || []).filter(Boolean));
    if (!kill.size) return 0;
    const before = this.scripts().length;
    this.data.scripts = this.scripts().filter(s => !kill.has(s.id));
    const gone = before - this.data.scripts.length;
    if (!gone) return 0;
    this.commit(gone > 1 ? `删除 ${gone} 条脚本` : '删除脚本');
    return gone;
  },

  /* ── 报警表（报警编辑栏用）──
     每条报警 = 触发条件（变量 + 比较 + 阈值） + 内容（可写 {变量名} 关联变量） */
  customAlarmLevels() { return this.data.alarmLevels || []; },
  setCustomAlarmLevels(levels) {
    this.data.alarmLevels = normalizeAlarmLevels(levels);
    this.commit('修改报警级别');
  },
  alarms() {
    if (!Array.isArray(this.data.alarms)) this.data.alarms = [];
    return this.data.alarms;
  },
  addAlarm(patch = {}) {
    const a = {
      id: genId('al'), name: `报警${this.alarms().length + 1}`,
      text: '', variable: this.data.variables[0]?.name || '',
      op: '>=', value: 1, level: 'alarm', delaySec: 0, enabled: true,
      ...patch,
    };
    this.alarms().push(a);
    this.commit('添加报警');
    return a;
  },
  updateAlarm(id, patch) {
    const a = this.alarms().find(x => x.id === id);
    if (!a) return;
    Object.assign(a, patch);
    this.commit('修改报警');
  },
  deleteAlarm(id) {
    this.data.alarms = this.alarms().filter(a => a.id !== id);
    this.commit('删除报警');
  },
  /**
   * 批量删除报警（报警表里勾好几条一次删）。
   * 和变量一样**整批一次 commit** = 一步 Ctrl+Z 撤销，不会一条一条灌历史。
   * @param {string[]} ids
   * @returns {number} 实际删掉几条
   */
  deleteAlarms(ids) {
    const kill = new Set((ids || []).filter(Boolean));
    if (!kill.size) return 0;
    const before = this.alarms().length;
    this.data.alarms = this.alarms().filter(a => !kill.has(a.id));
    const gone = before - this.data.alarms.length;
    if (!gone) return 0;
    this.commit(gone > 1 ? `删除 ${gone} 条报警` : '删除报警');
    return gone;
  },
  getAlarm(id) { return this.alarms().find(a => a.id === id); },

  /**
   * 改一个变量的字段（名称/类型/地址/长度/初值/保持）。
   * ⚠ 地址填上以后 retain 就没意义了（掉电保持由 PLC 负责）→ 自动摘掉，
   *   免得留下"看着勾了保持、实际后端按 PLC 变量处理"的错觉。
   */
  updateVariable(name, patch) {
    const v = this.data.variables.find(v => v.name === name);
    if (!v) return;
    const oldName = v.name;
    Object.assign(v, patch);
    if (v.retain && !String(v.address || '').trim()) v.retain = true; else delete v.retain;
    if (patch.type) syncWidgetDispType(this, v);       // 类型改了 → 绑定它的数值控件跟着改
    if (patch.name && patch.name !== oldName) this.remapVarRefs(oldName, patch.name);
    this.commit('修改变量');
  },

  /**
   * 变量改名 → 把工程里所有引用一起改（控件绑定 / 波形槽 / 通道配色量程 / 动作 / 报警条件与 {变量} 内容
   * **以及脚本里 hmi.get/set/has('名字') 那种字符串写法**，见 remapScriptRefs）。
   *
   * 单独抽出来是因为**批量改名**也要用它（导入 OPC UA/XML 时按符号路径重命名一批变量）：
   * 那种场合得一次 commit 一步撤销，不能每个变量 commit 一次。
   * @returns {boolean} 有没有真的改
   */
  remapVarRefs(oldName, newName) {
    if (!oldName || !newName || oldName === newName) return false;
    if (Array.isArray(this.data.recipeVariables)) {
      this.data.recipeVariables = this.data.recipeVariables.map(name => name === oldName ? newName : name);
    }
    this.data.pages.forEach(p => p.widgets.forEach(w => {
      if (w.bindings?.variable === oldName) w.bindings.variable = newName;
      if (Array.isArray(w.bindings?.variables)) {
        w.bindings.variables = w.bindings.variables.map(n => (n === oldName ? newName : n));
      }
      if (w.props?.colors && oldName in w.props.colors) {
        w.props.colors[newName] = w.props.colors[oldName];
        delete w.props.colors[oldName];
      }
      if (w.props?.scales && oldName in w.props.scales) {
        w.props.scales[newName] = w.props.scales[oldName];
        delete w.props.scales[oldName];
      }
      (w.actions || []).forEach(a => { if (a.params?.variable === oldName) a.params.variable = newName; });
    }));
    // 报警表：条件里的变量名跟着改；内容里的 {旧名} 也换成 {新名}，不然引用就断了
    this.alarms().forEach(a => {
      if (a.variable === oldName) a.variable = newName;
      if (typeof a.text === 'string' && a.text.includes(`{${oldName}}`)) {
        a.text = a.text.split(`{${oldName}}`).join(`{${newName}}`);
      }
    });
    this.remapScriptRefs(oldName, newName);      // 脚本：触发变量 + 代码里的 hmi.get/set/has('名字')
    return true;
  },
  /**
   * 脚本里的变量引用跟着改名/替换：
   *   · `scripts[].variable`（「变量变化/条件成立」的触发变量）
   *   · 代码里以**字符串**写的变量名：`hmi.get('x')` / `hmi.set('x', v)` / `hmi.has('x')`
   *   · 代码里的**属性写法**：`hmi.v.x` / `hmi.v['x']`（新写法，漏了它一样是"改名后脚本静默失效"）
   *     —— 以前这三处改不到，变量一改名脚本就静默失效（现场最难查的一类问题）。
   * 只动**变量名该出现的位置**，别的字符串一律不碰：
   *   · 函数写法只认第一个参数位置上的字面量，否则 `hmi.set('sMode', 'a')` 里当**值**用的 `'a'` 会被误改；
   *   · 属性写法改名后如果新名字**不是合法标识符**（数字开头/带横线），点写法会变成语法错
   *     （`hmi.v.1号泵`）→ 自动改成方括号 `hmi.v['1号泵']`。
   * @returns {{trig:number, code:number, suspicious:number}} 触发变量改了几处 / 代码里改了几处 /
   *          还有几个脚本"别处也出现了这个名字"（不是上面这些写法，不敢自动改，让用户看一眼）
   */
  remapScriptRefs(oldName, newName) {
    const out = { trig: 0, code: 0, suspicious: 0 };
    if (!oldName || !newName || oldName === newName) return out;
    // ⚠ 正则不能提到外面共用：带 g 的正则有 lastIndex 状态，两处一起用会漏匹配
    const apiRe = () => /\bhmi\s*\.\s*(?:get|set|has)\s*\(\s*(['"])([^'"]+)\1/g;
    const propRe = () => scriptVarPropRe();
    const variableNames = new Set(this.variables().map(v => v.name));
    const indexedName = (name, index) => index === undefined ? '' : name + '[' + index + ']';
    const isExpanded = (name, index) => {
      const full = indexedName(name, index);
      return full && (full === oldName || variableNames.has(full));
    };
    const countApi = (code) => {
      const re = apiRe();
      let n = 0, m;
      while ((m = re.exec(code))) if (m[2] === oldName) n++;
      return n;
    };
    const countProp = (code) => {
      const re = propRe();
      let n = 0, m;
      while ((m = re.exec(code))) {
        const name = m[1] || m[3];
        if ((isExpanded(name, m[4]) ? indexedName(name, m[4]) : name) === oldName) n++;
      }
      return n;
    };
    this.scripts().forEach(s => {
      if (s.variable === oldName) { s.variable = newName; out.trig++; }
      const code = String(s.code || '');
      if (!code.includes(oldName) && !code.includes(oldName.replace(/\[\d+\]$/, ''))) return;
      let next = code;
      let n = countApi(code);
      if (n) next = next.replace(apiRe(), (m, q, name) => (name === oldName ? m.replace(name, newName) : m));
      const np = countProp(next);
      if (np) {
        n += np;
        next = next.replace(propRe(), (m, dotName, q, strName, index) => {
          const name = dotName || strName;
          const expanded = isExpanded(name, index);
          if ((expanded ? indexedName(name, index) : name) !== oldName) return m;
          const suffix = !expanded && index !== undefined ? '[' + index + ']' : '';
          if (!dotName) return 'hmi.v[' + q + newName + q + ']' + suffix;
          return (isIdentName(newName) ? 'hmi.v.' + newName : "hmi.v['" + newName + "']") + suffix;
        });
      }
      if (n) { s.code = next; out.code += n; }
      // 改完之后还出现旧名 → 不是上面两种写法（可能是自由文本），提醒用户自己看
      if (String(s.code).includes(oldName)) out.suspicious++;
    });
    return out;
  },

  /* ── 画布 ── */
  updateCanvas(patch) {
    Object.assign(this.data.meta.canvas, patch);
    this.commit('画布设置');
  },
};
