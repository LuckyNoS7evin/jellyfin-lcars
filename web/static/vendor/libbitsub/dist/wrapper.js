/**
 * TypeScript wrapper for the libbitsub Rust rendering engine.
 * Provides a compatible API with the original libpgs-js implementation.
 */
export { SubtitleDiagnosticError, createSubtitleDiagnosticError, normalizeSubtitleError } from './ts/diagnostics.js';
// Re-export WASM management
export { initWasm, isWasmInitialized } from './ts/wasm.js';
export { warmup, ready, isWorkerAvailable, isWorkerReady } from './ts/worker.js';
// Re-export WebGPU utilities
export { isWebGPUSupported } from './ts/webgpu-renderer.js';
// Re-export parsers
export { PgsParser, VobSubParserLowLevel, UnifiedSubtitleParser, openSubtitles } from './ts/parsers.js';
// Re-export frame export helpers
export { renderFrameData, toBlob, toCanvas, toImageBitmap } from './ts/frame-export.js';
// Re-export renderers
export { PgsRenderer, VobSubRenderer, createAutoSubtitleRenderer } from './ts/renderers.js';
// Re-export format detection utilities
export { detectSubtitleFormat } from './ts/utils.js';
export { fetchSubtitleAsset, fetchSubtitleText, probeRangeSupport } from './ts/range-loader.js';
// =============================================================================
// Legacy Aliases (for backward compatibility)
// =============================================================================
import { PgsRenderer as _PgsRenderer, VobSubRenderer as _VobSubRenderer } from './ts/renderers.js';
import { UnifiedSubtitleParser as _UnifiedSubtitleParser } from './ts/parsers.js';
/** @deprecated Use PgsRenderer instead */
export const PGSRenderer = _PgsRenderer;
/** @deprecated Use VobSubRenderer instead */
export const VobsubRenderer = _VobSubRenderer;
/** @deprecated Use UnifiedSubtitleParser instead */
export const UnifiedSubtitleRenderer = _UnifiedSubtitleParser;
