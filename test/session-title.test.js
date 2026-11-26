import test from 'node:test';
import assert from 'node:assert/strict';
import { createSessionTitleResolver } from '../bridge/session-title.js';

test('session title lookup is bounded, cached, sanitized and checks exact identity', async () => {
  let calls = 0,
    time = 0;
  const resolve = createSessionTitleResolver({
    now: () => time,
    run: async (_file, args, options) => {
      calls++;
      assert.deepEqual(args, ['api', 'get', '/api/session/ses_title']);
      assert.equal(options.shell, false);
      assert.equal(options.timeout, 2000);
      return {
        stdout: JSON.stringify({ data: { id: 'ses_title', title: 'Fix\n invoice\u202e upload' } }),
      };
    },
  });
  assert.deepEqual(await Promise.all([resolve('ses_title'), resolve('ses_title')]), [
    'Fix invoice upload',
    'Fix invoice upload',
  ]);
  assert.equal(calls, 1);
  time = 30001;
  await resolve('ses_title');
  assert.equal(calls, 2);
  assert.equal(await resolve('--bad'), undefined);
  for (const run of [
    async () => {
      throw new Error('CLI unavailable');
    },
    async () => ({ stdout: 'invalid' }),
    async () => ({ stdout: JSON.stringify({ data: { id: 'ses_other', title: 'Other' } }) }),
  ])
    assert.equal(await createSessionTitleResolver({ run })('ses_title'), undefined);
});
