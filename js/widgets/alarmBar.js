/** 按可视区和文字的实际宽度计算一轮滚动的距离和时长。 */
function layoutBar(bar) {
  if (bar.dataset.abSpeed === '0') return;
  const reel = bar.querySelector('.ab-reel');
  const view = bar.querySelector('.ab-view');
  const textWidth = reel.offsetWidth;
  const viewWidth = view.clientWidth;
  if (!textWidth || !viewWidth) return;

  // 这里用画布内的宽度，缩放画面时不会重复计入缩放比例。
  const speed = Number(bar.dataset.abSpeed);
  reel.style.setProperty('--ab-start', `${viewWidth}px`);
  reel.style.setProperty('--ab-dur', `${(viewWidth + textWidth) / speed}s`);
  bar.classList.add('roll');
}

/** 报警条插入页面或内容更新后，启动滚动。 */
export function layoutAlarmBars(root) {
  root?.querySelectorAll('.w-alarmbar').forEach(layoutBar);
}
