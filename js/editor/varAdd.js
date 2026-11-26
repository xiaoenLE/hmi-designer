/**
 * varAdd.js — 「这个变量还没有，顺手建一个」（在变量框里直接新建变量）
 *
 * 现场：在按钮动作 / 数据绑定 / 波形通道这些**变量框**里直接打一个还没定义的变量名
 * （`Hb反向点动[7]` 这种，名字是从 PLC 程序里抄下来的点位）—— 以前只能红字提示
 * "不在变量表里"，然后跑去变量表面板新建一条、再回来把名字重打一遍。
 * 现在候选表底下多一行「＋ 新建变量「xxx」…」，点它（或在没有任何匹配时直接回车）
 * 就弹这个对话框：**名称 / 数据类型 / 地址 / 长度 / 保持** 填完就用，
 * 建完自动把名字填回那个变量框（绑定/动作用的就是它），变量表面板里也立刻有这一条。
 *
 * 几个和变量表面板保持一致的地方（别各写一套）：
 *   · 类型清单取 `js/core/csv.js` 的 VAR_TYPES（去掉数组：数组走变量表的「展开数组」/ CSV 导入）；
 *   · 地址用 `normAddr` 归一化：`HR100` / `100` → `%MW100`（跟变量表地址格 blur 时同一套）；
 *   · 地址留空 = **内部变量**（不读不写 PLC），这时才能勾「保持」；
 *   · 长度只对字符串/宽字符串有意义（占几个寄存器由它决定，和变量表里那格一样）。
 */
import { project } from '../core/project.js';
import { VAR_TYPES } from '../core/csv.js';
import { normAddr, statusNote, escapeHtml as esc } from '../core/utils.js';
import { backend } from '../api/backend.js';
import { addressHelpFor, attachAddrInput, prefixSelectHtml, placeholderFor } from '../core/addrInput.js';
import { showDialog } from './toolbar.js';

const STR_LEN_DEFAULT = 10;      // 新字符串变量默认几个字符（和变量表一致）
const TYPE_CN = { wstring: 'wstring 宽字符串' };
/** 字符串类型（占几个寄存器由"字符数"决定，变量表里也是这一格） */
const isText = (t) => ['string', 'wstring'].includes(String(t || '').toLowerCase());

/** 新建变量对话框里能选的类型：VAR_TYPES 里的**标量**（数组先不给 —— 数组从变量表展开/CSV 导入） */
export function scalarTypes() {
  return VAR_TYPES.filter(t => !String(t).endsWith('[]'));
}

/** 按类型给个合理初值（BOOL=false、数=0、字符串=''）—— 和变量表新建那条一样 */
function defaultValue(type) {
  const t = String(type || 'bool').toLowerCase();
  if (t === 'string' || t === 'wstring') return '';
  if (t === 'bool') return false;
  return 0;
}

/**
 * 打开「新建变量」对话框。
 * @param {{name?:string, onDone?:(name:string)=>void}} [opt]
 *        name  预填的变量名（就是用户在变量框里打的那个）
 *        onDone 建好之后的回调（调用方拿它把名字填回输入框）
 */
export function openAddVarDialog({ name = '', onDone } = {}) {
  const proto = backend.protocol();          // modbus / ts600 / opcua —— 三项协议，别只看 opcua
  const ua = proto === 'opcua';
  const ts = proto === 'ts600';
  // 地址写法提示跟着协议走（INVT 的 %MW… / TS600 的 D100、M10…）—— 混着提示只会让人填错
  const ph = placeholderFor(proto);
  const types = scalarTypes();
  let addrCtl = null;      // 地址框控制器（showDialog 之后建；onOk 里点「新建」时已经就绪）

  showDialog({
    title: '新建变量',
    okText: '新建',
    body: `
      <div class="f-row"><span class="f-label">名称</span>
        <input class="f-input mono" id="vaName" spellcheck="false" value="${esc(name)}"
               placeholder="变量名（PLC 里的点位名，如 Hb反向点动[7]）"></div>
      <div class="f-row"><span class="f-label">数据类型</span>
        <select class="f-input" id="vaType">
          ${types.map(t => `<option value="${esc(t)}">${esc(TYPE_CN[t] || t)}</option>`).join('')}
        </select>
        <span id="vaLenWrap" style="display:none;align-items:center;gap:6px;flex:none">
          <span style="font-size:12px;color:var(--text-2)">字符数</span>
          <input class="f-input" id="vaLen" type="number" min="1" max="250" value="${STR_LEN_DEFAULT}"
                 style="width:70px" title="字符串占几个字符（2 个字符占 1 个寄存器）">
        </span></div>
      <div class="f-row"><span class="f-label" title="${esc(addressHelpFor(proto))}">PLC 地址</span>
        <div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px">
          <div class="addr-input">
            ${prefixSelectHtml({ proto, id: 'vaPrefix' })}
            <input class="f-input mono" id="vaAddr" spellcheck="false" placeholder="${esc(ph)}">
          </div>
          <div class="addr-msg" id="vaAddrMsg"></div>
        </div></div>
      <div class="f-row"><span class="f-label"></span>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer"
               title="掉电保持：值存在跑后端那台机器上（后端重启 / 整机断电后还在）。只有**地址留空**的内部变量能勾 —— 有 PLC 地址的变量，保持是 PLC 的事。">
          <input type="checkbox" id="vaRetain" disabled><span style="font-size:12px;color:var(--text-2)">掉电保持（内部变量）</span>
        </label></div>
      <div id="vaMsg" style="color:var(--danger);font-size:12px;line-height:1.7;margin-top:6px"></div>`,
    onOk: async () => {
      const $ = (id) => document.getElementById(id);
      const nm = String($('vaName')?.value || '').trim();
      const type = String($('vaType')?.value || 'bool');
      const rawAddr = String($('vaAddr')?.value || '').trim();
      const msg = $('vaMsg');
      const bad = (t) => { if (msg) msg.textContent = t; return false; };
      if (!nm) return bad('变量名不能为空。');
      if (project.variables().some(v => v.name === nm)) {
        return bad(`变量表里已经有「${nm}」了 —— 改个名字，或者关掉这个框直接在下面选它。`);
      }
      // 地址归一化（和变量表地址格 blur 时同一套）：HR100 / 100 → %MW100；NodeId 原样。
      // ⚠ 写法跟当前协议不匹配**不拦**（后端按内部变量处理：不采集、不下发、不报错）。
      const address = rawAddr ? normAddr(rawAddr) : '';
      if (rawAddr && !address) {
        return bad('地址不合法：留空表示内部变量，或者填 '
          + (ua ? 'ns=4;s=… 这样的 NodeId。' : (ts ? 'D100 / M10 / X17 这样的地址。' : '%MW100 / %MX0.0 这样的地址。')));
      }
      // 地址对不对以后端校验为准（老后端退回本地 addrMap）：只有 **语法/范围/类型错** 才拦；
      // 「写法与协议不匹配 = 内部变量」照旧放行（既有现场口径）。
      if (address && addrCtl) {
        const res = await addrCtl.validateNow();
        if (res && res.valid === false && res.code === 'invalid') {
          return bad(`地址不合法：${res.message || rawAddr}`);
        }
      }
      const len = isText(type) ? Math.max(1, Math.min(250, Math.round(Number($('vaLen')?.value) || STR_LEN_DEFAULT))) : 0;
      const v = { name: nm, type, address, value: defaultValue(type), len };
      if ($('vaRetain')?.checked && !address) v.retain = true;      // 保持只对内部变量有意义
      project.data.variables.push(v);
      project.commit('新建变量');
      statusNote(address
        ? `已新建变量「${nm}」（${type} · ${address}）`
        : `已新建内部变量「${nm}」（${type}${v.retain ? ' · 掉电保持' : ''}）`);
      if (typeof onDone === 'function') onDone(nm);
      return true;
    },
  });

  const typeSel = document.getElementById('vaType');
  const addrInp = document.getElementById('vaAddr');
  const retain = document.getElementById('vaRetain');
  const lenWrap = document.getElementById('vaLenWrap');
  const sync = () => {
    const t = String(typeSel?.value || 'bool');
    if (lenWrap) lenWrap.style.display = isText(t) ? 'flex' : 'none';
    // 地址留空才谈得上「保持」（有地址 = 保持由 PLC 负责，跟变量表那条规矩一样）
    if (retain) {
      const internal = !String(addrInp?.value || '').trim();
      retain.disabled = !internal;
      if (!internal) retain.checked = false;
    }
  };
  typeSel?.addEventListener('change', sync);
  addrInp?.addEventListener('input', sync);

  // 前缀下拉 + 编号框：下拉来自协议地址目录（老后端用本地 FALLBACK，行为一致）；
  // 校验走后端（防抖 250ms / blur / 点「新建」前），invalid 红边红字、不匹配写法灰字内部变量。
  if (addrInp) {
    addrCtl = attachAddrInput({
      proto,
      input: addrInp,
      prefix: document.getElementById('vaPrefix'),
      msg: document.getElementById('vaAddrMsg'),
      vtype: String(typeSel?.value || 'bool'),
      write: true,           // 变量可能被控件写：只读地址（X / %IX）要提示
      titleOnValid: true,
      // 校验用归一化后的地址（HR7 → %MW7、mx100.0 → %MX100.0），和 onOk 里 normAddr 同一套
      normalize: (v) => (v ? (normAddr(v) || v) : ''),
    });
    typeSel?.addEventListener('change', () => addrCtl?.setVtype(String(typeSel?.value || 'bool')));
  }
  sync();
  document.getElementById('vaName')?.focus();
  document.getElementById('vaName')?.select?.();
}
