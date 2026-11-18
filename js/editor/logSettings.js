/**
 * logSettings.js — 「日志设置…」（工程 ▾）：**这台机器**的日志策略，改完立刻生效
 *
 * 两个参数（现场最关心的两个）：
 *   · **日志保留天数**（1~30，默认 3）：服务日志 `hmi-*.log`、脚本日志 `script-*.log`、
 *     更新日志 `update-*.log` 一起按它清（启动时清一次、跨天换文件再清一次）；改小了**当场清一次**。
 *   · **脚本日志每天上限**（0.5~100MB，**默认 10**，最大就是 100）：脚本里的 hmi.log 落盘那份
 *     到顶后当天不再记（文件里留一行说明），免得把工控机的盘写满。
 *
 * 为什么设置放在**服务器**上（server/data/settings.json）而不是工程里：
 *   这是"这台机器留多少日志、占多少盘"的事 —— 换台机器/换个工程不该被带走；而且**后端要读它**
 *   （写日志、清日志都在后端做），放工程里后端还得反向去读工程文件。
 * 取值顺序：**界面上设的 > 环境变量（HMI_LOG_KEEP_DAYS / HMI_SCRIPTLOG_MAX_MB）> 默认值**；
 *   界面上没设过就跟着环境变量走（发版/部署脚本仍能统一压住）。
 *
 * ⚠ 后端要重启一次才会有这两个接口（改了 Python 代码得重启服务）—— 旧后端会 404，
 *   这里会明说"后端是旧版本"，不是静默失败。
 */
import { showDialog } from './toolbar.js';
import { backend } from '../api/backend.js';
import { statusNote, escapeHtml as esc } from '../core/utils.js';

const mb = (n) => `${(n / 1024 / 1024).toFixed(n >= 10 * 1024 * 1024 ? 0 : 1)} MB`;

export async function openLogSettings() {
  const s = await backend.logSettings().catch(() => null);
  if (!s) {
    showDialog({
      title: '日志设置',
      okText: '知道了',
      body: `<div class="dlg-hint">读不到日志设置：<b>后端没开</b>，或者后端是<b>旧版本</b>（没有这个接口）。
        日志设置存在服务器上（server/data/settings.json），所以要有后端才能改。<br>
        如果是刚升级过代码，重启一下后端（stop_server.bat → start_server.bat）再打开这里。</div>`,
    });
    return;
  }
  const lim = s.limits || {};
  const keepRange = lim.keep_days || [1, 30];
  const mbRange = lim.scriptlog_max_mb || [0.5, 100];
  const u = s.usage || {};
  const kind = u.by_kind || {};
  const usage = `${u.files || 0} 个文件 · 共 ${mb(u.bytes || 0)}`
    + (Object.keys(kind).length
      ? `（服务 ${mb(kind.hmi || 0)} · 脚本 ${mb(kind.script || 0)} · 更新 ${mb(kind.update || 0)}）`
      : '');

  showDialog({
    title: '日志设置（这台机器）',
    okText: '保存',
    body: `
      <div class="f-row"><span class="f-label">日志保留</span>
        <input class="f-input" id="logKeep" type="number" min="${keepRange[0]}" max="${keepRange[1]}"
               step="1" value="${s.keep_days}" style="width:90px">
        <span style="font-size:12px;color:var(--text-2)">天（${keepRange[0]}~${keepRange[1]}）</span></div>
      <div class="f-row"><span class="f-label">脚本日志上限</span>
        <input class="f-input" id="logMb" type="number" min="${mbRange[0]}" max="${mbRange[1]}"
               step="1" value="${s.scriptlog_max_mb}" style="width:90px">
        <span style="font-size:12px;color:var(--text-2)">MB / 天（最大 ${mbRange[1]}）</span></div>
      <div class="dlg-hint" style="margin-top:8px">
        <b>日志保留天数</b>：服务日志 <code>hmi-*.log</code>、脚本日志 <code>script-*.log</code>、
        更新日志 <code>update-*.log</code> 一起按它清（超期的文件直接删）。改小后<b>立刻清一次</b>。<br>
        <b>脚本日志上限</b>：脚本里 <code>hmi.log()</code> 落盘那份到顶后<b>当天不再记</b>
        （文件里留一行说明）；另外前端还有"每个脚本 20 行/秒"的限速，两道闸一起防写满盘。
      </div>
      <div class="dlg-hint" style="margin-top:8px">
        现在：<b>${esc(usage)}</b><br>
        <span style="color:var(--text-2)">目录 ${esc(u.dir || '')}</span>
      </div>
      <div class="dlg-hint" style="margin-top:8px;color:var(--text-2)">
        这些是<b>这台机器</b>的设置（存服务器的 <code>settings.json</code>），<b>不进工程</b>，换机器不带走。
        界面上没设过时按环境变量兜底：
        <code>HMI_LOG_KEEP_DAYS</code>（现在 ${s.fallback?.keep_days}）、
        <code>HMI_SCRIPTLOG_MAX_MB</code>（现在 ${s.fallback?.scriptlog_max_mb}）。
      </div>`,
    onOk: async () => {
      const keep = Number(document.getElementById('logKeep')?.value);
      const maxMb = Number(document.getElementById('logMb')?.value);
      const r = await backend.saveLogSettings({ keep_days: keep, scriptlog_max_mb: maxMb }).catch(e => ({ error: e.message }));
      if (!r || r.ok === false) {
        alert(`保存失败：${(r && r.error) || '后端没响应'}`);
        return false;                       // 不关对话框，让用户改完再存
      }
      const clamped = (r.keep_days !== keep || r.scriptlog_max_mb !== maxMb)
        ? `（超出范围已收敛成 ${r.keep_days} 天 / ${r.scriptlog_max_mb} MB）` : '';
      statusNote(`已保存：日志保留 ${r.keep_days} 天、脚本日志每天 ${r.scriptlog_max_mb} MB${clamped}`
        + (r.pruned ? `，顺手清掉 ${r.pruned} 个过期日志` : ''), 9000);
      return true;
    },
  });
}
