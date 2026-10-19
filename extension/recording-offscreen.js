import { encodeWalkthrough } from './video-encoder.js';

let job;
chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (message.target !== 'recording-offscreen' || sender.id !== chrome.runtime.id || sender.tab)
    return false;
  if (message.type === 'cancel') {
    if (job?.id === message.jobID) job.cancelled = true;
    respond({ cancelled: true });
    return false;
  }
  if (job) {
    respond({ error: 'Another video export is in progress.' });
    return false;
  }
  const current = { id: message.jobID, cancelled: false };
  job = current;
  encodeWalkthrough(message.segments, { cancelled: () => current.cancelled })
    .then(respond, (error) => respond({ error: error.message }))
    .finally(() => {
      job = null;
    });
  return true;
});
