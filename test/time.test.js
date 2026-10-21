import test from 'node:test';
import assert from 'node:assert/strict';
import { nextFreeSlot, zonedToUtc } from '../server/time.js';

const tz = 'Europe/Moscow';

test('слот считается в часовом поясе пользователя', () => {
  assert.equal(zonedToUtc('2026-10-21', '18:00', tz), Date.UTC(2026, 9, 21, 15, 0));
});

test('ближайший слот сегодня, если он ещё не прошёл', () => {
  const now = Date.UTC(2026, 9, 21, 9, 0); // 12:00 МСК
  assert.equal(nextFreeSlot({ slots: ['18:00'], tz }, new Set(), now), Date.UTC(2026, 9, 21, 15, 0));
});

test('занятые слоты пропускаются, переходим на следующий день', () => {
  const now = Date.UTC(2026, 9, 21, 9, 30);
  const taken = new Set([Date.UTC(2026, 9, 21, 15, 0), Date.UTC(2026, 9, 22, 9, 0)]);
  assert.equal(nextFreeSlot({ slots: ['12:00', '18:00'], tz }, taken, now), Date.UTC(2026, 9, 22, 15, 0));
});

test('учитывает переход на летнее время', () => {
  // Нью-Йорк: 1 ноября 2026 переход с EDT (-4) на EST (-5)
  assert.equal(zonedToUtc('2026-10-31', '18:00', 'America/New_York'), Date.UTC(2026, 9, 31, 22, 0));
  assert.equal(zonedToUtc('2026-11-02', '18:00', 'America/New_York'), Date.UTC(2026, 10, 2, 23, 0));
});
