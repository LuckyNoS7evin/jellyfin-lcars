/**
 * libbitsub - High-performance WASM renderer for graphical subtitles
 *
 * @packageDocumentation
 */
// High-level video-integrated renderers (compatible with old libpgs-js API)
export { PgsRenderer, VobSubRenderer, createAutoSubtitleRenderer } from './wrapper.js';
// Low-level parsers for programmatic use
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser, openSubtitles } from './wrapper.js';
// Utility exports
export { initWasm, isWasmInitialized, isWebGPUSupported, isWorkerAvailable, isWorkerReady, warmup, ready, detectSubtitleFormat, fetchSubtitleAsset, fetchSubtitleText, probeRangeSupport, renderFrameData, toBlob, toCanvas, toImageBitmap, createSubtitleDiagnosticError, normalizeSubtitleError, SubtitleDiagnosticError } from './wrapper.js';
// Legacy aliases
export { PGSRenderer, VobsubRenderer, UnifiedSubtitleRenderer } from './wrapper.js';
