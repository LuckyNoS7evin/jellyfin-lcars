using System.Text.Json;
using MediaBrowser.Common.Configuration;
using Microsoft.Extensions.Logging;

namespace Jellyfin.Plugin.Lcars.History;

/// <summary>
/// The history, kept as two small JSON files in the server's data folder (lcars/): transcodes and
/// storage samples. Both are small (a home server transcodes a few times a day; storage is a few
/// folders an hour, thinned to one a day after a week), so they live in memory and are rewritten
/// whole, through a temporary file so a crash never leaves half a file.
/// </summary>
public sealed class HistoryStore
{
    private static readonly JsonSerializerOptions Json = new() { WriteIndented = false };
    private readonly object _lock = new();
    private readonly ILogger<HistoryStore> _logger;
    private readonly string _dir;
    private List<TranscodeRecord> _transcodes = [];
    private List<StorageSample> _storage = [];
    private bool _loaded;

    /// <summary>Initializes a new instance of the <see cref="HistoryStore"/> class.</summary>
    /// <param name="paths">The server's paths.</param>
    /// <param name="logger">The logger.</param>
    public HistoryStore(IApplicationPaths paths, ILogger<HistoryStore> logger)
    {
        _logger = logger;
        _dir = Path.Combine(paths.DataPath, "lcars");
    }

    private string TranscodesFile => Path.Combine(_dir, "transcodes.json");

    private string StorageFile => Path.Combine(_dir, "storage.json");

    /// <summary>Gets when recording started (the oldest thing kept), if anything is kept.</summary>
    public DateTime? Since
    {
        get
        {
            lock (_lock)
            {
                Load();
                var a = _transcodes.Count > 0 ? _transcodes.Min(t => t.Start) : (DateTime?)null;
                var b = _storage.Count > 0 ? _storage.Min(s => s.T) : (DateTime?)null;
                return a is null ? b : b is null ? a : (a < b ? a : b);
            }
        }
    }

    /// <summary>Gets the transcodes still running or ended since a time.</summary>
    /// <param name="since">The earliest end (UTC).</param>
    /// <returns>Copies of the records, newest first.</returns>
    public List<TranscodeRecord> Transcodes(DateTime since)
    {
        lock (_lock)
        {
            Load();
            return _transcodes.Where(t => t.End >= since).OrderByDescending(t => t.Start).ToList();
        }
    }

    /// <summary>Gets the storage samples since a time.</summary>
    /// <param name="since">The earliest (UTC).</param>
    /// <returns>The samples, oldest first.</returns>
    public List<StorageSample> Storage(DateTime since)
    {
        lock (_lock)
        {
            Load();
            return _storage.Where(s => s.T >= since).OrderBy(s => s.T).ToList();
        }
    }

    /// <summary>Gets the number of transcodes and storage samples kept.</summary>
    /// <returns>The two counts.</returns>
    public (int Transcodes, int Storage) Counts()
    {
        lock (_lock)
        {
            Load();
            return (_transcodes.Count, _storage.Count);
        }
    }

    /// <summary>Changes the transcode list under the lock and saves it if the change says so.</summary>
    /// <param name="change">Edits the list; returns whether anything changed.</param>
    public void UpdateTranscodes(Func<List<TranscodeRecord>, bool> change)
    {
        lock (_lock)
        {
            Load();
            if (change(_transcodes))
            {
                Save(TranscodesFile, _transcodes);
            }
        }
    }

    /// <summary>Adds storage samples and saves.</summary>
    /// <param name="samples">The samples.</param>
    public void AddStorage(IEnumerable<StorageSample> samples)
    {
        lock (_lock)
        {
            Load();
            _storage.AddRange(samples);
            Save(StorageFile, _storage);
        }
    }

    /// <summary>
    /// Drops what's older than the retention, and thins storage older than a week to the last
    /// sample of each day for each folder.
    /// </summary>
    /// <param name="retentionDays">How many days to keep.</param>
    public void Prune(int retentionDays)
    {
        var cutoff = DateTime.UtcNow.AddDays(-Math.Max(1, retentionDays));
        var week = DateTime.UtcNow.AddDays(-7);
        lock (_lock)
        {
            Load();
            var before = (_transcodes.Count, _storage.Count);
            _transcodes = _transcodes.Where(t => t.End >= cutoff).ToList();
            var recent = _storage.Where(s => s.T >= week);
            var daily = _storage.Where(s => s.T < week && s.T >= cutoff)
                .GroupBy(s => (s.Path, s.T.Date))
                .Select(g => g.OrderBy(s => s.T).Last());
            _storage = daily.Concat(recent).OrderBy(s => s.T).ToList();
            if (before.Item1 != _transcodes.Count)
            {
                Save(TranscodesFile, _transcodes);
            }

            if (before.Item2 != _storage.Count)
            {
                Save(StorageFile, _storage);
            }
        }
    }

    private void Load()
    {
        if (_loaded)
        {
            return;
        }

        _loaded = true;
        _transcodes = Read<TranscodeRecord>(TranscodesFile);
        _storage = Read<StorageSample>(StorageFile);
    }

    private List<T> Read<T>(string file)
    {
        try
        {
            return File.Exists(file) ? JsonSerializer.Deserialize<List<T>>(File.ReadAllText(file), Json) ?? [] : [];
        }
        catch (Exception e) when (e is IOException or JsonException or UnauthorizedAccessException)
        {
            // Keep the unreadable file for a look, and start afresh.
            _logger.LogWarning(e, "LCARS: couldn't read {File}; starting a new one", file);
            try
            {
                File.Move(file, file + ".bad", true);
            }
            catch (IOException)
            {
            }

            return [];
        }
    }

    private void Save<T>(string file, List<T> list)
    {
        try
        {
            Directory.CreateDirectory(_dir);
            var tmp = file + ".tmp";
            File.WriteAllText(tmp, JsonSerializer.Serialize(list, Json));
            File.Move(tmp, file, true);
        }
        catch (Exception e) when (e is IOException or UnauthorizedAccessException)
        {
            _logger.LogWarning(e, "LCARS: couldn't save {File}", file);
        }
    }
}
