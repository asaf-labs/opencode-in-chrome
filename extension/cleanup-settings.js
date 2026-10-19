export const DEFAULT_ARCHIVE_HOURS = 3;

export function validateArchiveHours(hours) {
  if (!Number.isInteger(hours) || hours < 1 || hours > 168)
    throw new Error('Archive delay must be a whole number of hours from 1 to 168.');
  return hours;
}

export function migrateCleanupSettings(settings) {
  if (settings.archiveAfterHours !== undefined) return settings;
  // Do not silently shorten cleanup for profiles already opted in under the old rule.
  return {
    ...settings,
    archiveAfterHours: settings.autoArchive === true ? 24 : DEFAULT_ARCHIVE_HOURS,
  };
}
