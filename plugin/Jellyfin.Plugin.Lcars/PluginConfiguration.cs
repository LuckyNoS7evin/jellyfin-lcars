using MediaBrowser.Model.Plugins;

namespace Jellyfin.Plugin.Lcars;

/// <summary>The plugin's options, set from LCARS's dashboard.</summary>
public class PluginConfiguration : BasePluginConfiguration
{
    /// <summary>Gets or sets how long history is kept, in days.</summary>
    public int RetentionDays { get; set; } = 365;

    /// <summary>Gets or sets how often running transcodes are looked at, in seconds.</summary>
    public int TranscodeSeconds { get; set; } = 30;

    /// <summary>Gets or sets how often storage use is recorded, in minutes.</summary>
    public int StorageMinutes { get; set; } = 60;
}
