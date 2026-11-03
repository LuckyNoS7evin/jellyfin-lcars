using System.Reflection;
using Jellyfin.Plugin.Lcars.History;
using MediaBrowser.Common.Api;
using Microsoft.AspNetCore.Authorization;
using Microsoft.AspNetCore.Http;
using Microsoft.AspNetCore.Mvc;

namespace Jellyfin.Plugin.Lcars.Api;

/// <summary>What the plugin has recorded, for administrators (LCARS's Diagnostics pages).</summary>
[ApiController]
[Route("Lcars")]
[Authorize(Policy = Policies.RequiresElevation)]
[Produces("application/json")]
public class LcarsController : ControllerBase
{
    private readonly HistoryStore _store;

    /// <summary>Initializes a new instance of the <see cref="LcarsController"/> class.</summary>
    /// <param name="store">The history.</param>
    public LcarsController(HistoryStore store)
    {
        _store = store;
    }

    /// <summary>The plugin's version and what it holds.</summary>
    /// <returns>Version, options, and counts.</returns>
    [HttpGet("Info")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<object> GetInfo()
    {
        var (transcodes, storage) = _store.Counts();
        var cfg = Plugin.Instance?.Configuration ?? new PluginConfiguration();
        return Ok(new
        {
            Version = Assembly.GetExecutingAssembly().GetName().Version?.ToString(),
            Since = _store.Since,
            Transcodes = transcodes,
            StorageSamples = storage,
            cfg.RetentionDays,
            cfg.TranscodeSeconds,
            cfg.StorageMinutes,
        });
    }

    /// <summary>Transcodes running now or ended in the last days.</summary>
    /// <param name="days">How many days back (default 30).</param>
    /// <returns>The transcodes, newest first.</returns>
    [HttpGet("History/Transcodes")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<TranscodeRecord>> GetTranscodes([FromQuery] int days = 30)
        => Ok(_store.Transcodes(DateTime.UtcNow.AddDays(-Math.Clamp(days, 1, 3660))));

    /// <summary>Storage samples from the last days.</summary>
    /// <param name="days">How many days back (default 90).</param>
    /// <returns>The samples, oldest first.</returns>
    [HttpGet("History/Storage")]
    [ProducesResponseType(StatusCodes.Status200OK)]
    public ActionResult<List<StorageSample>> GetStorage([FromQuery] int days = 90)
        => Ok(_store.Storage(DateTime.UtcNow.AddDays(-Math.Clamp(days, 1, 3660))));
}
