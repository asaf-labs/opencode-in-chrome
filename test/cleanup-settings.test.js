import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ARCHIVE_HOURS,
  migrateCleanupSettings,
  validateArchiveHours,
} from '../extension/cleanup-settings.js';

test('archive delays accept only whole hours between 1 and 168', () => {
  assert.equal(DEFAULT_ARCHIVE_HOURS, 3);
  for (const hours of [1, 3, 24, 168]) assert.equal(validateArchiveHours(hours), hours);
  for (const hours of [undefined, null, '3', 0, -1, 1.5, 169, NaN, Infinity])
    assert.throws(() => validateArchiveHours(hours), /whole number/);
});

test('new cleanup defaults to 3 hours without opting in; existing opt-ins keep 24 hours', () => {
  const fresh = migrateCleanupSettings({ profileName: 'Work' });
  assert.equal(fresh.archiveAfterHours, 3);
  assert.notEqual(fresh.autoArchive, true);
  assert.equal(migrateCleanupSettings({ autoArchive: true }).archiveAfterHours, 24);
  assert.equal(migrateCleanupSettings({ autoArchive: false }).archiveAfterHours, 3);
  const chosen = { autoArchive: true, archiveAfterHours: 6 };
  assert.equal(migrateCleanupSettings(chosen), chosen);
});
