/**
 * alarmBar.js — 报警条排版：把「一串报警」量出宽度、决定要不要一直滚
 *
 * 报警条内容是**所有当前报警拼成的一串**（[时间] 内容 ● [时间] 内容 …）。
 * DOM 里这串文字放两份，CSS 用 translateX(-50%) 从头滚到尾 —— 两份首尾相接，
 * 滚到第二份时正好与第一份重合，所以是**无缝循环**，不会滚完突然跳回开头。
 *
 * 这里只做两件事：
 *   · 量出「一份」有多宽：宽过可视区才滚动（不然短文字在条里晃来晃去很闹）
 *   · 按「滚动速度 px/s」折算出一份滚完要几秒写进 --ab-dur
 * 报警内容或变量一变，报警控件会整体重绘，重绘后由 runtime/canvas 再调一次 layoutAlarmBars。
 */

/** 一份内容（含尾部间隔）的宽度 */
function copyWidth(reel) {
  const first = reel.querySelector('.ab-copy');
  if (!first) return 0;
  const r = first.getBoundingClientRect();
  return r.width || first.scrollWidth || 0;
}

export function layoutBar(bar) {
  if (!bar) return;
  const reel = bar.querySelector('.ab-reel');
  const view = bar.querySelector('.ab-view');
  if (!reel || !view) return;
  const w1 = copyWidth(reel);
  const vw = view.clientWidth;
  const pxPerSec = Math.max(10, Number(bar.dataset.abSpeed) || 40);
  const want = bar.dataset.abSpeed !== '0' && w1 > vw + 4;   // 超长才滚
  bar.classList.toggle('roll', want);
  if (want) {
    const dur = w1 / pxPerSec;
    reel.style.setProperty('--ab-dur', `${Math.min(60, Math.max(2, dur)).toFixed(2)}s`);
  }
}

/** 一整页/画布重绘后调一次 */
export function layoutAlarmBars(root) {
  (root || document).querySelectorAll('.w-alarmbar').forEach(layoutBar);
}
