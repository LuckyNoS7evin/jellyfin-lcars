/**
 * High-level video-integrated subtitle renderers for libbitsub.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */
import { SubtitleDiagnosticError, createSubtitleDiagnosticError, createSubtitleWarning, formatSubtitleWarningForConsole, normalizeSubtitleError, warningFromRenderIssue } from './diagnostics.js';
import { fetchSubtitleAsset, fetchSubtitleText } from './range-loader.js';
import { initWasm } from './wasm.js';
import { getOrCreateWorker, sendToWorker } from './worker.js';
import { binarySearchTimestamp, convertFrameData, createWorkerSessionId, createWorkerState, detectSubtitleFormat, getSubtitleBounds, isMksSource, setCacheLimit as applyCacheLimit, setCachedFrame } from './utils.js';
import { PgsParser, VobSubParserLowLevel } from './parsers.js';
import { WebGPURenderer, isWebGPUSupported } from './webgpu-renderer.js';
import { WebGL2Renderer, isWebGL2Supported } from './webgl2-renderer.js';
/** Default display settings */
const DEFAULT_DISPLAY_SETTINGS = {
    scale: 1.0,
    aspectMode: 'stretch',
    verticalOffset: 0,
    horizontalOffset: 0,
    horizontalAlign: 'center',
    bottomPadding: 0,
    safeArea: 0,
    opacity: 1.0
};
function createTransferableBuffer(data, preserveSource) {
    if (!preserveSource &&
        data.buffer instanceof ArrayBuffer &&
        data.byteOffset === 0 &&
        data.byteLength === data.buffer.byteLength) {
        return data.buffer;
    }
    return data.slice().buffer;
}
/**
 * Base class for video-integrated subtitle renderers.
 * Handles canvas overlay, video sync, and subtitle fetching.
 */
class BaseVideoSubtitleRenderer {
    video;
    format;
    subUrl;
    subContent;
    canvas = null;
    ctx = null;
    animationFrameId = null;
    isLoaded = false;
    lastRenderedIndex = -1;
    lastRenderedTime = -1;
    disposed = false;
    resizeObserver = null;
    tempCanvas = null;
    tempCtx = null;
    lastRenderedData = null;
    lastCueIndex = null;
    currentCueMetadata = null;
    parserMetadata = null;
    /** Display settings for subtitle rendering */
    displaySettings = { ...DEFAULT_DISPLAY_SETTINGS };
    /** Time offset in seconds added to video.currentTime for subtitle lookup */
    timeOffset = 0;
    cacheLimit = 24;
    prefetchBefore = 0;
    prefetchAfter = 0;
    streamingLoad = true;
    rangeRequests = true;
    onEvent;
    onWarning;
    currentRendererBackend = null;
    debug;
    lastRenderInfo = null;
    loadedMetadataHandler = null;
    seekedHandler = null;
    // WebGPU renderer (optional, falls back to WebGL2 then Canvas2D)
    webgpuRenderer = null;
    useWebGPU = false;
    onWebGPUFallback;
    // WebGL2 renderer (optional, falls back to Canvas2D)
    webgl2Renderer = null;
    useWebGL2 = false;
    onWebGL2Fallback;
    // Performance tracking
    perfStats = {
        framesRendered: 0,
        framesDropped: 0,
        renderTimes: [],
        lastRenderTime: 0,
        fpsTimestamps: [],
        lastFrameTime: 0
    };
    constructor(options, format) {
        this.video = options.video;
        this.format = format;
        this.subUrl = options.subUrl;
        this.subContent = options.subContent;
        this.onWebGPUFallback = options.onWebGPUFallback;
        this.onWebGL2Fallback = options.onWebGL2Fallback;
        this.onEvent = options.onEvent;
        this.onWarning = options.onWarning;
        this.debug = Boolean(options.debug);
        this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS, ...options.displaySettings };
        this.timeOffset = options.timeOffset ?? 0;
        this.cacheLimit = Math.max(0, Math.floor(options.cacheLimit ?? 24));
        this.prefetchBefore = Math.max(0, Math.floor(options.prefetchWindow?.before ?? 0));
        this.prefetchAfter = Math.max(0, Math.floor(options.prefetchWindow?.after ?? 0));
        this.streamingLoad = options.streamingLoad !== false;
        this.rangeRequests = options.rangeRequests !== false;
    }
    emitLoadProgress(format, progress, indexedCues) {
        this.emitEvent({
            type: 'load-progress',
            format,
            loadedBytes: progress.loaded,
            totalBytes: progress.total,
            ratio: progress.ratio,
            strategy: progress.strategy,
            rangeSupported: progress.rangeSupported,
            indexedCues
        });
    }
    emitIndexed(format, metadata, partial) {
        this.emitEvent({ type: 'indexed', format, metadata, partial });
    }
    memoryProgress(byteLength) {
        return {
            loaded: byteLength,
            total: byteLength,
            ratio: 1,
            rangeSupported: false,
            strategy: 'memory'
        };
    }
    /** Get current display settings */
    getDisplaySettings() {
        return { ...this.displaySettings };
    }
    /** Get cache-related diagnostics for the active renderer session. */
    getCacheStats() {
        const state = this.getWorkerRendererState();
        return {
            cacheLimit: this.cacheLimit,
            cachedFrames: state.frameCache.size,
            pendingRenders: state.pendingRenders.size,
            totalEntries: state.timestamps.length,
            usingWorker: state.useWorker && state.workerReady,
            workerReady: state.workerReady,
            sessionId: state.sessionId
        };
    }
    /** Get the most recent render attempt when debug mode is enabled. */
    getLastRenderInfo() {
        if (!this.lastRenderInfo)
            return null;
        return {
            ...this.lastRenderInfo,
            cache: { ...this.lastRenderInfo.cache },
            cue: this.lastRenderInfo.cue ? { ...this.lastRenderInfo.cue } : null
        };
    }
    /** Get parser metadata for the active subtitle track. */
    getMetadata() {
        return this.parserMetadata;
    }
    /** Get the most recently displayed cue metadata. */
    getCurrentCueMetadata() {
        return this.currentCueMetadata;
    }
    /** Get cue metadata for the specified index. */
    getCueMetadata(index) {
        return this.buildCueMetadata(index);
    }
    /** Get the configured frame-cache limit. */
    getCacheLimit() {
        return this.cacheLimit;
    }
    /** Get base stats common to all renderers */
    getBaseStats() {
        const now = performance.now();
        // Clean up old FPS timestamps (keep last second)
        this.perfStats.fpsTimestamps = this.perfStats.fpsTimestamps.filter((t) => now - t < 1000);
        const renderTimes = this.perfStats.renderTimes;
        const avgRenderTime = renderTimes.length > 0 ? renderTimes.reduce((a, b) => a + b, 0) / renderTimes.length : 0;
        const maxRenderTime = renderTimes.length > 0 ? Math.max(...renderTimes) : 0;
        const minRenderTime = renderTimes.length > 0 ? Math.min(...renderTimes) : 0;
        return {
            framesRendered: this.perfStats.framesRendered,
            framesDropped: this.perfStats.framesDropped,
            avgRenderTime: Math.round(avgRenderTime * 100) / 100,
            maxRenderTime: Math.round(maxRenderTime * 100) / 100,
            minRenderTime: Math.round(minRenderTime * 100) / 100,
            lastRenderTime: Math.round(this.perfStats.lastRenderTime * 100) / 100,
            renderFps: this.perfStats.fpsTimestamps.length,
            currentIndex: this.lastRenderedIndex
        };
    }
    /** Set display settings and force re-render */
    setDisplaySettings(settings) {
        const nextSettings = {
            ...this.displaySettings,
            ...settings
        };
        nextSettings.scale = Math.max(0.1, Math.min(3.0, nextSettings.scale));
        if (!['stretch', 'contain', 'cover'].includes(nextSettings.aspectMode)) {
            nextSettings.aspectMode = DEFAULT_DISPLAY_SETTINGS.aspectMode;
        }
        nextSettings.verticalOffset = Math.max(-50, Math.min(50, nextSettings.verticalOffset));
        nextSettings.horizontalOffset = Math.max(-50, Math.min(50, nextSettings.horizontalOffset));
        nextSettings.bottomPadding = Math.max(0, Math.min(50, nextSettings.bottomPadding));
        nextSettings.safeArea = Math.max(0, Math.min(25, nextSettings.safeArea));
        nextSettings.opacity = Math.max(0, Math.min(1, nextSettings.opacity));
        const changed = JSON.stringify(nextSettings) !== JSON.stringify(this.displaySettings);
        this.displaySettings = nextSettings;
        // Force re-render if settings changed
        if (changed) {
            this.lastRenderedIndex = -1;
            this.lastRenderedTime = -1;
        }
    }
    /** Reset display settings to defaults */
    resetDisplaySettings() {
        this.displaySettings = { ...DEFAULT_DISPLAY_SETTINGS };
        this.lastRenderedIndex = -1;
        this.lastRenderedTime = -1;
    }
    /** Start initialization. */
    startInit() {
        this.init().catch((error) => {
            this.emitEvent({
                type: 'error',
                format: this.format,
                error: normalizeSubtitleError(error, { format: this.format })
            });
        });
    }
    /** Initialize the renderer. */
    async init() {
        await initWasm();
        this.createCanvas();
        await new Promise((resolve) => setTimeout(resolve, 0));
        await this.loadSubtitles();
        this.startRenderLoop();
    }
    /** Create the canvas overlay positioned over the video. */
    createCanvas() {
        this.canvas = document.createElement('canvas');
        Object.assign(this.canvas.style, {
            position: 'absolute',
            pointerEvents: 'none',
            zIndex: '10'
        });
        const parent = this.video.parentElement;
        if (parent) {
            if (window.getComputedStyle(parent).position === 'static') {
                parent.style.position = 'relative';
            }
            parent.appendChild(this.canvas);
        }
        // Try WebGPU first, then WebGL2, then Canvas2D
        if (isWebGPUSupported()) {
            this.initWebGPU();
        }
        else if (isWebGL2Supported()) {
            this.initWebGL2();
        }
        else {
            this.initCanvas2D();
        }
        this.updateCanvasSize();
        this.resizeObserver = new ResizeObserver(() => this.updateCanvasSize());
        this.resizeObserver.observe(this.video);
        this.loadedMetadataHandler = () => this.updateCanvasSize();
        this.seekedHandler = () => {
            this.lastRenderedIndex = -1;
            this.lastRenderedTime = -1;
            this.onSeek();
        };
        this.video.addEventListener('loadedmetadata', this.loadedMetadataHandler);
        this.video.addEventListener('seeked', this.seekedHandler);
    }
    emitEvent(event) {
        this.onEvent?.(event);
    }
    emitWarning(warning) {
        this.onWarning?.(warning);
        this.emitEvent({ type: 'warning', warning });
        if (this.debug && !this.onWarning) {
            console.warn(formatSubtitleWarningForConsole(warning), warning.details ?? {});
        }
    }
    setParserMetadata(metadata) {
        this.parserMetadata = metadata;
        if (metadata) {
            this.emitEvent({ type: 'loaded', format: this.format, metadata });
        }
    }
    emitWorkerState(enabled, ready, sessionId, fallback = false) {
        this.emitEvent({ type: 'worker-state', enabled, ready, sessionId, fallback });
    }
    emitCacheChange(cachedFrames, pendingRenders) {
        this.emitEvent({ type: 'cache-change', cachedFrames, pendingRenders, cacheLimit: this.cacheLimit });
    }
    emitCueChange(cue) {
        if (this.lastCueIndex === cue?.index && cue?.index !== undefined) {
            this.currentCueMetadata = cue;
            return;
        }
        this.lastCueIndex = cue?.index ?? null;
        this.currentCueMetadata = cue;
        this.emitEvent({ type: 'cue-change', cue });
    }
    emitRendererBackend(renderer) {
        if (this.currentRendererBackend === renderer)
            return;
        this.currentRendererBackend = renderer;
        this.emitEvent({ type: 'renderer-change', renderer });
    }
    recordLastRenderInfo(info) {
        if (!this.debug)
            return;
        this.lastRenderInfo = info;
    }
    /** Initialize WebGPU renderer. */
    async initWebGPU() {
        try {
            this.webgpuRenderer = new WebGPURenderer();
            await this.webgpuRenderer.init();
            if (!this.canvas)
                return;
            const bounds = this.getVideoContentBounds();
            const width = Math.max(1, bounds.width * window.devicePixelRatio);
            const height = Math.max(1, bounds.height * window.devicePixelRatio);
            await this.webgpuRenderer.setCanvas(this.canvas, width, height);
            this.useWebGPU = true;
            this.emitRendererBackend('webgpu');
        }
        catch (error) {
            this.webgpuRenderer?.destroy();
            this.webgpuRenderer = null;
            this.useWebGPU = false;
            this.onWebGPUFallback?.();
            // Try WebGL2 before Canvas2D
            if (isWebGL2Supported()) {
                this.initWebGL2();
            }
            else {
                this.initCanvas2D();
            }
        }
    }
    /** Initialize WebGL2 renderer. */
    async initWebGL2() {
        try {
            this.webgl2Renderer = new WebGL2Renderer();
            await this.webgl2Renderer.init();
            if (!this.canvas)
                return;
            const bounds = this.getVideoContentBounds();
            const width = Math.max(1, bounds.width * window.devicePixelRatio);
            const height = Math.max(1, bounds.height * window.devicePixelRatio);
            await this.webgl2Renderer.setCanvas(this.canvas, width, height);
            this.useWebGL2 = true;
            this.emitRendererBackend('webgl2');
        }
        catch (error) {
            this.webgl2Renderer?.destroy();
            this.webgl2Renderer = null;
            this.useWebGL2 = false;
            this.onWebGL2Fallback?.();
            this.initCanvas2D();
        }
    }
    /** Initialize Canvas2D renderer. */
    initCanvas2D() {
        if (!this.canvas)
            return;
        this.ctx = this.canvas.getContext('2d');
        this.useWebGPU = false;
        this.useWebGL2 = false;
        this.emitRendererBackend('canvas2d');
    }
    /** Called when video seeks. */
    onSeek() { }
    /** Calculate the actual video content bounds, accounting for letterboxing/pillarboxing */
    getVideoContentBounds() {
        const rect = this.video.getBoundingClientRect();
        const videoWidth = this.video.videoWidth || rect.width;
        const videoHeight = this.video.videoHeight || rect.height;
        // Calculate aspect ratios
        const elementAspect = rect.width / rect.height;
        const videoAspect = videoWidth / videoHeight;
        let contentWidth;
        let contentHeight;
        let contentX;
        let contentY;
        if (Math.abs(elementAspect - videoAspect) < 0.01) {
            // Aspect ratios match - video fills the element
            contentWidth = rect.width;
            contentHeight = rect.height;
            contentX = 0;
            contentY = 0;
        }
        else if (elementAspect > videoAspect) {
            // Element is wider than video - pillarboxing (black bars on sides)
            contentHeight = rect.height;
            contentWidth = rect.height * videoAspect;
            contentX = (rect.width - contentWidth) / 2;
            contentY = 0;
        }
        else {
            // Element is taller than video - letterboxing (black bars top/bottom)
            contentWidth = rect.width;
            contentHeight = rect.width / videoAspect;
            contentX = 0;
            contentY = (rect.height - contentHeight) / 2;
        }
        return { x: contentX, y: contentY, width: contentWidth, height: contentHeight };
    }
    /** Update canvas size to match video content area. */
    updateCanvasSize() {
        if (!this.canvas)
            return;
        const bounds = this.getVideoContentBounds();
        const width = bounds.width > 0 ? bounds.width : this.video.videoWidth || 1920;
        const height = bounds.height > 0 ? bounds.height : this.video.videoHeight || 1080;
        const pixelWidth = Math.max(1, width * window.devicePixelRatio);
        const pixelHeight = Math.max(1, height * window.devicePixelRatio);
        this.canvas.width = pixelWidth;
        this.canvas.height = pixelHeight;
        // Position canvas to match video content area
        this.canvas.style.left = `${bounds.x}px`;
        this.canvas.style.top = `${bounds.y}px`;
        this.canvas.style.width = `${bounds.width}px`;
        this.canvas.style.height = `${bounds.height}px`;
        // Update GPU renderer size if active
        if (this.useWebGPU && this.webgpuRenderer) {
            this.webgpuRenderer.updateSize(pixelWidth, pixelHeight);
        }
        else if (this.useWebGL2 && this.webgl2Renderer) {
            this.webgl2Renderer.updateSize(pixelWidth, pixelHeight);
        }
        this.lastRenderedIndex = -1;
        this.lastRenderedTime = -1;
    }
    /** Start the render loop. */
    startRenderLoop() {
        // Create reusable temp canvas for rendering
        this.tempCanvas = document.createElement('canvas');
        this.tempCtx = this.tempCanvas.getContext('2d');
        const render = () => {
            if (this.disposed)
                return;
            if (this.isLoaded) {
                const currentTime = this.video.currentTime + this.timeOffset;
                const currentIndex = this.findCurrentIndex(currentTime);
                // Only re-render if index changed
                if (currentIndex !== this.lastRenderedIndex) {
                    const cacheHit = currentIndex >= 0 && this.getWorkerRendererState().frameCache.has(currentIndex);
                    const startTime = performance.now();
                    const outcome = this.renderFrame(currentTime, currentIndex);
                    const endTime = performance.now();
                    // Track performance
                    const renderTime = endTime - startTime;
                    this.perfStats.lastRenderTime = renderTime;
                    this.perfStats.renderTimes.push(renderTime);
                    // Keep only last 60 samples for rolling average
                    if (this.perfStats.renderTimes.length > 60) {
                        this.perfStats.renderTimes.shift();
                    }
                    this.perfStats.framesRendered++;
                    this.perfStats.fpsTimestamps.push(endTime);
                    // Check for frame drop (if render took longer than frame budget ~16.67ms for 60fps)
                    const frameBudget = 16.67;
                    if (renderTime > frameBudget) {
                        this.perfStats.framesDropped++;
                    }
                    if (outcome.warning) {
                        this.emitWarning(outcome.warning);
                    }
                    this.lastRenderedIndex = currentIndex;
                    this.lastRenderedTime = currentTime;
                    const cue = currentIndex >= 0 ? this.buildCueMetadata(currentIndex) : null;
                    this.emitCueChange(cue);
                    this.recordLastRenderInfo({
                        time: currentTime,
                        index: currentIndex,
                        status: outcome.status,
                        backend: this.currentRendererBackend,
                        usingWorker: this.getCacheStats().usingWorker,
                        cacheHit,
                        renderDuration: Math.round(renderTime * 100) / 100,
                        frameWidth: outcome.data?.width ?? null,
                        frameHeight: outcome.data?.height ?? null,
                        compositionCount: outcome.data?.compositionData.length ?? 0,
                        cue,
                        cache: this.getCacheStats(),
                        capturedAt: endTime
                    });
                    this.emitEvent({ type: 'stats', stats: this.getStats() });
                    if (currentIndex >= 0 && (this.prefetchBefore > 0 || this.prefetchAfter > 0)) {
                        const prefetch = this
                            .prefetchAroundTime;
                        prefetch?.call(this, currentTime).catch(() => { });
                    }
                }
            }
            this.animationFrameId = requestAnimationFrame(render);
        };
        this.animationFrameId = requestAnimationFrame(render);
    }
    /** Render a subtitle frame to the canvas. */
    renderFrame(time, index) {
        if (!this.canvas) {
            return { status: 'failed', data: null, warning: null };
        }
        // Get the data for this index
        const data = index >= 0 ? this.renderAtIndex(index) : undefined;
        // If data is undefined, it means async loading is in progress
        // Keep showing the last frame only while waiting for async data
        // Note: null means "loaded but empty" (clear screen), undefined means "still loading"
        if (data === undefined && this.lastRenderedData !== null && index >= 0) {
            // Check if this index has a pending render (truly async loading)
            // If not pending, it means the render returned no data immediately
            if (this.isPendingRender(index)) {
                // Don't clear - keep showing the last frame while loading
                return { status: 'pending', data: null, warning: null };
            }
        }
        const renderIssue = index >= 0 ? (this.getWorkerRendererState().renderIssues.get(index) ?? null) : null;
        const warning = warningFromRenderIssue(renderIssue, { format: this.format, cueIndex: index });
        // Use best available renderer
        if (this.useWebGPU && this.webgpuRenderer) {
            this.renderFrameWebGPU(data, index);
        }
        else if (this.useWebGL2 && this.webgl2Renderer) {
            this.renderFrameWebGL2(data, index);
        }
        else {
            this.renderFrameCanvas2D(data, index);
        }
        if (index < 0) {
            return { status: 'cleared', data: null, warning: null };
        }
        if (warning) {
            return { status: 'failed', data: data ?? null, warning };
        }
        if (!data || data.compositionData.length === 0) {
            return { status: 'empty', data: data ?? null, warning: null };
        }
        return { status: 'rendered', data, warning: null };
    }
    computeLayout(data) {
        if (!this.canvas) {
            return { scaleX: 1, scaleY: 1, shiftX: 0, shiftY: 0, opacity: this.displaySettings.opacity };
        }
        const safeDataWidth = data.width > 0 ? data.width : this.canvas.width;
        const safeDataHeight = data.height > 0 ? data.height : this.canvas.height;
        const stretchScaleX = this.canvas.width / safeDataWidth;
        const stretchScaleY = this.canvas.height / safeDataHeight;
        const bounds = getSubtitleBounds(data) ??
            {
                x: 0,
                y: 0,
                width: safeDataWidth,
                height: safeDataHeight
            };
        const { scale, aspectMode, verticalOffset, horizontalOffset, horizontalAlign, bottomPadding, safeArea, opacity } = this.displaySettings;
        let baseScaleX = stretchScaleX;
        let baseScaleY = stretchScaleY;
        let frameShiftX = 0;
        let frameShiftY = 0;
        if (aspectMode !== 'stretch') {
            const uniformScale = aspectMode === 'cover' ? Math.max(stretchScaleX, stretchScaleY) : Math.min(stretchScaleX, stretchScaleY);
            baseScaleX = uniformScale;
            baseScaleY = uniformScale;
            frameShiftX = (this.canvas.width - safeDataWidth * uniformScale) / 2;
            frameShiftY = (this.canvas.height - safeDataHeight * uniformScale) / 2;
        }
        const anchorX = horizontalAlign === 'left'
            ? bounds.x
            : horizontalAlign === 'right'
                ? bounds.x + bounds.width
                : bounds.x + bounds.width / 2;
        const anchorY = bounds.y + bounds.height;
        const scaleX = baseScaleX * scale;
        const scaleY = baseScaleY * scale;
        const anchorShiftX = frameShiftX + anchorX * baseScaleX * (1 - scale);
        const anchorShiftY = frameShiftY + anchorY * baseScaleY * (1 - scale);
        let shiftX = anchorShiftX + (horizontalOffset / 100) * this.canvas.width;
        let shiftY = anchorShiftY + (verticalOffset / 100) * this.canvas.height;
        shiftY -= (bottomPadding / 100) * this.canvas.height;
        const safeX = (safeArea / 100) * this.canvas.width;
        const safeY = (safeArea / 100) * this.canvas.height;
        const finalMinX = bounds.x * scaleX + shiftX;
        const finalMinY = bounds.y * scaleY + shiftY;
        const finalMaxX = (bounds.x + bounds.width) * scaleX + shiftX;
        const finalMaxY = (bounds.y + bounds.height) * scaleY + shiftY;
        if (finalMinX < safeX)
            shiftX += safeX - finalMinX;
        if (finalMaxX > this.canvas.width - safeX)
            shiftX -= finalMaxX - (this.canvas.width - safeX);
        if (finalMinY < safeY)
            shiftY += safeY - finalMinY;
        if (finalMaxY > this.canvas.height - safeY)
            shiftY -= finalMaxY - (this.canvas.height - safeY);
        return {
            scaleX,
            scaleY,
            shiftX,
            shiftY,
            opacity
        };
    }
    /** Render using WebGPU. */
    renderFrameWebGPU(data, index) {
        if (!this.webgpuRenderer || !this.canvas)
            return;
        // If no subtitle at this index, clear
        if (index < 0 || !data || data.compositionData.length === 0) {
            this.webgpuRenderer.clear();
            this.lastRenderedData = null;
            return;
        }
        // Store for potential reuse
        this.lastRenderedData = data;
        // Calculate base scale factors
        const layout = this.computeLayout(data);
        this.webgpuRenderer.render(data.compositionData, data.width, data.height, layout.scaleX, layout.scaleY, layout.shiftX, layout.shiftY, layout.opacity);
    }
    /** Render using WebGL2. */
    renderFrameWebGL2(data, index) {
        if (!this.webgl2Renderer || !this.canvas)
            return;
        if (index < 0 || !data || data.compositionData.length === 0) {
            this.webgl2Renderer.clear();
            this.lastRenderedData = null;
            return;
        }
        this.lastRenderedData = data;
        const layout = this.computeLayout(data);
        this.webgl2Renderer.render(data.compositionData, data.width, data.height, layout.scaleX, layout.scaleY, layout.shiftX, layout.shiftY, layout.opacity);
    }
    /** Render using Canvas2D. */
    renderFrameCanvas2D(data, index) {
        if (!this.ctx || !this.canvas)
            return;
        // Clear canvas
        this.ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        // If no subtitle at this index, we're done
        if (index < 0 || !data || data.compositionData.length === 0) {
            this.lastRenderedData = null;
            return;
        }
        // Store for potential reuse
        this.lastRenderedData = data;
        const layout = this.computeLayout(data);
        this.ctx.save();
        this.ctx.globalAlpha = layout.opacity;
        for (const comp of data.compositionData) {
            if (!this.tempCanvas || !this.tempCtx)
                continue;
            // Resize temp canvas if needed
            if (this.tempCanvas.width !== comp.pixelData.width || this.tempCanvas.height !== comp.pixelData.height) {
                this.tempCanvas.width = comp.pixelData.width;
                this.tempCanvas.height = comp.pixelData.height;
            }
            this.tempCtx.putImageData(comp.pixelData, 0, 0);
            // Calculate position with scale and offset applied
            // Center the scaled content horizontally
            const scaledWidth = comp.pixelData.width * layout.scaleX;
            const scaledHeight = comp.pixelData.height * layout.scaleY;
            const adjustedX = comp.x * layout.scaleX + layout.shiftX;
            const adjustedY = comp.y * layout.scaleY + layout.shiftY;
            this.ctx.drawImage(this.tempCanvas, adjustedX, adjustedY, scaledWidth, scaledHeight);
        }
        this.ctx.restore();
    }
    /** Dispose of all resources. */
    dispose() {
        this.disposed = true;
        if (this.animationFrameId !== null) {
            cancelAnimationFrame(this.animationFrameId);
            this.animationFrameId = null;
        }
        this.resizeObserver?.disconnect();
        this.resizeObserver = null;
        if (this.loadedMetadataHandler) {
            this.video.removeEventListener('loadedmetadata', this.loadedMetadataHandler);
            this.loadedMetadataHandler = null;
        }
        if (this.seekedHandler) {
            this.video.removeEventListener('seeked', this.seekedHandler);
            this.seekedHandler = null;
        }
        // Clean up GPU renderers
        if (this.webgpuRenderer) {
            this.webgpuRenderer.destroy();
            this.webgpuRenderer = null;
        }
        if (this.webgl2Renderer) {
            this.webgl2Renderer.destroy();
            this.webgl2Renderer = null;
        }
        this.canvas?.parentElement?.removeChild(this.canvas);
        this.canvas = null;
        this.ctx = null;
        this.tempCanvas = null;
        this.tempCtx = null;
        this.lastRenderedData = null;
        this.currentCueMetadata = null;
        this.parserMetadata = null;
        this.lastRenderInfo = null;
        this.useWebGPU = false;
        this.useWebGL2 = false;
    }
}
/**
 * High-level PGS subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class PgsRenderer extends BaseVideoSubtitleRenderer {
    pgsParser = null;
    state = createWorkerState();
    onLoading;
    onLoaded;
    onError;
    constructor(options) {
        super(options, 'pgs');
        this.onLoading = options.onLoading;
        this.onLoaded = options.onLoaded;
        this.onError = options.onError;
        applyCacheLimit(this.state, this.cacheLimit);
        this.startInit();
    }
    async loadSubtitles() {
        try {
            this.emitEvent({ type: 'loading', format: 'pgs' });
            this.onLoading?.();
            if (this.subContent) {
                const data = new Uint8Array(this.subContent);
                this.emitLoadProgress('pgs', this.memoryProgress(data.byteLength), 0);
                await this.loadPgsBuffer(data, true);
                this.onLoaded?.();
                return;
            }
            if (!this.subUrl) {
                throw new Error('No subtitle content or URL provided');
            }
            if (!this.streamingLoad) {
                const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(this.subUrl, {
                    preferRange: this.rangeRequests,
                    onProgress: (progress) => this.emitLoadProgress('pgs', progress, this.state.timestamps.length)
                });
                this.emitLoadProgress('pgs', { loaded: data.byteLength, total: total ?? data.byteLength, ratio: 1, rangeSupported, strategy }, 0);
                await this.loadPgsBuffer(data, false);
                this.onLoaded?.();
                return;
            }
            await this.loadPgsStreaming(this.subUrl);
            this.onLoaded?.();
        }
        catch (error) {
            const resolvedError = normalizeSubtitleError(error, { format: 'pgs' });
            this.emitEvent({ type: 'error', format: 'pgs', error: resolvedError });
            this.onError?.(resolvedError);
        }
    }
    applyPgsIndexState(metadata, timestamps, partial, usingWorker) {
        this.state.metadata = metadata;
        this.state.timestamps = timestamps;
        this.setParserMetadata(metadata);
        this.emitIndexed('pgs', metadata, partial);
        if (!this.isLoaded && timestamps.length > 0) {
            this.isLoaded = true;
            if (usingWorker) {
                this.state.workerReady = true;
                this.emitWorkerState(true, true, this.state.sessionId);
            }
        }
    }
    async loadPgsBuffer(data, preserveSource) {
        if (this.state.useWorker) {
            try {
                this.state.sessionId = createWorkerSessionId();
                await getOrCreateWorker();
                this.emitWorkerState(true, false, this.state.sessionId);
                const transferableData = createTransferableBuffer(data, preserveSource);
                const loadResponse = await sendToWorker({
                    type: 'loadPgs',
                    sessionId: this.state.sessionId,
                    data: transferableData
                });
                if (loadResponse.type === 'pgsLoaded') {
                    this.state.workerReady = true;
                    this.state.metadata = loadResponse.metadata;
                    this.state.timestamps = loadResponse.timestamps;
                    this.isLoaded = true;
                    this.setParserMetadata(loadResponse.metadata);
                    this.emitIndexed('pgs', loadResponse.metadata, false);
                    this.emitWorkerState(true, true, this.state.sessionId);
                    return;
                }
                else if (loadResponse.type === 'error') {
                    throw new Error(loadResponse.message);
                }
            }
            catch (workerError) {
                this.state.useWorker = false;
                this.emitWorkerState(false, false, this.state.sessionId, true);
                this.emitWarning(createSubtitleWarning('WORKER_FALLBACK', 'PGS worker initialization failed, falling back to main-thread rendering.', {
                    format: 'pgs',
                    details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
                }));
            }
        }
        await this.loadOnMainThread(data);
    }
    async loadPgsStreaming(url) {
        let usedWorker = false;
        let indexedOnce = false;
        if (this.state.useWorker) {
            try {
                this.state.sessionId = createWorkerSessionId();
                await getOrCreateWorker();
                this.emitWorkerState(true, false, this.state.sessionId);
                const begin = await sendToWorker({ type: 'beginPgs', sessionId: this.state.sessionId });
                if (begin.type === 'error')
                    throw new Error(begin.message);
                usedWorker = true;
            }
            catch (workerError) {
                this.state.useWorker = false;
                usedWorker = false;
                this.emitWorkerState(false, false, this.state.sessionId, true);
                this.emitWarning(createSubtitleWarning('WORKER_FALLBACK', 'PGS worker initialization failed, falling back to main-thread rendering.', {
                    format: 'pgs',
                    details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
                }));
            }
        }
        if (!usedWorker) {
            await this.yieldToMain();
            this.pgsParser = new PgsParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) });
            this.pgsParser.reset();
        }
        try {
            const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(url, {
                preferRange: this.rangeRequests,
                onProgress: (progress) => this.emitLoadProgress('pgs', progress, this.state.timestamps.length)
            }, async (chunk, progress) => {
                if (chunk.byteLength === 0)
                    return;
                if (usedWorker && this.state.sessionId) {
                    const transferable = createTransferableBuffer(chunk, true);
                    const response = await sendToWorker({
                        type: 'appendPgs',
                        sessionId: this.state.sessionId,
                        data: transferable
                    });
                    if (response.type === 'pgsProgress') {
                        if (response.added > 0 || !indexedOnce) {
                            this.applyPgsIndexState(response.metadata, response.timestamps, true, true);
                            indexedOnce = true;
                        }
                        else {
                            this.state.timestamps = response.timestamps;
                            this.state.metadata = response.metadata;
                        }
                    }
                    else if (response.type === 'error') {
                        throw new Error(response.message);
                    }
                }
                else if (this.pgsParser) {
                    const added = this.pgsParser.feed(chunk);
                    if (added > 0 || !indexedOnce) {
                        const metadata = this.pgsParser.getMetadata();
                        this.applyPgsIndexState(metadata, this.pgsParser.getTimestamps(), true, false);
                        indexedOnce = true;
                    }
                }
                this.emitLoadProgress('pgs', progress, this.state.timestamps.length);
            });
            if (usedWorker && this.state.sessionId) {
                const finish = await sendToWorker({ type: 'finishPgs', sessionId: this.state.sessionId });
                if (finish.type === 'pgsProgress') {
                    this.applyPgsIndexState(finish.metadata, finish.timestamps, false, true);
                    this.state.workerReady = true;
                    this.isLoaded = true;
                    this.emitWorkerState(true, true, this.state.sessionId);
                }
                else if (finish.type === 'error') {
                    throw new Error(finish.message);
                }
            }
            else if (this.pgsParser) {
                this.pgsParser.finishFeed();
                const metadata = this.pgsParser.getMetadata();
                this.state.timestamps = this.pgsParser.getTimestamps();
                this.state.metadata = metadata;
                this.isLoaded = true;
                this.setParserMetadata(metadata);
                this.emitIndexed('pgs', metadata, false);
                if (metadata.cueCount === 0) {
                    this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA');
                }
            }
            this.emitLoadProgress('pgs', {
                loaded: data.byteLength,
                total: total ?? data.byteLength,
                ratio: 1,
                rangeSupported,
                strategy: strategy
            }, this.state.timestamps.length);
        }
        catch (error) {
            if (usedWorker) {
                this.state.useWorker = false;
                this.emitWorkerState(false, false, this.state.sessionId, true);
            }
            this.emitWarning(createSubtitleWarning('RANGE_FALLBACK', 'Progressive PGS load failed; retrying with a full buffer fetch.', {
                format: 'pgs',
                details: { reason: error instanceof Error ? error.message : String(error) }
            }));
            const { data } = await fetchSubtitleAsset(url, { preferRange: this.rangeRequests });
            await this.loadPgsBuffer(data, false);
        }
    }
    async loadOnMainThread(data) {
        await this.yieldToMain();
        this.pgsParser = new PgsParser({ debug: this.debug, onWarning: (warning) => this.emitWarning(warning) });
        await new Promise((resolve) => {
            const scheduleTask = typeof requestIdleCallback !== 'undefined'
                ? (cb) => requestIdleCallback(() => cb(), { timeout: 1000 })
                : (cb) => setTimeout(cb, 0);
            scheduleTask(() => {
                const count = this.pgsParser.load(data);
                this.state.timestamps = this.pgsParser.getTimestamps();
                this.state.metadata = this.pgsParser.getMetadata();
                this.isLoaded = true;
                this.setParserMetadata(this.state.metadata);
                this.emitIndexed('pgs', this.state.metadata, false);
                if (count === 0) {
                    this.state.renderIssues.set(-1, 'INVALID_SUBTITLE_DATA');
                }
                resolve();
            });
        });
    }
    getWorkerRendererState() {
        return this.state;
    }
    /** Yield to main thread to prevent UI blocking */
    yieldToMain() {
        // Use scheduler.yield if available (Chrome 115+)
        const globalScheduler = globalThis.scheduler;
        if (globalScheduler && typeof globalScheduler.yield === 'function') {
            return globalScheduler.yield();
        }
        // Fallback to setTimeout
        return new Promise((resolve) => setTimeout(resolve, 0));
    }
    renderAtTime(time) {
        const index = this.findCurrentIndex(time);
        return index < 0 ? undefined : this.renderAtIndex(index);
    }
    findCurrentIndex(time) {
        if (this.state.useWorker && this.state.workerReady) {
            return binarySearchTimestamp(this.state.timestamps, time * 1000);
        }
        return this.pgsParser?.findIndexAtTimestamp(time) ?? -1;
    }
    renderAtIndex(index) {
        if (this.state.frameCache.has(index)) {
            return this.state.frameCache.get(index) ?? undefined;
        }
        if (this.state.useWorker && this.state.workerReady) {
            if (!this.state.pendingRenders.has(index)) {
                const renderTask = sendToWorker({
                    type: 'renderPgsAtIndex',
                    sessionId: this.state.sessionId,
                    index
                }).then((response) => {
                    if (response.type === 'pgsFrame') {
                        return {
                            frame: response.frame ? convertFrameData(response.frame) : null,
                            renderIssue: response.renderIssue?.trim() || null
                        };
                    }
                    return { frame: null, renderIssue: null };
                });
                const renderPromise = renderTask.then(({ frame }) => frame);
                this.state.pendingRenders.set(index, renderPromise);
                this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
                renderTask.then(({ frame, renderIssue }) => {
                    setCachedFrame(this.state, index, frame, renderIssue);
                    this.state.pendingRenders.delete(index);
                    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
                    // Force re-render on next frame by resetting lastRenderedIndex
                    if (this.findCurrentIndex(this.video.currentTime + this.timeOffset) === index) {
                        this.lastRenderedIndex = -1;
                    }
                });
            }
            // Return undefined to indicate async loading in progress
            return undefined;
        }
        const rendered = this.pgsParser?.renderAtIndex(index) ?? null;
        setCachedFrame(this.state, index, rendered, this.pgsParser?.getLastRenderIssue() ?? null);
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
        return rendered ?? undefined;
    }
    buildCueMetadata(index) {
        if (this.pgsParser) {
            return this.pgsParser.getCueMetadata(index);
        }
        const metadata = this.state.metadata;
        if (!metadata || index < 0 || index >= this.state.timestamps.length)
            return null;
        const startTime = this.state.timestamps[index];
        const endTime = this.state.timestamps[index + 1] ?? startTime + 5000;
        const frame = this.state.frameCache.get(index) ?? null;
        return {
            index,
            format: 'pgs',
            startTime,
            endTime,
            duration: Math.max(0, endTime - startTime),
            screenWidth: metadata.screenWidth,
            screenHeight: metadata.screenHeight,
            bounds: frame ? getSubtitleBounds(frame) : null,
            compositionCount: frame?.compositionData.length ?? 0
        };
    }
    isPendingRender(index) {
        return this.state.pendingRenders.has(index);
    }
    onSeek() {
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearPgsCache', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.pgsParser?.clearCache();
    }
    setCacheLimit(limit) {
        this.cacheLimit = applyCacheLimit(this.state, limit);
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    clearFrameCache() {
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        this.lastRenderedIndex = -1;
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearPgsCache', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.pgsParser?.clearCache();
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    async prefetchRange(startIndex, endIndex) {
        const safeStart = Math.max(0, Math.min(startIndex, endIndex));
        const safeEnd = Math.min(Math.max(startIndex, endIndex), this.state.timestamps.length - 1);
        for (let index = safeStart; index <= safeEnd; index++) {
            if (this.state.frameCache.has(index))
                continue;
            const result = this.renderAtIndex(index);
            if (result === undefined && this.state.pendingRenders.has(index)) {
                await this.state.pendingRenders.get(index);
            }
        }
    }
    async prefetchAroundTime(time, before = this.prefetchBefore, after = this.prefetchAfter) {
        const currentIndex = this.findCurrentIndex(time);
        if (currentIndex < 0)
            return;
        await this.prefetchRange(currentIndex - before, currentIndex + after);
    }
    /** Get performance statistics for PGS renderer */
    getStats() {
        const baseStats = this.getBaseStats();
        return {
            ...baseStats,
            usingWorker: this.state.useWorker && this.state.workerReady,
            cachedFrames: this.state.frameCache.size,
            pendingRenders: this.state.pendingRenders.size,
            totalEntries: this.state.timestamps.length || (this.pgsParser?.getTimestamps().length ?? 0)
        };
    }
    dispose() {
        super.dispose();
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'disposePgs', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.pgsParser?.dispose();
        this.pgsParser = null;
        this.state.sessionId = null;
    }
}
/**
 * High-level VobSub subtitle renderer with Web Worker support.
 * Compatible with the old libpgs-js API.
 */
export class VobSubRenderer extends BaseVideoSubtitleRenderer {
    vobsubParser = null;
    idxUrl;
    idxContent;
    fileName;
    state = createWorkerState();
    onLoading;
    onLoaded;
    onError;
    // Async index lookup state
    cachedIndex = -1;
    cachedIndexTime = -1;
    pendingIndexLookup = null;
    constructor(options) {
        super(options, 'vobsub');
        this.idxUrl =
            options.idxUrl ||
                (options.subUrl && /\.sub$/i.test(options.subUrl) ? options.subUrl.replace(/\.sub$/i, '.idx') : undefined);
        this.idxContent = options.idxContent;
        this.fileName = options.fileName;
        this.onLoading = options.onLoading;
        this.onLoaded = options.onLoaded;
        this.onError = options.onError;
        applyCacheLimit(this.state, this.cacheLimit);
        this.startInit();
    }
    async loadSubtitles() {
        try {
            this.emitEvent({ type: 'loading', format: 'vobsub' });
            this.onLoading?.();
            const useMksSource = !this.idxContent &&
                !this.idxUrl &&
                isMksSource({
                    subData: this.subContent,
                    fileName: this.fileName,
                    subUrl: this.subUrl
                });
            if (this.subContent && (useMksSource || this.idxContent)) {
                const subData = new Uint8Array(this.subContent);
                this.emitLoadProgress('vobsub', this.memoryProgress(subData.byteLength), 0);
                await this.loadVobSubBuffer(subData, this.idxContent, useMksSource, true);
                this.onLoaded?.();
                return;
            }
            if (useMksSource) {
                await this.loadVobSubMksStreaming();
                this.onLoaded?.();
                return;
            }
            await this.loadVobSubIdxSubStreaming();
            this.onLoaded?.();
        }
        catch (error) {
            const resolvedError = normalizeSubtitleError(error, { format: 'vobsub' });
            this.emitEvent({ type: 'error', format: 'vobsub', error: resolvedError });
            this.onError?.(resolvedError);
        }
    }
    applyVobSubIndexState(metadata, timestamps, partial, renderable, usingWorker) {
        this.state.metadata = metadata;
        this.state.timestamps = timestamps;
        this.setParserMetadata(metadata);
        this.emitIndexed('vobsub', metadata, partial);
        if (renderable && !this.isLoaded && timestamps.length > 0) {
            this.isLoaded = true;
            if (usingWorker) {
                this.state.workerReady = true;
                this.emitWorkerState(true, true, this.state.sessionId);
            }
        }
    }
    async ensureVobSubWorkerSession() {
        if (!this.state.useWorker)
            return false;
        try {
            this.state.sessionId = createWorkerSessionId();
            await getOrCreateWorker();
            this.emitWorkerState(true, false, this.state.sessionId);
            return true;
        }
        catch (workerError) {
            this.state.useWorker = false;
            this.emitWorkerState(false, false, this.state.sessionId, true);
            this.emitWarning(createSubtitleWarning('WORKER_FALLBACK', 'VobSub worker initialization failed, falling back to main-thread rendering.', {
                format: 'vobsub',
                details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
            }));
            return false;
        }
    }
    async loadVobSubBuffer(subData, idxData, useMksSource, preserveSource) {
        if (await this.ensureVobSubWorkerSession()) {
            try {
                const transferableSubData = createTransferableBuffer(subData, preserveSource);
                const loadResponse = await sendToWorker(useMksSource
                    ? {
                        type: 'loadVobSubMks',
                        sessionId: this.state.sessionId,
                        subData: transferableSubData
                    }
                    : {
                        type: 'loadVobSub',
                        sessionId: this.state.sessionId,
                        idxContent: idxData,
                        subData: transferableSubData
                    });
                if (loadResponse.type === 'vobSubLoaded') {
                    if (!useMksSource && idxData && loadResponse.count === 0) {
                        throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
                            format: 'vobsub'
                        });
                    }
                    this.state.workerReady = true;
                    this.state.metadata = loadResponse.metadata;
                    this.state.timestamps = loadResponse.timestamps;
                    this.isLoaded = true;
                    this.setParserMetadata(loadResponse.metadata);
                    this.emitIndexed('vobsub', loadResponse.metadata, false);
                    this.emitWorkerState(true, true, this.state.sessionId);
                    return;
                }
                else if (loadResponse.type === 'error') {
                    throw new Error(loadResponse.message);
                }
            }
            catch (workerError) {
                if (workerError instanceof SubtitleDiagnosticError && workerError.code === 'BAD_IDX') {
                    throw workerError;
                }
                this.state.useWorker = false;
                this.emitWorkerState(false, false, this.state.sessionId, true);
                this.emitWarning(createSubtitleWarning('WORKER_FALLBACK', 'VobSub worker load failed, falling back to main-thread rendering.', {
                    format: 'vobsub',
                    details: { reason: workerError instanceof Error ? workerError.message : String(workerError) }
                }));
            }
        }
        await this.loadOnMainThread(subData, idxData, useMksSource);
    }
    async loadVobSubMksStreaming() {
        if (this.subContent) {
            await this.loadVobSubBuffer(new Uint8Array(this.subContent), undefined, true, true);
            return;
        }
        if (!this.subUrl) {
            throw createSubtitleDiagnosticError('MISSING_INPUT', 'No SUB content or URL provided.', { format: 'vobsub' });
        }
        const { data, strategy, rangeSupported, total } = await fetchSubtitleAsset(this.subUrl, {
            preferRange: this.rangeRequests && this.streamingLoad,
            onProgress: (progress) => this.emitLoadProgress('vobsub', progress, this.state.timestamps.length)
        });
        this.emitLoadProgress('vobsub', {
            loaded: data.byteLength,
            total: total ?? data.byteLength,
            ratio: 1,
            rangeSupported,
            strategy
        }, 0);
        await this.loadVobSubBuffer(data, undefined, true, false);
    }
    async loadVobSubIdxSubStreaming() {
        let idxData = this.idxContent;
        if (!idxData) {
            if (!this.idxUrl) {
                throw createSubtitleDiagnosticError('MISSING_INPUT', 'No IDX content or URL provided.', { format: 'vobsub' });
            }
            idxData = await fetchSubtitleText(this.idxUrl, {
                onProgress: (progress) => this.emitLoadProgress('vobsub', progress, 0)
            });
        }
        let usedWorker = await this.ensureVobSubWorkerSession();
        if (usedWorker && this.state.sessionId) {
            try {
                const idxResponse = await sendToWorker({
                    type: 'loadVobSubIdx',
                    sessionId: this.state.sessionId,
                    idxContent: idxData
                });
                if (idxResponse.type === 'vobSubProgress') {
                    if (idxResponse.count === 0) {
                        throw createSubtitleDiagnosticError('BAD_IDX', 'IDX metadata did not yield any subtitle timestamps.', {
                            format: 'vobsub'
                        });
                    }
                    this.applyVobSubIndexState(idxResponse.metadata, idxResponse.timestamps, true, false, true);
                    this.state.workerReady = true;
                    this.emitWorkerState(true, true, this.state.sessionId);
                }
                else if (idxResponse.type === 'error') {
                    throw new Error(idxResponse.message);
                }
            }
            catch (error) {
                if (error instanceof SubtitleDiagnosticError && error.code === 'BAD_IDX') {
                    throw error;
                }
                usedWorker = false;
                this.state.useWorker = false;
                this.emitWorkerState(false, false, this.state.sessionId, true);
                this.emitWarning(createSubtitleWarning('WORKER_FALLBACK', 'VobSub worker IDX load failed, falling back to main-thread rendering.', {
                    format: 'vobsub',
                    details: { reason: error instanceof Error ? error.message : String(error) }
                }));
            }
        }
        if (!usedWorker) {
            await this.yieldToMain();
            this.vobsubParser = new VobSubParserLowLevel({
                debug: this.debug,
                onWarning: (warning) => this.emitWarning(warning)
            });
            this.vobsubParser.loadFromIdx(idxData);
            this.applyVobSubIndexState(this.vobsubParser.getMetadata(), this.vobsubParser.getTimestamps(), true, false, false);
        }
        let subData;
        if (this.subContent) {
            subData = new Uint8Array(this.subContent);
            this.emitLoadProgress('vobsub', this.memoryProgress(subData.byteLength), this.state.timestamps.length);
        }
        else {
            if (!this.subUrl) {
                throw createSubtitleDiagnosticError('MISSING_INPUT', 'No SUB content or URL provided.', { format: 'vobsub' });
            }
            const fetched = await fetchSubtitleAsset(this.subUrl, {
                preferRange: this.rangeRequests && this.streamingLoad,
                onProgress: (progress) => this.emitLoadProgress('vobsub', progress, this.state.timestamps.length)
            });
            subData = fetched.data;
            this.emitLoadProgress('vobsub', {
                loaded: subData.byteLength,
                total: fetched.total ?? subData.byteLength,
                ratio: 1,
                rangeSupported: fetched.rangeSupported,
                strategy: fetched.strategy
            }, this.state.timestamps.length);
        }
        if (usedWorker && this.state.sessionId) {
            const transferable = createTransferableBuffer(subData, Boolean(this.subContent));
            const attachResponse = await sendToWorker({
                type: 'attachVobSubData',
                sessionId: this.state.sessionId,
                subData: transferable
            });
            if (attachResponse.type === 'vobSubProgress') {
                this.applyVobSubIndexState(attachResponse.metadata, attachResponse.timestamps, false, true, true);
                this.state.workerReady = true;
                this.isLoaded = true;
                this.emitWorkerState(true, true, this.state.sessionId);
                return;
            }
            else if (attachResponse.type === 'error') {
                throw new Error(attachResponse.message);
            }
        }
        if (!this.vobsubParser) {
            this.vobsubParser = new VobSubParserLowLevel({
                debug: this.debug,
                onWarning: (warning) => this.emitWarning(warning)
            });
            this.vobsubParser.loadFromIdx(idxData);
        }
        this.vobsubParser.attachSubData(subData);
        const metadata = this.vobsubParser.getMetadata();
        this.state.timestamps = this.vobsubParser.getTimestamps();
        this.state.metadata = metadata;
        this.isLoaded = true;
        this.setParserMetadata(metadata);
        this.emitIndexed('vobsub', metadata, false);
    }
    async loadOnMainThread(subData, idxData, useMksSource = false) {
        await this.yieldToMain();
        this.vobsubParser = new VobSubParserLowLevel({
            debug: this.debug,
            onWarning: (warning) => this.emitWarning(warning)
        });
        await new Promise((resolve) => {
            const scheduleTask = typeof requestIdleCallback !== 'undefined'
                ? (cb) => requestIdleCallback(() => cb(), { timeout: 1000 })
                : (cb) => setTimeout(cb, 0);
            scheduleTask(() => {
                if (useMksSource) {
                    this.vobsubParser.loadFromMks(subData);
                }
                else if (idxData) {
                    this.vobsubParser.loadFromData(idxData, subData);
                }
                else {
                    this.vobsubParser.loadFromSubOnly(subData);
                }
                this.state.timestamps = this.vobsubParser.getTimestamps();
                this.state.metadata = this.vobsubParser.getMetadata();
                this.isLoaded = true;
                this.setParserMetadata(this.state.metadata);
                this.emitIndexed('vobsub', this.state.metadata, false);
                resolve();
            });
        });
    }
    getWorkerRendererState() {
        return this.state;
    }
    /** Yield to main thread to prevent UI blocking */
    yieldToMain() {
        const globalScheduler = globalThis.scheduler;
        if (globalScheduler && typeof globalScheduler.yield === 'function') {
            return globalScheduler.yield();
        }
        return new Promise((resolve) => setTimeout(resolve, 0));
    }
    renderAtTime(time) {
        const index = this.findCurrentIndex(time);
        return index < 0 ? undefined : this.renderAtIndex(index);
    }
    findCurrentIndex(time) {
        if (this.state.useWorker && this.state.workerReady) {
            const timeMs = time * 1000;
            // Only use cache if time is very close (within 1 frame)
            const timeDelta = timeMs - this.cachedIndexTime;
            const cacheValid = this.cachedIndexTime >= 0 && Math.abs(timeDelta) < 17;
            if (cacheValid) {
                return this.cachedIndex;
            }
            // Start async lookup if not already pending
            if (!this.pendingIndexLookup) {
                this.pendingIndexLookup = sendToWorker({
                    type: 'findVobSubIndex',
                    sessionId: this.state.sessionId,
                    timeMs
                }).then((response) => {
                    if (response.type === 'vobSubIndex') {
                        const newIndex = response.index;
                        const oldIndex = this.cachedIndex;
                        this.cachedIndex = newIndex;
                        this.cachedIndexTime = timeMs;
                        // Force re-render if index changed (including to -1 for clear)
                        if (oldIndex !== newIndex) {
                            this.lastRenderedIndex = -2; // Use -2 to force update even when new index is -1
                        }
                    }
                    this.pendingIndexLookup = null;
                    return this.cachedIndex;
                });
            }
            return this.cachedIndex;
        }
        return this.vobsubParser?.findIndexAtTimestamp(time) ?? -1;
    }
    renderAtIndex(index) {
        if (this.state.frameCache.has(index)) {
            return this.state.frameCache.get(index) ?? undefined;
        }
        if (this.state.useWorker && this.state.workerReady) {
            // Start async render if not already pending
            if (!this.state.pendingRenders.has(index)) {
                const renderTask = sendToWorker({
                    type: 'renderVobSubAtIndex',
                    sessionId: this.state.sessionId,
                    index
                }).then((response) => {
                    if (response.type === 'vobSubFrame') {
                        return {
                            frame: response.frame ? convertFrameData(response.frame) : null,
                            renderIssue: response.renderIssue?.trim() || null
                        };
                    }
                    return { frame: null, renderIssue: null };
                });
                const renderPromise = renderTask.then(({ frame }) => frame);
                this.state.pendingRenders.set(index, renderPromise);
                this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
                renderTask.then(({ frame, renderIssue }) => {
                    setCachedFrame(this.state, index, frame, renderIssue);
                    this.state.pendingRenders.delete(index);
                    this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
                    // Force re-render on next frame by resetting lastRenderedIndex
                    if (this.findCurrentIndex(this.video.currentTime + this.timeOffset) === index) {
                        this.lastRenderedIndex = -1;
                    }
                });
            }
            // Return undefined to indicate async loading in progress
            return undefined;
        }
        const rendered = this.vobsubParser?.renderAtIndex(index) ?? null;
        setCachedFrame(this.state, index, rendered, this.vobsubParser?.getLastRenderIssue() ?? null);
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
        return rendered ?? undefined;
    }
    buildCueMetadata(index) {
        if (this.vobsubParser) {
            return this.vobsubParser.getCueMetadata(index);
        }
        const metadata = this.state.metadata;
        if (!metadata || index < 0 || index >= this.state.timestamps.length)
            return null;
        const startTime = this.state.timestamps[index];
        const endTime = this.state.timestamps[index + 1] ?? startTime + 5000;
        const frame = this.state.frameCache.get(index) ?? null;
        return {
            index,
            format: 'vobsub',
            startTime,
            endTime,
            duration: Math.max(0, endTime - startTime),
            screenWidth: metadata.screenWidth,
            screenHeight: metadata.screenHeight,
            bounds: frame ? getSubtitleBounds(frame) : null,
            compositionCount: frame?.compositionData.length ?? 0,
            language: metadata.language ?? null,
            trackId: metadata.trackId ?? null
        };
    }
    isPendingRender(index) {
        return this.state.pendingRenders.has(index);
    }
    onSeek() {
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        // Clear cached index lookup on seek
        this.cachedIndex = -1;
        this.cachedIndexTime = -1;
        this.pendingIndexLookup = null;
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearVobSubCache', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.vobsubParser?.clearCache();
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    setCacheLimit(limit) {
        this.cacheLimit = applyCacheLimit(this.state, limit);
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    clearFrameCache() {
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        this.cachedIndex = -1;
        this.cachedIndexTime = -1;
        this.pendingIndexLookup = null;
        this.lastRenderedIndex = -1;
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'clearVobSubCache', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.vobsubParser?.clearCache();
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    async prefetchRange(startIndex, endIndex) {
        const safeStart = Math.max(0, Math.min(startIndex, endIndex));
        const safeEnd = Math.min(Math.max(startIndex, endIndex), this.state.timestamps.length - 1);
        for (let index = safeStart; index <= safeEnd; index++) {
            if (this.state.frameCache.has(index))
                continue;
            const result = this.renderAtIndex(index);
            if (result === undefined && this.state.pendingRenders.has(index)) {
                await this.state.pendingRenders.get(index);
            }
        }
    }
    async prefetchAroundTime(time, before = this.prefetchBefore, after = this.prefetchAfter) {
        const currentIndex = this.findCurrentIndex(time);
        if (currentIndex < 0)
            return;
        await this.prefetchRange(currentIndex - before, currentIndex + after);
    }
    /** Get performance statistics for VobSub renderer */
    getStats() {
        const baseStats = this.getBaseStats();
        return {
            ...baseStats,
            usingWorker: this.state.useWorker && this.state.workerReady,
            cachedFrames: this.state.frameCache.size,
            pendingRenders: this.state.pendingRenders.size,
            totalEntries: this.state.timestamps.length || (this.vobsubParser?.getTimestamps().length ?? 0)
        };
    }
    /** Enable or disable debanding filter */
    setDebandEnabled(enabled) {
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'setVobSubDebandEnabled', sessionId: this.state.sessionId, enabled }).catch(() => { });
        }
        this.vobsubParser?.setDebandEnabled(enabled);
        // Clear cache to force re-render with new settings
        this.state.frameCache.clear();
        this.lastRenderedIndex = -1;
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    /** Set debanding threshold (0-255, default: 64) */
    setDebandThreshold(threshold) {
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'setVobSubDebandThreshold', sessionId: this.state.sessionId, threshold }).catch(() => { });
        }
        this.vobsubParser?.setDebandThreshold(threshold);
        // Clear cache to force re-render with new settings
        this.state.frameCache.clear();
        this.lastRenderedIndex = -1;
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    /** Set debanding sample range in pixels (1-64, default: 15) */
    setDebandRange(range) {
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'setVobSubDebandRange', sessionId: this.state.sessionId, range }).catch(() => { });
        }
        this.vobsubParser?.setDebandRange(range);
        // Clear cache to force re-render with new settings
        this.state.frameCache.clear();
        this.lastRenderedIndex = -1;
        this.emitCacheChange(this.state.frameCache.size, this.state.pendingRenders.size);
    }
    /** Check if debanding is enabled */
    get debandEnabled() {
        return this.vobsubParser?.debandEnabled ?? true;
    }
    dispose() {
        super.dispose();
        this.state.frameCache.clear();
        this.state.renderIssues.clear();
        this.state.pendingRenders.clear();
        if (this.state.useWorker && this.state.workerReady) {
            sendToWorker({ type: 'disposeVobSub', sessionId: this.state.sessionId }).catch(() => { });
        }
        this.vobsubParser?.dispose();
        this.vobsubParser = null;
        this.state.sessionId = null;
    }
}
/** Create a video subtitle renderer with automatic format detection. */
export function createAutoSubtitleRenderer(options) {
    const format = detectSubtitleFormat({
        data: options.subContent,
        idxContent: options.idxContent,
        fileName: options.fileName,
        subUrl: options.subUrl,
        idxUrl: options.idxUrl
    });
    if (format === 'pgs') {
        return new PgsRenderer(options);
    }
    if (format === 'vobsub') {
        return new VobSubRenderer(options);
    }
    throw new Error('Unable to detect subtitle format for video renderer');
}
