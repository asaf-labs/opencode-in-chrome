import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execute = promisify(execFile);

// Title lookup is cosmetic. Failures must never prevent a browser action.
export function createSessionTitleResolver({ run = execute, now = Date.now } = {}) {
  const cache = new Map();
  return async (sessionID) => {
    if (!/^ses[\w-]+$/.test(sessionID || '')) return undefined;
    const previous = cache.get(sessionID);
    if (previous && now() - previous.time < 30000) return previous.value;
    const value = (async () => {
      try {
        const { stdout } = await run(
          process.platform === 'win32' ? 'opencode.exe' : 'opencode',
          ['api', 'get', `/api/session/${sessionID}`],
          { timeout: 2000, maxBuffer: 256 * 1024, windowsHide: true, shell: false },
        );
        const session = JSON.parse(stdout).data;
        if (session?.id !== sessionID || typeof session.title !== 'string') return undefined;
        return (
          session.title
            .replace(/[\p{Cc}\p{Cf}]/gu, '')
            .trim()
            .slice(0, 120) || undefined
        );
      } catch {
        return undefined;
      }
    })();
    if (cache.size >= 500) cache.delete(cache.keys().next().value);
    cache.set(sessionID, { time: now(), value });
    return value;
  };
}

export const resolveSessionTitle = createSessionTitleResolver();
