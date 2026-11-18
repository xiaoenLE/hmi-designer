/* ticker.js —— 统一节拍：页面切到后台也照旧按 ~20ms 推进

   问题：运行画面被切到后台（换标签页、被别的窗口盖住、最小化）时，浏览器会把
   **页面定时器**降频到最快 1 秒一次。脚本的「定时 / 循环」触发、波形采样、报警延时判定
   全都挂在这种定时器上，于是后台期间变成一秒一拍：算出来的值不连续、抓的波形一段一段。

   做法：一个节拍器，三路唤醒源合流，谁先到算谁的：
     1) 主线程 setInterval —— 前台最准，也是没有 Worker 时的兜底；
     2) Web Worker 的定时器 —— **不被隐藏页面降频**，后台期间靠它；
     3) 后端数据推送（SSE，vars:changed）—— 后端轮询一直在跑（默认 100ms），
        数据一到就顺手推一拍，即使 Worker 也被节流，节拍仍跟着数据走。
   同一时刻被多路唤醒只跑一遍（4ms 内去重），所以不会重复执行脚本。

   用法：
     import { onTick } from './ticker.js';
     const off = onTick(now => { ... });   // now = performance.now()
   退出运行态时调 off() 取消。 */
import { bus } from '../core/eventBus.js';

const TICK_MS = 20;
const DEDUP_MS = 4;

const subs = new Set();
let domTimer = null;
let worker = null;
let started = false;
let lastFire = 0;
let ticks = 0;                 // 供测试/诊断：实际推进了多少拍
let workerTicks = 0;           // 其中由 Worker 唤醒的拍数（后台是否还活着看它）

function fire() {
  const now = performance.now();
  if (now - lastFire < DEDUP_MS) return;
  lastFire = now;
  ticks++;
  for (const fn of [...subs]) {
    try { fn(now); } catch (e) { console.warn('[tick]', e); }
  }
}
/** Worker 心跳：隐藏页面里主线程定时器会被降频，这条不会 */
function onWorkerTick() {
  workerTicks++;
  fire();
}

function start() {
  if (started) return;
  started = true;
  // ① 主线程定时器（前台）
  domTimer = setInterval(fire, TICK_MS);
  // ② Worker 心跳（后台）—— 拿不到 Worker 就只靠 ①③
  try {
    if (typeof Worker === 'function') {
      worker = new Worker('/js/runtime/tickWorker.js');
      worker.onmessage = onWorkerTick;
      worker.postMessage(TICK_MS);
    }
  } catch (e) {
    worker = null;
    console.warn('[tick] Worker 不可用，后台节拍改由数据推送兜底：', e?.message || e);
  }
  // ③ 数据一到就推一拍（后端轮询一直在跑，这条后台最可靠）
  bus.on('vars:changed', fire);
  // 回到前台立刻补一拍（把后台期间该跑的补上）
  document.addEventListener('visibilitychange', () => { if (!document.hidden) fire(); });
  window.addEventListener('focus', fire);
}

/** 注册一个节拍回调；返回取消函数 */
export function onTick(fn) {
  subs.add(fn);
  start();
  return () => subs.delete(fn);
}

/** 诊断用：节拍器状态（现场/测试里看后台还走不走） */
export function tickerStats() {
  return { subs: subs.size, ticks, workerTicks, tickMs: TICK_MS,
    worker: !!worker, hidden: !!document.hidden };
}
