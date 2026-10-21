// Работа со слотами расписания в часовом поясе пользователя без сторонних библиотек

function tzOffset(ts, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(ts);
  const p = Object.fromEntries(parts.map((x) => [x.type, Number(x.value)]));
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}

export function ymdInTz(ts, tz) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(ts);
}

export function zonedToUtc(ymd, hm, tz) {
  const [y, m, d] = ymd.split('-').map(Number);
  const [h, mi] = hm.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - tzOffset(guess, tz);
  return guess - tzOffset(first, tz);
}

// Ближайший свободный слот после `after`. `taken` — уже занятые моменты публикаций.
export function nextFreeSlot({ slots, tz }, taken, after = Date.now()) {
  const sorted = [...slots].sort();
  if (!sorted.length) return after;
  for (let day = 0; day < 400; day++) {
    const ymd = ymdInTz(after + day * 86_400_000, tz);
    for (const hm of sorted) {
      const ts = zonedToUtc(ymd, hm, tz);
      if (ts > after && !taken.has(ts)) return ts;
    }
  }
  return after;
}
