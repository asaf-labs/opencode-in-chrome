import { muxWebM } from './webm.js';

function decodeBase64(value) {
  return Uint8Array.from(atob(value), (character) => character.charCodeAt(0));
}

function encodeBase64(bytes) {
  let text = '';
  for (let offset = 0; offset < bytes.length; offset += 32768)
    text += String.fromCharCode(...bytes.subarray(offset, offset + 32768));
  return btoa(text);
}

export async function encodeWalkthrough(segments, { cancelled = () => false } = {}) {
  if (!globalThis.VideoEncoder || !globalThis.VideoFrame)
    throw new Error('This Chrome build does not support WebCodecs video encoding.');
  if (
    !Array.isArray(segments) ||
    !segments.length ||
    segments.length > 10 ||
    segments.some(
      (segment) =>
        !segment.frames?.length ||
        segment.frames.length > 100 ||
        !Number.isFinite(segment.duration) ||
        segment.duration < 1000 ||
        segment.duration > 16000,
    )
  )
    throw new Error('Invalid or oversized video segments.');
  const fps = 10,
    width = 960,
    height = 540;
  const duration = segments.reduce(
    (sum, segment) => sum + Math.ceil(segment.duration / 100) * 100,
    0,
  );
  if (duration > 90000) throw new Error('Walkthrough video is limited to 90 seconds.');
  const config = { codec: 'vp8', width, height, bitrate: 300000, framerate: fps };
  if (!(await VideoEncoder.isConfigSupported(config)).supported)
    throw new Error('VP8 video encoding is unavailable in this Chrome build.');
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  const chunks = [];
  let error,
    bytes = 0,
    timestamp = 0,
    frameCount = 0;
  const encoder = new VideoEncoder({
    output: (chunk) => {
      bytes += chunk.byteLength;
      if (bytes > 5 * 1024 * 1024) {
        error = new Error('Encoded video exceeds the 5 MiB export limit.');
        return;
      }
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push({ data, timestamp: chunk.timestamp, key: chunk.type === 'key' });
    },
    error: (value) => {
      error = value;
    },
  });
  const timeline = [];
  try {
    encoder.configure(config);
    for (const segment of segments) {
      const start = timestamp;
      let index = -1,
        bitmap;
      try {
        for (let time = 0; time < Math.ceil(segment.duration / 100) * 100; time += 100) {
          if (cancelled()) throw new Error('Video export cancelled.');
          if (error) throw error;
          let next = Math.max(0, index);
          while (next + 1 < segment.frames.length && segment.frames[next + 1].timestamp <= time)
            next++;
          if (next !== index) {
            bitmap?.close();
            bitmap = await createImageBitmap(
              new Blob([decodeBase64(segment.frames[next].data)], { type: 'image/jpeg' }),
            );
            index = next;
          }
          context.fillStyle = '#111827';
          context.fillRect(0, 0, width, height);
          const scale = Math.min(width / bitmap.width, (height - 40) / bitmap.height);
          context.drawImage(
            bitmap,
            (width - bitmap.width * scale) / 2,
            40 + (height - 40 - bitmap.height * scale) / 2,
            bitmap.width * scale,
            bitmap.height * scale,
          );
          context.fillStyle = '#ffedd5';
          context.font = '16px sans-serif';
          context.fillText(
            `Edited verified walkthrough · ${segment.id}: ${segment.description}`,
            12,
            26,
            width - 24,
          );
          const frame = new VideoFrame(canvas, { timestamp, duration: 100000 });
          try {
            encoder.encode(frame, { keyFrame: frameCount % 50 === 0 });
          } finally {
            frame.close();
          }
          timestamp += 100000;
          frameCount++;
          if (encoder.encodeQueueSize > 8) await encoder.flush();
        }
      } finally {
        bitmap?.close();
      }
      timeline.push({ startMs: start / 1000, endMs: timestamp / 1000 });
    }
    await encoder.flush();
    if (error) throw error;
    const video = muxWebM(chunks, { width, height, duration, fps });
    if (video.length > 5 * 1024 * 1024) throw new Error('Encoded video exceeds the export limit.');
    return { video: encodeBase64(video), timeline };
  } finally {
    if (encoder.state !== 'closed') encoder.close();
  }
}
