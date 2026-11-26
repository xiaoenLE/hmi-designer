/** 工程自定义级别沿用四档优先级，级别本身用稳定的 ID 区分。 */
export const ALARM_LEVELS = [
  { v: 'info', t: '提示', color: '#0ea5e9', bg: '#e0f2fe', rank: 0 },
  { v: 'warn', t: '警告', color: '#f59e0b', bg: '#fef3c7', rank: 1 },
  { v: 'alarm', t: '报警', color: '#ef4444', bg: '#fee2e2', rank: 2 },
  { v: 'urgent', t: '紧急', color: '#b91c1c', bg: '#fecaca', rank: 3 },
];

const builtin = new Map(ALARM_LEVELS.map(level => [level.v, level]));
export const alarmLevelOf = (id, custom = []) =>
  builtin.get(id) || custom.find(level => level.v === id) || builtin.get('alarm');

export function normalizeAlarmLevels(levels) {
  if (!Array.isArray(levels)) return [];
  const ids = new Set(builtin.keys());
  const custom = [];
  for (const level of levels) {
    const v = typeof level?.v === 'string' ? level.v : '';
    const t = typeof level?.t === 'string' ? level.t.trim() : '';
    if (!t || !/^[a-z][\w-]*$/i.test(v) || ids.has(v)) continue;
    const color = typeof level.color === 'string' && /^#[\da-f]{6}$/i.test(level.color) ? level.color : '#7c3aed';
    const rank = Number.isInteger(level.rank) && level.rank >= 0 && level.rank <= 3 ? level.rank : 2;
    ids.add(v);
    custom.push({ v, t, color, rank });
  }
  return custom;
}

export function alarmLevelMatcher(filter) {
  if (Array.isArray(filter)) {
    const selected = new Set(filter);
    return level => selected.has(level.v);
  }
  if (filter === 'urgent') return level => level.v === 'urgent';
  if (typeof filter === 'string' && filter.startsWith('only:')) {
    const id = filter.slice('only:'.length);
    return level => level.v === id;
  }
  // 旧报警条保存的是最低级别，用户改为逐项勾选时才改用 ID 数组。
  const minimum = builtin.get(filter)?.rank ?? 0;
  return level => level.rank >= minimum;
}
