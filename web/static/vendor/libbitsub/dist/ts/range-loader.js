const DEFAULT_RANGE_CHUNK_THRESHOLD = 2 * 1024 * 1024;
const DEFAULT_RANGE_CHUNK_SIZE = 512 * 1024;
function emitProgress(onProgress, loaded, total, rangeSupported, strategy) {
    if (!onProgress)
        return;
    onProgress({
        loaded,
        total,
        ratio: total && total > 0 ? Math.min(1, loaded / total) : null,
        rangeSupported,
        strategy
    });
}
function parseContentLength(header) {
    if (!header)
        return null;
    const value = Number(header);
    return Number.isFinite(value) && value >= 0 ? value : null;
}
function parseContentRangeTotal(header) {
    if (!header)
        return null;
    const match = /bytes\s+(?:\d+-\d+|\*)\/(\d+|\*)/i.exec(header);
    if (!match)
        return null;
    if (match[1] === '*')
        return null;
    return parseContentLength(match[1]);
}
function mergeHeaders(base, extra) {
    const headers = new Headers(base);
    if (extra) {
        const more = new Headers(extra);
        more.forEach((value, key) => headers.set(key, value));
    }
    return headers;
}
export async function probeRangeSupport(url, options = {}) {
    const headers = mergeHeaders(options.headers, { Range: 'bytes=0-0' });
    try {
        const response = await fetch(url, {
            method: 'GET',
            headers,
            signal: options.signal
        });
        if (response.status === 206) {
            const size = parseContentRangeTotal(response.headers.get('content-range')) ??
                parseContentLength(response.headers.get('content-length'));
            try {
                await response.body?.cancel();
            }
            catch {
                /* ignore */
            }
            return {
                supportsRange: true,
                size,
                acceptRanges: response.headers.get('accept-ranges')
            };
        }
        if (response.ok) {
            const accept = response.headers.get('accept-ranges');
            const size = parseContentLength(response.headers.get('content-length'));
            try {
                await response.body?.cancel();
            }
            catch {
                /* ignore */
            }
            return {
                supportsRange: Boolean(accept && accept.toLowerCase() !== 'none'),
                size,
                acceptRanges: accept
            };
        }
    }
    catch {
        /* try HEAD */
    }
    try {
        const head = await fetch(url, {
            method: 'HEAD',
            headers: mergeHeaders(options.headers),
            signal: options.signal
        });
        if (!head.ok) {
            return { supportsRange: false, size: null, acceptRanges: null };
        }
        const accept = head.headers.get('accept-ranges');
        return {
            supportsRange: Boolean(accept && accept.toLowerCase() !== 'none'),
            size: parseContentLength(head.headers.get('content-length')),
            acceptRanges: accept
        };
    }
    catch {
        return { supportsRange: false, size: null, acceptRanges: null };
    }
}
async function readResponseStream(response, totalHint, rangeSupported, strategy, onProgress, onChunk) {
    const total = totalHint ?? parseContentLength(response.headers.get('content-length'));
    if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = new Uint8Array(await response.arrayBuffer());
        const progress = {
            loaded: buffer.byteLength,
            total: total ?? buffer.byteLength,
            ratio: 1,
            rangeSupported,
            strategy: strategy === 'stream' ? 'basic' : strategy
        };
        await onChunk?.(buffer, progress);
        onProgress?.(progress);
        return buffer;
    }
    const reader = response.body.getReader();
    const chunks = [];
    let loaded = 0;
    while (true) {
        const { done, value } = await reader.read();
        if (done)
            break;
        if (!value || value.byteLength === 0)
            continue;
        const chunk = value instanceof Uint8Array ? value : new Uint8Array(value);
        chunks.push(chunk);
        loaded += chunk.byteLength;
        const progress = {
            loaded,
            total,
            ratio: total && total > 0 ? Math.min(1, loaded / total) : null,
            rangeSupported,
            strategy
        };
        await onChunk?.(chunk, progress);
        onProgress?.(progress);
    }
    const assembled = new Uint8Array(loaded);
    let offset = 0;
    for (const chunk of chunks) {
        assembled.set(chunk, offset);
        offset += chunk.byteLength;
    }
    emitProgress(onProgress, assembled.byteLength, total ?? assembled.byteLength, rangeSupported, strategy);
    return assembled;
}
async function fetchByRangeChunks(url, size, options, onChunk) {
    const chunkSize = Math.max(1, Math.floor(options.rangeChunkSize ?? DEFAULT_RANGE_CHUNK_SIZE));
    const assembled = new Uint8Array(size);
    let loaded = 0;
    for (let start = 0; start < size; start += chunkSize) {
        const end = Math.min(size - 1, start + chunkSize - 1);
        const response = await fetch(url, {
            method: 'GET',
            headers: mergeHeaders(options.headers, { Range: `bytes=${start}-${end}` }),
            signal: options.signal
        });
        if (response.status !== 206 && !(response.ok && start === 0 && end >= size - 1)) {
            throw new Error(`Failed to fetch subtitle range ${start}-${end}: ${response.status}`);
        }
        const buffer = new Uint8Array(await response.arrayBuffer());
        if (buffer.byteLength === 0) {
            throw new Error(`Empty subtitle range response for bytes=${start}-${end}`);
        }
        if (start + buffer.byteLength > size) {
            assembled.set(buffer.subarray(0, size - start), start);
            loaded = size;
        }
        else {
            assembled.set(buffer, start);
            loaded = start + buffer.byteLength;
        }
        const slice = assembled.subarray(start, loaded);
        const progress = {
            loaded,
            total: size,
            ratio: size > 0 ? Math.min(1, loaded / size) : null,
            rangeSupported: true,
            strategy: 'range-chunks'
        };
        await onChunk?.(slice, progress);
        options.onProgress?.(progress);
    }
    return assembled;
}
export async function fetchSubtitleAsset(url, options = {}, onChunk) {
    const preferRange = options.preferRange !== false;
    const threshold = options.rangeChunkThreshold ?? DEFAULT_RANGE_CHUNK_THRESHOLD;
    let rangeSupported = false;
    let knownSize = null;
    if (preferRange) {
        const probe = await probeRangeSupport(url, options);
        rangeSupported = probe.supportsRange;
        knownSize = probe.size;
        if (rangeSupported && knownSize != null && knownSize >= threshold) {
            const data = await fetchByRangeChunks(url, knownSize, options, onChunk);
            return { data, strategy: 'range-chunks', rangeSupported: true, total: knownSize };
        }
    }
    const response = await fetch(url, {
        method: 'GET',
        headers: mergeHeaders(options.headers),
        signal: options.signal
    });
    if (!response.ok) {
        throw new Error(`Failed to fetch subtitle: ${response.status}`);
    }
    const total = knownSize ?? parseContentLength(response.headers.get('content-length'));
    const strategy = response.body ? 'stream' : 'basic';
    const data = await readResponseStream(response, total, rangeSupported, strategy, options.onProgress, onChunk);
    return { data, strategy, rangeSupported, total: total ?? data.byteLength };
}
export async function fetchSubtitleText(url, options = {}) {
    const { data } = await fetchSubtitleAsset(url, {
        ...options,
        rangeChunkThreshold: Number.POSITIVE_INFINITY,
        preferRange: false
    });
    return new TextDecoder('utf-8').decode(data);
}
