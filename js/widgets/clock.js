/**
 * clock.js — 「时钟」控件的走时
 *
 * 画布上、运行态、弹窗里所有 `[data-clock-fmt]` 的文字，统一由**一个**定时器刷新：
 *   · 格式里带毫秒（SSS）→ 100ms 刷一拍；否则 1 秒一拍；一个时钟都没有就 1.5 秒空转一次
 *   · 只在该元素文字**真的变了**才写 DOM（避免无谓的重排/重绘）
 *   · 控件 DOM 被重建（换页 / 改属性 / 画布局部重画）也不会断 —— 下一拍自动找到新元素
 *
 * 为什么不用自绘控件那一套（def.selfDrawn + requestAnimationFrame）：时钟只是改一行文字，
 * 逐帧重绘纯属浪费；定时器 + 文字比对，上千个控件时也几乎不占 CPU。
 */
import { fmtTime } from '../core/utils.js';

let timer = null;
let running = false;
let delay = 1000;

/** 刷一拍：把每个时钟的文字更新成"现在"，并按"有没有毫秒"定下一拍的间隔 */
function tick(now = Date.now()) {
  const els = document.querySelectorAll('[data-clock-fmt]');
  let hasMs = false;
  els.forEach(el => {
    const fmt = el.dataset.clockFmt || '';
    if (fmt.includes('SSS')) hasMs = true;
    const txt = fmtTime(now, fmt);
    if (el.textContent !== txt) el.textContent = txt;
  });
  delay = els.length ? (hasMs ? 100 : 1000) : 1500;
  return els.length;
}

function schedule() {
  if (!running) return;
  if (timer) clearTimeout(timer);
  timer = setTimeout(() => { tick(); schedule(); }, delay);
}

/** 立刻刷一次**并按新节奏重排下一拍**。
 *  画布重画完 / 刚改完格式时调它：否则「刚把格式改成带毫秒」要等上一拍（最多 1 秒）
 *  才提速，看着像没生效；新加的时钟也要等一拍才显示时间。 */
export function tickClocksNow() {
  tick();
  schedule();
}

export function startClockTicker() {
  if (running) return;
  running = true;
  tick();
  schedule();
}

export function stopClockTicker() {
  running = false;
  if (timer) clearTimeout(timer);
  timer = null;
}

export const clockTickerRunning = () => running;
