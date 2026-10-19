const secretName =
  /authorization|cookie|password|passwd|secret|token|api.?key|session|credential|card.?number|cvv|ssn/i;
const safeHeader =
  /^(content-type|content-length|accept|cache-control|etag|last-modified|date|server|x-request-id|traceparent|access-control-allow-origin)$/i;

export function redactText(value, limit = 2000) {
  return String(value ?? '')
    .slice(0, limit)
    .replace(/Bearer\s+[^\s,"']+/gi, 'Bearer [redacted]')
    .replace(
      /((?:password|passwd|secret|token|api[_-]?key|authorization|cookie|session|credential)["']?\s*[=:]\s*)(?:"[^"]*"|'[^']*'|[^\s,;&]+)/gi,
      '$1[redacted]',
    );
}

export function redactURL(value) {
  try {
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol)) return '[non-HTTP URL]';
    url.username = '';
    url.password = '';
    url.hash = '';
    for (const key of [...url.searchParams.keys()])
      if (secretName.test(key)) url.searchParams.set(key, '[redacted]');
    return url.href.slice(0, 2000);
  } catch {
    return '[invalid URL]';
  }
}

export function redactHeaders(headers) {
  return Object.entries(headers || {})
    .slice(0, 50)
    .map(([name, value]) => ({
      name: name.slice(0, 100),
      value:
        safeHeader.test(name) && !secretName.test(name) ? redactText(value, 1000) : '[redacted]',
    }));
}

function redactJSON(value, depth = 0) {
  if (depth > 15) return '[depth limit]';
  if (Array.isArray(value)) return value.slice(0, 500).map((item) => redactJSON(item, depth + 1));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 500)
        .map(([key, item]) => [
          key,
          secretName.test(key) ? '[redacted]' : redactJSON(item, depth + 1),
        ]),
    );
  return typeof value === 'string' ? redactText(value, 20000) : value;
}

export function redactBody(value, maxChars = 20000) {
  if (typeof value !== 'string' || value.length > 128 * 1024)
    return { state: 'unavailable', reason: 'sizeLimit' };
  let text;
  try {
    text = JSON.stringify(redactJSON(JSON.parse(value)));
  } catch {
    text = redactText(value, value.length);
  }
  return { state: 'text', text: text.slice(0, maxChars), truncated: text.length > maxChars };
}

export function safeCPUProfile(profile) {
  if (
    !profile ||
    !Array.isArray(profile.nodes) ||
    profile.nodes.length > 10000 ||
    !Array.isArray(profile.samples) ||
    profile.samples.length > 60000
  )
    throw new Error('CPU profile exceeded its node or sample budget.');
  return {
    nodes: profile.nodes.map((node) => ({
      id: node.id,
      hitCount: node.hitCount,
      children: node.children,
      callFrame: {
        functionName: redactText(node.callFrame?.functionName, 200),
        scriptId: node.callFrame?.scriptId,
        url: node.callFrame?.url ? redactURL(node.callFrame.url) : '',
        lineNumber: node.callFrame?.lineNumber,
        columnNumber: node.callFrame?.columnNumber,
      },
    })),
    startTime: profile.startTime,
    endTime: profile.endTime,
    samples: profile.samples,
    timeDeltas: profile.timeDeltas,
  };
}
