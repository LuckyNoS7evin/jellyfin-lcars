namespace Jellyfin.Plugin.Lcars.History;

/// <summary>One transcode: a session playing one item with the server converting it.</summary>
public sealed class TranscodeRecord
{
    /// <summary>Gets or sets the record's id.</summary>
    public string Id { get; set; } = string.Empty;

    /// <summary>Gets or sets when it was first seen (UTC).</summary>
    public DateTime Start { get; set; }

    /// <summary>Gets or sets when it was last seen (UTC).</summary>
    public DateTime End { get; set; }

    /// <summary>Gets or sets the user's id.</summary>
    public Guid UserId { get; set; }

    /// <summary>Gets or sets the user's name.</summary>
    public string UserName { get; set; } = string.Empty;

    /// <summary>Gets or sets the device's name.</summary>
    public string Device { get; set; } = string.Empty;

    /// <summary>Gets or sets the app and its version.</summary>
    public string Client { get; set; } = string.Empty;

    /// <summary>Gets or sets the item's id.</summary>
    public Guid ItemId { get; set; }

    /// <summary>Gets or sets the item's name ("Series · S01E02 · Name" for an episode).</summary>
    public string ItemName { get; set; } = string.Empty;

    /// <summary>Gets or sets the item's type.</summary>
    public string ItemType { get; set; } = string.Empty;

    /// <summary>Gets or sets the source video ("hevc 2160p HDR10 40.1 Mbps").</summary>
    public string? VideoIn { get; set; }

    /// <summary>Gets or sets the video sent ("h264 1080p"), or null when copied.</summary>
    public string? VideoOut { get; set; }

    /// <summary>Gets or sets the source audio ("truehd 8ch eng").</summary>
    public string? AudioIn { get; set; }

    /// <summary>Gets or sets the audio sent ("aac 2ch"), or null when copied.</summary>
    public string? AudioOut { get; set; }

    /// <summary>Gets or sets the source container.</summary>
    public string? ContainerIn { get; set; }

    /// <summary>Gets or sets the container sent.</summary>
    public string? ContainerOut { get; set; }

    /// <summary>Gets or sets the encoder ("vaapi", "qsv", "none" for software).</summary>
    public string? Hardware { get; set; }

    /// <summary>Gets or sets the bitrate sent, in bits per second.</summary>
    public int? Bitrate { get; set; }

    /// <summary>Gets or sets the slowest encoding speed seen, in frames per second.</summary>
    public float? MinFramerate { get; set; }

    /// <summary>Gets or sets why the server transcoded (Jellyfin's TranscodeReason names).</summary>
    public List<string> Reasons { get; set; } = [];
}

/// <summary>One folder's space at one time.</summary>
public sealed class StorageSample
{
    /// <summary>Gets or sets when (UTC).</summary>
    public DateTime T { get; set; }

    /// <summary>Gets or sets "Server" or the library's name.</summary>
    public string Group { get; set; } = string.Empty;

    /// <summary>Gets or sets what the folder is ("Cache", "Transcodes"; the library's name again for its folders).</summary>
    public string Label { get; set; } = string.Empty;

    /// <summary>Gets or sets the folder's path.</summary>
    public string Path { get; set; } = string.Empty;

    /// <summary>Gets or sets the disk's id, so folders on one disk can be drawn once.</summary>
    public string? DeviceId { get; set; }

    /// <summary>Gets or sets the bytes used on its disk.</summary>
    public long Used { get; set; }

    /// <summary>Gets or sets the bytes free on its disk.</summary>
    public long Free { get; set; }
}
