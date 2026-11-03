/**
 * Utility functions for libbitsub.
 */
import { isWorkerAvailable } from './worker.js';
function toBinaryView(binary) {
    if (binary instanceof Uint8Array)
        return binary;
    if (binary instanceof ArrayBuffer)
        return new Uint8Array(binary);
    return null;
}
function toClampedView(pixels) {
    if (pixels.buffer instanceof ArrayBuffer) {
        if (pixels instanceof Uint8ClampedArray)
            return pixels;
        return new Uint8ClampedArray(pixels.buffer, pixels.byteOffset, pixels.byteLength);
    }
    const ownedPixels = new Uint8ClampedArray(pixels.byteLength);
    ownedPixels.set(pixels);
    return ownedPixels;
}
function looksLikePgsBinary(binary) {
    return binary.length >= 2 && binary[0] === 0x50 && binary[1] === 0x47;
}
const EBML_HEADER_ID = 0x1a45dfa3;
const EBML_DOC_TYPE_ID = 0x4282;
const EBML_SEGMENT_ID = 0x18538067;
const EBML_TRACKS_ID = 0x1654ae6b;
const EBML_TRACK_ENTRY_ID = 0xae;
const EBML_TRACK_TYPE_ID = 0x83;
const EBML_CODEC_ID = 0x86;
const MATROSKA_SUBTITLE_TRACK_TYPE = 0x11;
const MATROSKA_VOBSUB_CODEC_ID = 'S_VOBSUB';
const MAX_MKS_PROBE_BYTES = 1 << 20;
function readEbmlVint(binary, offset, keepMarker) {
    if (offset >= binary.length)
        return null;
    const firstByte = binary[offset];
    if (firstByte === 0)
        return null;
    let mask = 0x80;
    let length = 1;
    while ((firstByte & mask) === 0) {
        mask >>= 1;
        length += 1;
        if (mask === 0 || length > 8)
            return null;
    }
    if (offset + length > binary.length)
        return null;
    let isUnknownSize = !keepMarker;
    let value = keepMarker ? firstByte : firstByte & (mask - 1);
    for (let index = 1; index < length; index += 1) {
        value = value * 256 + binary[offset + index];
        if (!keepMarker && binary[offset + index] !== 0xff) {
            isUnknownSize = false;
        }
    }
    if (!keepMarker && (firstByte & (mask - 1)) !== mask - 1) {
        isUnknownSize = false;
    }
    return { value, length, isUnknownSize };
}
function readEbmlElementBounds(binary, offset, limit) {
    const id = readEbmlVint(binary, offset, true);
    if (!id)
        return null;
    const size = readEbmlVint(binary, offset + id.length, false);
    if (!size)
        return null;
    const dataStart = offset + id.length + size.length;
    if (dataStart > limit)
        return null;
    const dataEnd = size.isUnknownSize ? limit : Math.min(dataStart + size.value, limit);
    return { id: id.value, dataStart, dataEnd };
}
function readMatroskaDocType(binary, limit) {
    const header = readEbmlElementBounds(binary, 0, limit);
    if (!header || header.id !== EBML_HEADER_ID)
        return null;
    let offset = header.dataStart;
    while (offset < header.dataEnd) {
        const element = readEbmlElementBounds(binary, offset, header.dataEnd);
        if (!element)
            return null;
        if (element.id === EBML_DOC_TYPE_ID) {
            return new TextDecoder('ascii').decode(binary.subarray(element.dataStart, element.dataEnd)).toLowerCase();
        }
        offset = element.dataEnd;
    }
    return null;
}
function readAscii(binary, start, end) {
    return new TextDecoder('ascii').decode(binary.subarray(start, end));
}
function hasVobSubTrack(binary, headerEnd, limit) {
    let offset = headerEnd;
    while (offset < limit) {
        const element = readEbmlElementBounds(binary, offset, limit);
        if (!element)
            return false;
        if (element.id === EBML_SEGMENT_ID) {
            return segmentHasVobSubTrack(binary, element.dataStart, element.dataEnd);
        }
        offset = element.dataEnd;
    }
    return false;
}
function segmentHasVobSubTrack(binary, start, end) {
    let offset = start;
    while (offset < end) {
        const element = readEbmlElementBounds(binary, offset, end);
        if (!element)
            return false;
        if (element.id === EBML_TRACKS_ID) {
            return tracksContainVobSubTrack(binary, element.dataStart, element.dataEnd);
        }
        offset = element.dataEnd;
    }
    return false;
}
function tracksContainVobSubTrack(binary, start, end) {
    let offset = start;
    while (offset < end) {
        const element = readEbmlElementBounds(binary, offset, end);
        if (!element)
            return false;
        if (element.id === EBML_TRACK_ENTRY_ID && trackEntryIsVobSub(binary, element.dataStart, element.dataEnd)) {
            return true;
        }
        offset = element.dataEnd;
    }
    return false;
}
function trackEntryIsVobSub(binary, start, end) {
    let offset = start;
    let trackType = null;
    let codecId = null;
    while (offset < end) {
        const element = readEbmlElementBounds(binary, offset, end);
        if (!element)
            return false;
        if (element.id === EBML_TRACK_TYPE_ID) {
            trackType = 0;
            for (let index = element.dataStart; index < element.dataEnd; index += 1) {
                trackType = trackType * 256 + binary[index];
            }
        }
        else if (element.id === EBML_CODEC_ID) {
            codecId = readAscii(binary, element.dataStart, element.dataEnd);
        }
        offset = element.dataEnd;
    }
    return trackType === MATROSKA_SUBTITLE_TRACK_TYPE && codecId === MATROSKA_VOBSUB_CODEC_ID;
}
function looksLikeMksBinary(binary) {
    const probeLength = Math.min(binary.length, MAX_MKS_PROBE_BYTES);
    if (probeLength < 4)
        return false;
    const docType = readMatroskaDocType(binary, probeLength);
    if (docType !== 'matroska')
        return false;
    const header = readEbmlElementBounds(binary, 0, probeLength);
    if (!header || header.id !== EBML_HEADER_ID)
        return false;
    return hasVobSubTrack(binary, header.dataEnd, probeLength);
}
function looksLikeVobSubBinary(binary) {
    const limit = Math.min(binary.length - 3, 65536);
    for (let index = 0; index <= limit; index++) {
        if (binary[index] !== 0x00 || binary[index + 1] !== 0x00 || binary[index + 2] !== 0x01) {
            continue;
        }
        const streamId = binary[index + 3];
        if (streamId === 0xba || streamId === 0xbd || streamId === 0xbe) {
            return true;
        }
    }
    return false;
}
export function isMksSource(source) {
    const fileHint = [source.fileName, source.subUrl].find(Boolean)?.toLowerCase();
    if (fileHint?.endsWith('.mks'))
        return true;
    const binary = toBinaryView(source.data ?? source.subData);
    return binary ? looksLikeMksBinary(binary) : false;
}
/** Binary search for timestamp index. */
export function binarySearchTimestamp(timestamps, timeMs) {
    const len = timestamps.length;
    if (len === 0)
        return -1;
    let left = 0;
    let right = len - 1;
    let result = -1;
    while (left <= right) {
        const mid = (left + right) >>> 1;
        if (timestamps[mid] <= timeMs) {
            result = mid;
            left = mid + 1;
        }
        else {
            right = mid - 1;
        }
    }
    return result;
}
/** Convert worker frame data to SubtitleData. */
export function convertFrameData(frame) {
    const compositionData = frame.compositions.flatMap((comp) => {
        const trimmed = trimTransparentImageData(comp.rgba, comp.width, comp.height);
        if (!trimmed)
            return [];
        return {
            pixelData: trimmed.pixelData,
            x: comp.x + trimmed.offsetX,
            y: comp.y + trimmed.offsetY
        };
    });
    return { width: frame.width, height: frame.height, compositionData };
}
export function trimTransparentImageData(pixels, width, height) {
    const clampedPixels = toClampedView(pixels);
    if (width <= 0 || height <= 0 || clampedPixels.length !== width * height * 4) {
        return null;
    }
    let minX = width;
    let minY = height;
    let maxX = -1;
    let maxY = -1;
    for (let index = 3; index < clampedPixels.length; index += 4) {
        if (clampedPixels[index] === 0)
            continue;
        const pixelIndex = (index - 3) >> 2;
        const y = Math.floor(pixelIndex / width);
        const x = pixelIndex - y * width;
        if (x < minX)
            minX = x;
        if (y < minY)
            minY = y;
        if (x > maxX)
            maxX = x;
        if (y > maxY)
            maxY = y;
    }
    if (maxX < minX || maxY < minY) {
        return null;
    }
    if (minX === 0 && minY === 0 && maxX === width - 1 && maxY === height - 1) {
        const imageDataPixels = clampedPixels;
        return {
            pixelData: new ImageData(imageDataPixels, width, height),
            offsetX: 0,
            offsetY: 0
        };
    }
    const trimmedWidth = maxX - minX + 1;
    const trimmedHeight = maxY - minY + 1;
    const trimmedPixels = new Uint8ClampedArray(trimmedWidth * trimmedHeight * 4);
    for (let y = 0; y < trimmedHeight; y++) {
        const sourceStart = ((minY + y) * width + minX) * 4;
        const sourceEnd = sourceStart + trimmedWidth * 4;
        trimmedPixels.set(clampedPixels.subarray(sourceStart, sourceEnd), y * trimmedWidth * 4);
    }
    return {
        pixelData: new ImageData(trimmedPixels, trimmedWidth, trimmedHeight),
        offsetX: minX,
        offsetY: minY
    };
}
/** Calculate the bounding box for a subtitle frame. */
export function getSubtitleBounds(data) {
    if (data.compositionData.length === 0)
        return null;
    let minX = Number.POSITIVE_INFINITY;
    let minY = Number.POSITIVE_INFINITY;
    let maxX = Number.NEGATIVE_INFINITY;
    let maxY = Number.NEGATIVE_INFINITY;
    for (const comp of data.compositionData) {
        minX = Math.min(minX, comp.x);
        minY = Math.min(minY, comp.y);
        maxX = Math.max(maxX, comp.x + comp.pixelData.width);
        maxY = Math.max(maxY, comp.y + comp.pixelData.height);
    }
    if (!Number.isFinite(minX) || !Number.isFinite(minY) || !Number.isFinite(maxX) || !Number.isFinite(maxY)) {
        return null;
    }
    return {
        x: minX,
        y: minY,
        width: Math.max(0, maxX - minX),
        height: Math.max(0, maxY - minY)
    };
}
/** Store a frame in the cache and evict older entries when the limit is exceeded. */
export function setCachedFrame(state, index, frame, renderIssue = null) {
    if (state.frameCache.has(index)) {
        state.frameCache.delete(index);
    }
    if (state.renderIssues.has(index)) {
        state.renderIssues.delete(index);
    }
    state.frameCache.set(index, frame);
    state.renderIssues.set(index, renderIssue);
    while (state.frameCache.size > state.cacheLimit) {
        const oldestKey = state.frameCache.keys().next().value;
        if (oldestKey === undefined)
            break;
        state.frameCache.delete(oldestKey);
        state.renderIssues.delete(oldestKey);
    }
}
/** Update the frame cache size limit and immediately trim the cache. */
export function setCacheLimit(state, cacheLimit) {
    state.cacheLimit = Math.max(0, Math.floor(cacheLimit));
    while (state.frameCache.size > state.cacheLimit) {
        const oldestKey = state.frameCache.keys().next().value;
        if (oldestKey === undefined)
            break;
        state.frameCache.delete(oldestKey);
        state.renderIssues.delete(oldestKey);
    }
    return state.cacheLimit;
}
/** Generate a unique worker session ID. */
export function createWorkerSessionId() {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `libbitsub-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
/** Detect the subtitle format from binary content, filenames or URLs. */
export function detectSubtitleFormat(source) {
    if (source.idxContent || source.idxUrl)
        return 'vobsub';
    const fileHint = [source.fileName, source.subUrl].find(Boolean)?.toLowerCase();
    if (fileHint?.endsWith('.sub') || fileHint?.endsWith('.idx'))
        return 'vobsub';
    if (fileHint?.endsWith('.mks'))
        return 'vobsub';
    if (fileHint?.endsWith('.sup') || fileHint?.endsWith('.pgs'))
        return 'pgs';
    const binary = toBinaryView(source.data ?? source.subData);
    if (!binary)
        return null;
    if (looksLikePgsBinary(binary))
        return 'pgs';
    if (looksLikeMksBinary(binary))
        return 'vobsub';
    if (looksLikeVobSubBinary(binary))
        return 'vobsub';
    return null;
}
/** Create initial worker state. */
export function createWorkerState() {
    return {
        useWorker: isWorkerAvailable(),
        workerReady: false,
        sessionId: null,
        timestamps: new Float64Array(0),
        frameCache: new Map(),
        renderIssues: new Map(),
        pendingRenders: new Map(),
        cacheLimit: 24,
        metadata: null
    };
}
