import test from 'node:test';
import assert from 'node:assert/strict';

interface Settings {
  taskReminderIntervalMinutes?: string;
  taskReminderMaxCount?: string;
  taskReminderCooldownMinutes?: string;
}

function computeReminderConfig(settings: Settings, envInterval: string | undefined) {
  const intOrDefault = (val: string | undefined, def: number) => {
    const n = parseInt(val ?? '', 10);
    return Number.isNaN(n) ? def : n;
  };
  const intervalMinutes = envInterval
    ? intOrDefault(envInterval, 10)
    : intOrDefault(settings.taskReminderIntervalMinutes, 10);
  const maxReminders = intOrDefault(settings.taskReminderMaxCount, 12);
  const cooldownMinutes = intOrDefault(settings.taskReminderCooldownMinutes, 2);

  return {
    intervalMs: Math.max(1, intervalMinutes) * 60 * 1000,
    intervalMinutes: Math.max(1, intervalMinutes),
    maxReminders: Math.max(1, maxReminders),
    cooldownMs: Math.max(0, cooldownMinutes) * 60 * 1000,
    cooldownMinutes: Math.max(0, cooldownMinutes),
  };
}

test('default values: 10 min interval, 12 max reminders, 2 min cooldown', () => {
  const config = computeReminderConfig(
    {
      taskReminderIntervalMinutes: '10',
      taskReminderMaxCount: '12',
      taskReminderCooldownMinutes: '2',
    },
    undefined
  );

  assert.equal(config.intervalMinutes, 10);
  assert.equal(config.intervalMs, 600000);
  assert.equal(config.maxReminders, 12);
  assert.equal(config.cooldownMinutes, 2);
  assert.equal(config.cooldownMs, 120000);
});

test('env var overrides DB setting for interval', () => {
  const config = computeReminderConfig(
    {
      taskReminderIntervalMinutes: '10',
      taskReminderMaxCount: '12',
      taskReminderCooldownMinutes: '2',
    },
    '15'
  );

  assert.equal(config.intervalMinutes, 15);
  assert.equal(config.intervalMs, 900000);
});

test('DB setting is used when env var is not set', () => {
  const config = computeReminderConfig(
    {
      taskReminderIntervalMinutes: '20',
      taskReminderMaxCount: '5',
      taskReminderCooldownMinutes: '3',
    },
    undefined
  );

  assert.equal(config.intervalMinutes, 20);
  assert.equal(config.maxReminders, 5);
  assert.equal(config.cooldownMinutes, 3);
});

test('minimum values are enforced', () => {
  const config = computeReminderConfig(
    {
      taskReminderIntervalMinutes: '0',
      taskReminderMaxCount: '0',
      taskReminderCooldownMinutes: '-1',
    },
    undefined
  );

  assert.equal(config.intervalMinutes, 1);
  assert.equal(config.maxReminders, 1);
  assert.equal(config.cooldownMinutes, 0);
});

test('missing settings fall back to defaults', () => {
  const config = computeReminderConfig({}, undefined);

  assert.equal(config.intervalMinutes, 10);
  assert.equal(config.maxReminders, 12);
  assert.equal(config.cooldownMinutes, 2);
});

test('env var with value 1 sets minimum interval', () => {
  const config = computeReminderConfig({}, '1');

  assert.equal(config.intervalMinutes, 1);
  assert.equal(config.intervalMs, 60000);
});

test('interval was changed from old 5-minute default to 10', () => {
  const config = computeReminderConfig(
    {
      taskReminderIntervalMinutes: '10',
    },
    undefined
  );
  assert.equal(config.intervalMinutes, 10);
  assert.equal(config.intervalMs, 600000);
  assert.notEqual(config.intervalMs, 300000);
});

test('cooldown prevents reminders when set to 0', () => {
  const config = computeReminderConfig(
    {
      taskReminderCooldownMinutes: '0',
    },
    undefined
  );
  assert.equal(config.cooldownMs, 0);
});
