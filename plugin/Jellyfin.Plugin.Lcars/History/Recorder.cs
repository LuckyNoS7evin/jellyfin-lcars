using System.Globalization;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Session;
using MediaBrowser.Model.Entities;
using MediaBrowser.Model.Session;
using MediaBrowser.Model.System;
using Microsoft.Extensions.Hosting;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Lcars.History;

/// <summary>
/// Looks at the server every so often: which sessions are transcoding (and how, and why), and,
/// less often, how full each folder's disk is. Jellyfin only knows these in the moment.
/// </summary>
public sealed class Recorder : BackgroundService
{
    // A transcode not seen for this long has ended; seen again after that, it's a new one.
    private static readonly TimeSpan Gap = TimeSpan.FromMinutes(3);
    private readonly ISessionManager _sessions;
    private readonly ISystemManager _system;
    private readonly HistoryStore _store;
    private readonly ILogger<Recorder> _logger;

    /// <summary>Initializes a new instance of the <see cref="Recorder"/> class.</summary>
    /// <param name="sessions">The session manager.</param>
    /// <param name="system">The system manager (storage).</param>
    /// <param name="store">The history.</param>
    /// <param name="logger">The logger.</param>
    public Recorder(ISessionManager sessions, ISystemManager system, HistoryStore store, ILogger<Recorder> logger)
    {
        _sessions = sessions;
        _system = system;
        _store = store;
        _logger = logger;
    }

    private static PluginConfiguration Config => Plugin.Instance?.Configuration ?? new PluginConfiguration();

    /// <inheritdoc />
    protected override async Task ExecuteAsync(CancellationToken stoppingToken)
    {
        // Let the server finish starting first.
        await Task.Delay(TimeSpan.FromSeconds(20), stoppingToken).ConfigureAwait(false);
        var nextStorage = DateTime.MinValue;
        var nextPrune = DateTime.MinValue;
        while (!stoppingToken.IsCancellationRequested)
        {
            var now = DateTime.UtcNow;
            try
            {
                LookAtTranscodes(now);
                if (now >= nextStorage)
                {
                    RecordStorage(now);
                    nextStorage = now.AddMinutes(Math.Clamp(Config.StorageMinutes, 5, 24 * 60));
                }

                if (now >= nextPrune)
                {
                    _store.Prune(Config.RetentionDays);
                    nextPrune = now.AddHours(24);
                }
            }
            catch (Exception e) when (e is not OperationCanceledException)
            {
                _logger.LogWarning(e, "LCARS: recording failed this time");
            }

            await Task.Delay(TimeSpan.FromSeconds(Math.Clamp(Config.TranscodeSeconds, 10, 600)), stoppingToken).ConfigureAwait(false);
        }
    }

    private void LookAtTranscodes(DateTime now)
    {
        var live = _sessions.Sessions
            .Where(s => s.NowPlayingItem is not null && s.PlayState?.PlayMethod == PlayMethod.Transcode && s.TranscodingInfo is not null)
            .ToList();
        if (live.Count == 0)
        {
            return;
        }

        _store.UpdateTranscodes(list =>
        {
            foreach (var s in live)
            {
                var item = s.NowPlayingItem;
                var key = $"{s.Id}/{item.Id:N}";
                var rec = list.LastOrDefault(r => r.Id.StartsWith(key, StringComparison.Ordinal) && now - r.End < Gap);
                if (rec is null)
                {
                    rec = new TranscodeRecord
                    {
                        Id = $"{key}/{now.Ticks.ToString(CultureInfo.InvariantCulture)}",
                        Start = now,
                        UserId = s.UserId,
                        UserName = s.UserName ?? string.Empty,
                        Device = s.DeviceName ?? string.Empty,
                        Client = $"{s.Client} {s.ApplicationVersion}".Trim(),
                        ItemId = item.Id,
                        ItemName = Name(item),
                        ItemType = item.Type.ToString(),
                    };
                    list.Add(rec);
                }

                Fill(rec, s, now);
            }

            return true;
        });
    }

    private static void Fill(TranscodeRecord rec, SessionInfo s, DateTime now)
    {
        var ti = s.TranscodingInfo;
        var streams = s.NowPlayingItem.MediaStreams ?? [];
        var video = streams.FirstOrDefault(m => m.Type == MediaStreamType.Video);
        var audio = streams.FirstOrDefault(m => m.Type == MediaStreamType.Audio && m.Index == s.PlayState.AudioStreamIndex)
            ?? streams.FirstOrDefault(m => m.Type == MediaStreamType.Audio);
        rec.End = now;
        rec.VideoIn = Describe(video);
        rec.AudioIn = Describe(audio);
        rec.VideoOut = ti.IsVideoDirect ? null : Join(ti.VideoCodec, ti.Height is int h ? $"{h}p" : null);
        rec.AudioOut = ti.IsAudioDirect ? null : Join(ti.AudioCodec, ti.AudioChannels is int c ? $"{c}ch" : null);
        rec.ContainerIn = s.NowPlayingItem.Container;
        rec.ContainerOut = ti.Container;
        rec.Hardware = ti.HardwareAccelerationType?.ToString().ToLowerInvariant();
        rec.Bitrate = ti.Bitrate ?? rec.Bitrate;
        if (ti.Framerate is float fps && fps > 0)
        {
            rec.MinFramerate = rec.MinFramerate is float m ? Math.Min(m, fps) : fps;
        }

        // TranscodeReason is a set of flags; keep every one seen over the play.
        foreach (var r in ti.TranscodeReasons.ToString().Split(',', StringSplitOptions.TrimEntries | StringSplitOptions.RemoveEmptyEntries))
        {
            if (r != "0" && !rec.Reasons.Contains(r))
            {
                rec.Reasons.Add(r);
            }
        }
    }

    private void RecordStorage(DateTime now)
    {
        var info = _system.GetSystemStorageInfo();
        var samples = new List<StorageSample>();
        void Add(string group, string label, FolderStorageInfo? f)
        {
            if (f is null || f.UsedSpace < 0 || f.FreeSpace < 0)
            {
                return;
            }

            samples.Add(new StorageSample { T = now, Group = group, Label = label, Path = f.Path, DeviceId = f.DeviceId, Used = f.UsedSpace, Free = f.FreeSpace });
        }

        Add("Server", "Program data", info.ProgramDataFolder);
        Add("Server", "Cache", info.CacheFolder);
        Add("Server", "Image cache", info.ImageCacheFolder);
        Add("Server", "Metadata", info.InternalMetadataFolder);
        Add("Server", "Transcodes", info.TranscodingTempFolder);
        Add("Server", "Logs", info.LogFolder);
        foreach (var lib in info.Libraries)
        {
            foreach (var f in lib.Folders)
            {
                Add(lib.Name, lib.Name, f);
            }
        }

        if (samples.Count > 0)
        {
            _store.AddStorage(samples);
        }
    }

    private static string Name(MediaBrowser.Model.Dto.BaseItemDto item)
    {
        if (!string.IsNullOrEmpty(item.SeriesName))
        {
            var ep = item.ParentIndexNumber is int sn && item.IndexNumber is int en ? $"S{sn:00}E{en:00}" : null;
            return string.Join(" · ", new[] { item.SeriesName, ep, item.Name }.Where(x => !string.IsNullOrEmpty(x)));
        }

        return item.ProductionYear is int y ? $"{item.Name} ({y})" : item.Name ?? string.Empty;
    }

    private static string? Describe(MediaStream? m)
    {
        if (m is null)
        {
            return null;
        }

        return m.Type == MediaStreamType.Video
            ? Join(m.Codec, m.Height is int h ? $"{h}p" : null, m.VideoRangeType.ToString() is var r && r != "SDR" && r != "Unknown" ? r : null,
                m.BitRate is int b ? $"{b / 1e6:0.0} Mbps".Replace(',', '.') : null)
            : Join(m.Codec, m.Channels is int c ? $"{c}ch" : null, m.Language);
    }

    private static string? Join(params string?[] parts)
    {
        var s = string.Join(' ', parts.Where(p => !string.IsNullOrEmpty(p)));
        return s.Length == 0 ? null : s;
    }
}
