/* 网页版和桌面版共用取色框、色板和最近用过的颜色。
   吸管在桌面版走 Win32 采屏接口，在支持的浏览器中走 EyeDropper。 */

const SWATCHES = ['#000000', '#ffffff', '#c3cbd6', '#334155', '#2563eb', '#06b6d4',
  '#22c55e', '#eab308', '#f97316', '#ef4444', '#a855f7', '#ec4899'];

const hexColor = value => /^#?[0-9a-f]{6}$/i.test(value) ? '#' + value.replace(/^#/, '').toLowerCase() : '';
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));
const hexToRgb = value => {
  const hex = hexColor(value);
  if (!hex) return null;
  const n = parseInt(hex.slice(1), 16);
  return [n >> 16 & 255, n >> 8 & 255, n & 255];
};
const rgbToHex = rgb => '#' + rgb.map(v => clamp(Math.round(v), 0, 255).toString(16).padStart(2, '0')).join('');
const rgbToHsv = ([r, g, b]) => {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  let h = 0;
  if (d) {
    if (max === r) h = ((g - b) / d + 6) % 6;
    else if (max === g) h = (b - r) / d + 2;
    else h = (r - g) / d + 4;
    h *= 60;
  }
  return { h, s: max ? d / max : 0, v: max };
};
const hsvToRgb = ({ h, s, v }) => {
  const c = v * s, x = c * (1 - Math.abs((h / 60) % 2 - 1)), m = v - c;
  const seg = Math.floor(h / 60) % 6;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][seg];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
};

const desktopApi = () => globalThis.pywebview?.api;
const canNativeSample = () => typeof desktopApi()?.pick_color_start === 'function';
const canEyeDropper = () => !globalThis.pywebview && typeof globalThis.EyeDropper === 'function';

export function initColorPicker(onClose) {
  let picker;
  let open;
  const openFor = e => {
    const input = e.target;
    if (e.button > 0 || !input?.matches?.('input[type="color"]:enabled')) return;
    e.preventDefault();
    if (!picker) ({ picker, open } = makePicker(onClose));
    if (!picker.open) open(input);
  };
  // WebView2 在指针按下时拦原生框。网页和键盘激活统一走 click。
  document.addEventListener('pointerdown', e => {
    if (desktopApi()) openFor(e);
  }, true);
  document.addEventListener('click', openFor, true);
  return () => picker?.open === true;
}

function makePicker(onClose) {
  const picker = document.createElement('dialog');
  picker.className = 'desktop-colors';
  picker.setAttribute('aria-labelledby', 'desktopColorTitle');
  picker.innerHTML = `<form>
    <h2 id="desktopColorTitle">选择颜色</h2>
    <div class="dc-area" data-area tabindex="0" role="application" aria-label="饱和度与明度：拖动或用方向键调整">
      <span class="dc-cursor" data-cursor></span>
    </div>
    <div class="dc-bar">
      <button type="button" class="dc-drop" data-sample hidden aria-label="吸管取色" aria-pressed="false"
        title="吸管取色：在屏幕上点一下就取到那个点的颜色">
        <svg viewBox="0 0 24 24" width="17" height="17" aria-hidden="true" fill="none" stroke="currentColor"
          stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">
          <path d="m14.6 6.4 3 3"/><path d="M17 3.5 20.5 7l-9.2 9.2-3.5.6.6-3.5Z"/>
          <path d="M7.8 16.2 4.5 19.5"/>
        </svg>
      </button>
      <span class="dc-preview" data-preview aria-hidden="true"></span>
      <input class="dc-hue" type="range" min="0" max="360" step="1" data-hue aria-label="色相">
    </div>
    <label class="dc-hex">颜色代码 <input type="text" class="f-input" data-hex maxlength="7" spellcheck="false" placeholder="#RRGGBB"></label>
    <div class="desktop-color-rgb">${['红', '绿', '蓝'].map((name, i) =>
      `<label>${name}<input type="number" class="f-input" min="0" max="255" step="1" data-channel="${i}"></label>`).join('')}</div>
    <div class="desktop-color-swatches" aria-label="常用颜色">${SWATCHES.map(color =>
      `<button type="button" data-color="${color}" aria-label="${color}" title="${color}" style="background:${color}"></button>`).join('')}</div>
    <div class="desktop-color-recent" data-recent-box hidden>
      <span class="dc-recent-title">最近用过</span>
      <div class="dc-recent-list" data-recent-list></div>
    </div>
    <p data-hint role="status" hidden></p>
    <p data-error role="status" hidden></p>
    <div class="desktop-color-buttons">
      <button type="button" class="tb-btn" data-cancel>取消</button>
      <button type="submit" class="tb-btn primary">应用</button>
    </div>
  </form>`;
  document.body.append(picker);

  const form = picker.querySelector('form');
  const area = picker.querySelector('[data-area]');
  const cursor = picker.querySelector('[data-cursor]');
  const hue = picker.querySelector('[data-hue]');
  const hex = picker.querySelector('[data-hex]');
  const swatch = picker.querySelector('[data-preview]');
  const channels = [...picker.querySelectorAll('[data-channel]')];
  const error = picker.querySelector('[data-error]');
  const hint = picker.querySelector('[data-hint]');
  const sample = picker.querySelector('[data-sample]');
  const recentBox = picker.querySelector('[data-recent-box]');
  const recentList = picker.querySelector('[data-recent-list]');

  let target;
  let targetProp = '';
  let original = '';              // 打开时那个输入框里的颜色（取消要还原）
  let committed = false;          // 点过「应用」：close 时不要再还原
  let hsv = { h: 0, s: 0, v: 0 };
  let sampling = null;            // 采屏中：{ timer }；null = 没在采

  const showError = text => { error.textContent = text; error.hidden = false; };
  const showHint = text => { hint.textContent = text; hint.hidden = !text; };

  /* 选中的 input 可能已经被属性面板重渲染换掉了 —— 按 data-prop 把新的那个找回来。
     以前这里只认 `target.isConnected`，一旦重渲染就静默什么都不做（用户看到的就是"选了色没反应"）。 */
  const liveTarget = () => {
    if (target?.isConnected && !target.disabled) return target;
    if (!targetProp) return null;
    const prop = globalThis.CSS?.escape ? CSS.escape(targetProp) : targetProp;
    return document.querySelector(`input[type="color"][data-prop="${prop}"]:enabled`);
  };
  /* 边拖边看效果（和浏览器原生取色框一样即时生效）；真正的落库靠 properties.js 的防抖提交 */
  const applyLive = color => {
    const input = liveTarget();
    if (!input || input.value === color) return;
    input.value = color;
    if (!input.hasAttribute('data-color-commit-only')) input.dispatchEvent(new Event('input', { bubbles: true }));
  };

  /** 按当前 hsv 重画整个框；opts.apply=false 时不往画布上实时生效（打开/采色中途用） */
  const render = (opts = {}) => {
    const rgb = hsvToRgb(hsv);
    const color = rgbToHex(rgb);
    hue.value = String(Math.round(hsv.h));
    area.style.backgroundImage =
      `linear-gradient(to top, #000, rgb(0 0 0 / 0)), linear-gradient(to right, #fff, hsl(${Math.round(hsv.h)} 100% 50%))`;
    cursor.style.left = `${hsv.s * 100}%`;
    cursor.style.top = `${(1 - hsv.v) * 100}%`;
    swatch.style.backgroundColor = color;
    if (!opts.skipRgb) channels.forEach((input, i) => { input.value = String(Math.round(rgb[i])); });
    if (opts.syncHex !== false) hex.value = color;
    error.hidden = true;
    if (opts.apply !== false && !sampling) applyLive(color);
    return color;
  };
  const setHex = (color, opts = {}) => {
    const rgb = hexToRgb(color);
    if (!rgb) return '';
    hsv = rgbToHsv(rgb);
    return render(opts);
  };

  /* ── 色板：按下/拖动取色（指针捕获，拖出去也继续跟着走）────────────── */
  const areaPick = e => {
    const box = area.getBoundingClientRect();
    hsv = {
      ...hsv,
      s: clamp((e.clientX - box.left) / box.width, 0, 1),
      v: 1 - clamp((e.clientY - box.top) / box.height, 0, 1),
    };
    render();
  };
  area.addEventListener('pointerdown', e => {
    e.preventDefault();
    area.focus({ preventScroll: true });
    try { area.setPointerCapture(e.pointerId); } catch { /* 老内核没有就没捕获，也能用 */ }
    areaPick(e);
  });
  area.addEventListener('pointermove', e => { if (area.hasPointerCapture?.(e.pointerId)) areaPick(e); });
  area.addEventListener('pointerup', e => { if (area.hasPointerCapture?.(e.pointerId)) area.releasePointerCapture(e.pointerId); });
  area.addEventListener('pointercancel', e => { if (area.hasPointerCapture?.(e.pointerId)) area.releasePointerCapture(e.pointerId); });
  // 键盘：方向键微调饱和度/明度（Shift 走大步），和原生取色框一个手感
  area.addEventListener('keydown', e => {
    const step = (e.shiftKey ? 0.1 : 0.01);
    const move = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] }[e.key];
    if (!move) return;
    e.preventDefault();
    hsv = { ...hsv, s: clamp(hsv.s + move[0], 0, 1), v: clamp(hsv.v + move[1], 0, 1) };
    render();
  });

  hue.addEventListener('input', () => { hsv = { ...hsv, h: Number(hue.value) }; render(); });

  hex.addEventListener('input', () => {
    const color = hexColor(hex.value.trim());
    if (!color) return;
    hsv = rgbToHsv(hexToRgb(color));
    render({ syncHex: false });
  });
  hex.addEventListener('change', () => {
    const color = hexColor(hex.value.trim());
    if (!color) { showError('请输入六位颜色代码，例如 #2563eb。'); hex.focus(); return; }
    hsv = rgbToHsv(hexToRgb(color));
    render();
  });

  channels.forEach(input => input.addEventListener('input', () => {
    const rgb = channels.map((channel, i) => clamp(Number(channel.value) || 0, 0, 255));
    if (String(channels[0].value) === '' && String(channels[1].value) === '' && String(channels[2].value) === '') return;
    hsv = rgbToHsv(rgb);
    render({ skipRgb: true });
  }));

  picker.querySelectorAll('[data-color]').forEach(btn =>
    btn.addEventListener('click', () => setHex(btn.dataset.color)));

  /* ── 最近用过的颜色：存在 localStorage，点「应用」就记一条（最新的排最前）── */
  const RECENT_KEY = 'hmi-recent-colors';
  const RECENT_MAX = 8;
  const loadRecent = () => {
    try {
      const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]');
      return Array.isArray(list) ? list.map(hexColor).filter(Boolean).slice(0, RECENT_MAX) : [];
    } catch { return []; }
  };
  const renderRecent = () => {
    const list = loadRecent();
    recentBox.hidden = !list.length;
    recentList.innerHTML = list.map(color =>
      `<button type="button" data-recent="${color}" aria-label="最近用过 ${color}" title="${color}" style="background:${color}"></button>`).join('');
  };
  const pushRecent = color => {
    const c = hexColor(color);
    if (!c) return;
    const list = [c, ...loadRecent().filter(item => item !== c)].slice(0, RECENT_MAX);
    try { localStorage.setItem(RECENT_KEY, JSON.stringify(list)); } catch { /* 存不下算了，不影响取色 */ }
    renderRecent();
  };
  recentList.addEventListener('click', e => {
    const btn = e.target.closest('[data-recent]');
    if (btn) setHex(btn.dataset.recent);
  });
  picker.querySelector('[data-cancel]').addEventListener('click', () => picker.close());

  /* ── 吸管：桌面窗口走后端采屏（实时颜色轮询回来，点左键确认）────────── */
  const stopSampling = () => {
    if (!sampling) return;
    clearTimeout(sampling.timer);
    sampling = null;
    setSamplingLook(false);
    try { desktopApi()?.pick_color_stop?.(); } catch { /* 后端没起来就算了 */ }
  };
  // 采色中的吸管按钮：图标按钮没有文字了，靠 aria-pressed + class 表现"正在取色"
  const setSamplingLook = (on) => {
    picker.classList.toggle('sampling', on);
    sample.classList.toggle('on', on);
    sample.setAttribute('aria-pressed', on ? 'true' : 'false');
    sample.title = on ? '再点一下停止取色' : '吸管取色：在屏幕上点一下就取到那个点的颜色';
  };
  const pickNative = async () => {
    const api = desktopApi();
    const session = sampling = { timer: 0 };
    setSamplingLook(true);
    showHint('在屏幕上移动鼠标，看到想要的颜色就点左键（Esc 取消）。');
    let started;
    // 等画布去掉取色框后再采屏。
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    if (sampling !== session) return;
    try { started = await api.pick_color_start(); } catch (e) { started = { ok: false, error: String(e) }; }
    if (sampling !== session) return;
    if (!started?.ok) {
      stopSampling();
      showHint('');
      showError(started?.error || '屏幕取色启动失败，请用色板、色块或颜色代码选色。');
      return;
    }
    const tick = async () => {
      if (sampling !== session) return;
      let state;
      try { state = await api.pick_color_read(); } catch { state = null; }
      if (sampling !== session) return;
      if (state?.hex) setHex(state.hex, { apply: false });
      if (state?.state === 'done') {
        const color = hexColor(state.hex || '');
        stopSampling();
        showHint('');
        if (color) setHex(color);
        else showError('取不到这个位置的颜色，请再试一次。');
        return;
      }
      if (!state || state.state === 'cancelled' || state.state === 'idle') {
        stopSampling();
        showHint('');
        return;
      }
      session.timer = setTimeout(tick, 45);
    };
    tick();
  };
  const pickEyeDropper = async () => {
    // WebView2 里 EyeDropper 会「开得起来、永远不返回」（实测：窗口一直挂着，点屏幕也不回话），
    // 所以这条路只在浏览器里用；万一真挂住了，12 秒后给句人话，别让按钮永远是"取色中"。
    const stuck = setTimeout(() => {
      if (picker.open) showHint('这个窗口吸不到屏幕颜色，请用色板、色块或颜色代码选色。');
    }, 12000);
    try {
      const { sRGBHex } = await new EyeDropper().open();
      if (picker.open) setHex(sRGBHex);
    } catch (e) {
      // AbortError = 用户自己按 Esc 取消，不用提示；其它情况（比如 WebView2 吸不到色）必须说出来
      if (e?.name !== 'AbortError' && picker.open) {
        showError('这个窗口吸不到屏幕颜色，请用色板、色块或颜色代码选色。');
      }
    } finally {
      clearTimeout(stuck);
    }
  };
  sample.addEventListener('click', () => {
    if (sampling) { stopSampling(); showHint(''); return; }
    if (canNativeSample()) pickNative();
    else if (canEyeDropper()) pickEyeDropper();
    else showError('当前窗口不支持屏幕取色，请用色板、色块或颜色代码选色。');
  });

  /* 取消/按 Esc 关掉：把实时生效的颜色还原回打开时的样子 */
  const restoreOriginal = () => {
    if (!original) return;
    const input = liveTarget();
    if (!input) return;
    const changed = input.value !== original;
    input.value = original;
    if (input.hasAttribute('data-color-commit-only')) return;
    if (!input.dispatchEvent(new Event('hmi:color-cancel', { cancelable: true })) || !changed) return;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  picker.addEventListener('cancel', e => {
    if (!sampling) return;
    e.preventDefault();
    stopSampling();
    showHint('');
  });
  picker.addEventListener('close', () => {
    stopSampling();
    showHint('');
    if (!committed) restoreOriginal();
    committed = false;
    target = null;
    targetProp = '';
    original = '';
    onClose();
  });

  form.addEventListener('submit', e => {
    e.preventDefault();
    const color = hexColor(hex.value.trim());
    if (!color) { showError('请输入六位颜色代码，例如 #2563eb。'); hex.focus(); return; }
    stopSampling();
    committed = true;
    pushRecent(color);                 // 记进「最近用过」，下次点开就在那儿
    const input = liveTarget();
    picker.close();
    if (!input) return;
    input.focus({ preventScroll: true });
    input.value = color;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  });

  /* ── 摆在属性面板旁边（用户提的：别浮在画布正中间，边看控件边调色）────────
     做法：模态框还是模态框（Esc/焦点都在），但位置改成 fixed 手动算 ——
     优先贴属性面板左侧，竖向对齐正在改的那个颜色输入框；放不下就贴屏幕边。 */
  const placePicker = () => {
    if (!picker.open) return;
    picker.style.position = 'fixed';
    picker.style.inset = 'auto';
    picker.style.margin = '0';
    const box = picker.getBoundingClientRect();
    const gap = 10;
    const panel = document.getElementById('rightPanel') || document.getElementById('panel-properties');
    const pr = panel?.getBoundingClientRect();
    let left;
    if (pr && pr.width && pr.left > box.width + gap * 2) {
      left = pr.left - box.width - gap;          // 属性面板左边
    } else if (pr && pr.width && pr.right + gap + box.width <= window.innerWidth) {
      left = pr.right + gap;                     // 左边放不下就放右边
    } else {
      left = (window.innerWidth - box.width) / 2;
    }
    const ir = target?.isConnected ? target.getBoundingClientRect() : null;
    let top = ir ? ir.top + ir.height / 2 - box.height / 2 : (window.innerHeight - box.height) / 2;
    top = Math.max(gap, Math.min(top, window.innerHeight - box.height - gap));
    left = Math.max(gap, Math.min(left, window.innerWidth - box.width - gap));
    picker.style.left = `${Math.round(left)}px`;
    picker.style.top = `${Math.round(top)}px`;
  };
  const followWindow = () => { if (picker.open) placePicker(); };
  window.addEventListener('resize', followWindow);
  document.addEventListener('scroll', followWindow, true);

  return {
    picker,
    open(input) {
      target = input;
      targetProp = input?.dataset?.prop || '';
      original = hexColor(input?.value || '') || '';
      committed = false;
      showHint('');
      error.hidden = true;
      setHex(original || '#ffffff', { apply: false });
      renderRecent();                            // 「最近用过」每次打开都按最新记录重画
      sample.hidden = !canNativeSample() && !canEyeDropper();
      setSamplingLook(false);
      input.dispatchEvent(new Event('hmi:color-open'));
      picker.showModal();
      placePicker();
      requestAnimationFrame(placePicker);        // 再对一次：首次 showModal 后尺寸可能晚一帧才准
    },
  };
}
