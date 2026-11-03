export const extensionFiles = [
  'background.js',
  'cleanup-settings.js',
  'content.js',
  'debugger-sessions.js',
  'frame-refs.js',
  'inspection-privacy.js',
  'inspection-profiles.js',
  'inspections.js',
  'keyboard-keys.js',
  'keyboard.js',
  'lifecycle.js',
  'manifest.json',
  'page-call.js',
  'performance-capture.js',
  'popup.css',
  'popup.html',
  'popup.js',
  'recording-capture.js',
  'recording-offscreen.html',
  'recording-offscreen.js',
  'recordings.js',
  'session-browser.js',
  'update-revision.js',
  'updates.js',
  'video-encoder.js',
  'webm.js',
];

export async function digestFiles(files, read) {
  const entries = await Promise.all(
    [...files].sort().map(async (name) => [name, await read(name)]),
  );
  const bytes = new TextEncoder().encode(JSON.stringify(entries));
  const hash = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(hash)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function extensionRevision(
  read = async (name) => {
    const response = await fetch(chrome.runtime.getURL(name), { cache: 'no-store' });
    if (!response.ok) throw new Error('Unable to read installed extension code.');
    return response.text();
  },
) {
  return digestFiles(extensionFiles, read);
}
