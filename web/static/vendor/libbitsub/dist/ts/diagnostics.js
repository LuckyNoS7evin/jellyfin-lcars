export class SubtitleDiagnosticError extends Error {
    code;
    format;
    details;
    cause;
    constructor(code, message, options = {}) {
        super(message);
        this.name = 'SubtitleDiagnosticError';
        this.code = code;
        this.format = options.format;
        this.details = options.details;
        this.cause = options.cause;
    }
}
export function createSubtitleDiagnosticError(code, message, options = {}) {
    return new SubtitleDiagnosticError(code, message, options);
}
export function normalizeSubtitleError(error, context = {}) {
    if (error instanceof SubtitleDiagnosticError) {
        return error;
    }
    const resolvedError = error instanceof Error ? error : new Error(String(error));
    const code = inferSubtitleDiagnosticErrorCode(resolvedError.message, context.fallbackCode);
    return new SubtitleDiagnosticError(code, resolvedError.message, {
        format: context.format,
        details: context.details,
        cause: error
    });
}
export function createSubtitleWarning(code, message, options = {}) {
    return {
        code,
        message,
        format: options.format,
        cueIndex: options.cueIndex,
        details: options.details
    };
}
export function warningFromRenderIssue(renderIssue, options = {}) {
    const normalizedIssue = renderIssue?.trim().toUpperCase();
    if (!normalizedIssue)
        return null;
    switch (normalizedIssue) {
        case 'MISSING_PALETTE':
            return createSubtitleWarning('MISSING_PALETTE', 'PGS cue references a palette that was not available at render time.', {
                format: options.format,
                cueIndex: options.cueIndex
            });
        case 'INVALID_PACKET':
            return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle packet could not be decoded for the requested cue.', {
                format: options.format,
                cueIndex: options.cueIndex
            });
        case 'RENDER_CONTEXT_UNAVAILABLE':
            return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle render context could not be assembled for the requested cue.', {
                format: options.format,
                cueIndex: options.cueIndex
            });
        case 'EMPTY_RENDER':
            return createSubtitleWarning('INVALID_SUBTITLE_DATA', 'Subtitle cue rendered without any visible bitmap data.', {
                format: options.format,
                cueIndex: options.cueIndex
            });
        default:
            return null;
    }
}
export function formatSubtitleWarningForConsole(warning) {
    return `[libbitsub:${warning.code}] ${warning.message}`;
}
function inferSubtitleDiagnosticErrorCode(message, fallbackCode = 'UNKNOWN') {
    const normalizedMessage = message.toLowerCase();
    if (normalizedMessage.includes('detect subtitle format') || normalizedMessage.includes('unsupported format')) {
        return 'UNSUPPORTED_FORMAT';
    }
    if (normalizedMessage.includes('no s_vobsub track') || normalizedMessage.includes('track not found')) {
        return 'TRACK_NOT_FOUND';
    }
    if (normalizedMessage.includes('idx') ||
        normalizedMessage.includes('codecprivate') ||
        normalizedMessage.includes('filepos')) {
        return 'BAD_IDX';
    }
    if (normalizedMessage.includes('palette')) {
        return 'MISSING_PALETTE';
    }
    if (normalizedMessage.includes('failed to fetch')) {
        return 'FETCH_FAILED';
    }
    if (normalizedMessage.includes('no ') && normalizedMessage.includes('provided')) {
        return 'MISSING_INPUT';
    }
    if (normalizedMessage.includes('invalid') ||
        normalizedMessage.includes('truncated') ||
        normalizedMessage.includes('malformed') ||
        normalizedMessage.includes('subtitle block') ||
        normalizedMessage.includes('payload')) {
        return 'INVALID_SUBTITLE_DATA';
    }
    return fallbackCode;
}
