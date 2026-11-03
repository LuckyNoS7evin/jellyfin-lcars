/**
 * WASM module management for libbitsub.
 */
let wasmModule = null;
let wasmInitPromise = null;
/**
 * Initialize the WASM module. Must be called before using any rendering functions.
 * Can be called early to pre-load the WASM module before it's needed.
 */
export async function initWasm() {
    if (wasmModule)
        return;
    if (wasmInitPromise)
        return wasmInitPromise;
    wasmInitPromise = (async () => {
        const mod = await import('../../pkg/libbitsub.js');
        await mod.default();
        wasmModule = mod;
    })();
    return wasmInitPromise;
}
/** Check if WASM is initialized. */
export function isWasmInitialized() {
    return wasmModule !== null;
}
/** Get the WASM module, throwing if not initialized. */
export function getWasm() {
    if (!wasmModule) {
        throw new Error('WASM module not initialized. Call initWasm() first.');
    }
    return wasmModule;
}
/** Get the WASM file URL (always returns absolute URL). */
export function getWasmUrl() {
    try {
        return new URL('../../pkg/libbitsub_bg.wasm', import.meta.url).href;
    }
    catch {
        if (typeof window !== 'undefined') {
            return new URL('/libbitsub/libbitsub_bg.wasm', window.location.origin).href;
        }
        return '/libbitsub/libbitsub_bg.wasm';
    }
}
/** Get the WASM glue script URL (always returns absolute URL).*/
export function getWasmGlueUrl() {
    try {
        return new URL('../../pkg/libbitsub.js', import.meta.url).href;
    }
    catch {
        if (typeof window !== 'undefined') {
            return new URL('/libbitsub/libbitsub.js', window.location.origin).href;
        }
        return '/libbitsub/libbitsub.js';
    }
}
// Pre-initialize WASM module on first import (non-blocking)
if (typeof window !== 'undefined') {
    setTimeout(() => {
        initWasm().catch((err) => console.warn('[libbitsub] WASM pre-init failed:', err));
    }, 100);
}
