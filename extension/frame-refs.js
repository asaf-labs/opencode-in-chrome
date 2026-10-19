export function parseFrameRef(ref) {
  const match = /^(?:f(\d+):)?(e\d+)$/.exec(ref || '');
  if (!match) throw new Error('Invalid element ref. Call read_page again.');
  const frameID = Number(match[1] || 0);
  if (!Number.isSafeInteger(frameID)) throw new Error('Invalid frame ref.');
  return { frameID, ref: match[2] };
}

export function scopeSnapshot(snapshot, frameID) {
  return {
    ...snapshot,
    frameID,
    elements: (snapshot.elements || []).map((element) => ({
      ...element,
      frameID,
      ref: frameID === 0 ? element.ref : `f${frameID}:${element.ref}`,
    })),
  };
}

export function combineSnapshots(results) {
  const main = results.find((entry) => (entry.frameId ?? 0) === 0);
  if (!main?.result || main.result.error)
    throw new Error(main?.result?.error || 'Main frame returned no snapshot.');
  const snapshots = results
    .filter((entry) => entry.result && !entry.result.error)
    .sort((a, b) => (a.frameId ?? 0) - (b.frameId ?? 0))
    .map((entry) => scopeSnapshot(entry.result, entry.frameId ?? 0));
  const root = snapshots.find((snapshot) => snapshot.frameID === 0);
  return {
    ...root,
    text: snapshots
      .map((snapshot) =>
        snapshot.frameID === 0
          ? snapshot.text || ''
          : `\n[Frame ${snapshot.frameID}: ${snapshot.title || snapshot.url || ''}]\n${snapshot.text || ''}`,
      )
      .join('\n')
      .slice(0, 40000),
    elements: snapshots.flatMap((snapshot) => snapshot.elements),
    totalElements: snapshots.reduce(
      (total, snapshot) => total + (snapshot.totalElements ?? snapshot.elements.length),
      0,
    ),
    elementsTruncated: snapshots.some((snapshot) => snapshot.elementsTruncated),
    frames: results.map((entry) => ({
      frameID: entry.frameId ?? 0,
      ...(entry.result?.error
        ? { error: entry.result.error }
        : {
            documentID: entry.result?.documentID,
            title: entry.result?.title,
            url: entry.result?.url,
          }),
    })),
  };
}
