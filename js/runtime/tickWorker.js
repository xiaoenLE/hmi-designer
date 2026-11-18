/* tickWorker.js —— 「后台也在走」的节拍源（很薄的一个文件）

   为什么需要它：浏览器对**不可见页面**的定时器会降频（Chromium 把 setInterval/setTimeout
   压到最快 1 秒一次，再久还会「强化节流」）。HMI 运行画面被切到后台/被别的窗口盖住时，
   脚本的「定时/循环」触发和波形采样就跟着变成一秒一次 —— 现场看到的就是
   「波形一段一段的、算出来的值不连续」。

   Worker 里的定时器不受这条「隐藏页面定时器降频」影响，所以让它当心跳源，
   主线程收到消息再干活（消息事件不会被降频）。

   用法：new Worker('/js/runtime/tickWorker.js')，postMessage(间隔毫秒) 启动/改间隔。 */
let timer = null;
self.onmessage = (e) => {
  const ms = Math.max(4, Math.min(1000, Number(e.data) || 20));
  if (timer) clearInterval(timer);
  timer = setInterval(() => self.postMessage(1), ms);
};
