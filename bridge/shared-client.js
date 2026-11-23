import { ensureSharedDaemon } from './shared-process.js';

export class SharedBrowserHub {
  constructor(config, options = {}) {
    this.config = config;
    this.options = options;
  }

  async call(sessionID, tool, args, signal) {
    if (!/^ses[\w-]+$/.test(sessionID || ''))
      throw new Error('This tool requires OpenCode session metadata.');
    if (signal?.aborted) throw new Error('Browser action cancelled');
    await ensureSharedDaemon(this.config, {
      ...this.options,
      ...(tool === 'connect_profile' ? { autoActivate: false } : {}),
    });
    if (signal?.aborted) throw new Error('Browser action cancelled');
    let response;
    try {
      response = await fetch(`http://127.0.0.1:${this.config.port}/call`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.config.token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionID, tool, args }),
        signal: signal
          ? AbortSignal.any([signal, AbortSignal.timeout(30000)])
          : AbortSignal.timeout(30000),
        redirect: 'error',
      });
    } catch {
      throw new Error(
        signal?.aborted
          ? 'Browser action cancelled'
          : 'Shared Chrome bridge is unreachable. Reconnect chrome in OpenCode /mcps to restart it.',
      );
    }
    const output = await response.json();
    if (!response.ok) throw new Error(output.error || 'Shared Chrome bridge rejected the request.');
    return output.result;
  }
}
