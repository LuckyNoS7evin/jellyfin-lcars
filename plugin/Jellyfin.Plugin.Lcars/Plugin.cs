using MediaBrowser.Common.Configuration;
using MediaBrowser.Common.Plugins;
using MediaBrowser.Model.Serialization;

namespace Jellyfin.Plugin.Lcars;

/// <summary>
/// The LCARS companion plugin. It has no settings page of its own: LCARS's admin dashboard
/// (Engineering, Diagnostics) shows what it records and sets its options.
/// </summary>
public class Plugin : BasePlugin<PluginConfiguration>
{
    /// <summary>The plugin's id, as LCARS looks it up.</summary>
    public static readonly Guid PluginId = Guid.Parse("f3cec76b-7d21-4960-97cb-b4259781b75a");

    /// <summary>Initializes a new instance of the <see cref="Plugin"/> class.</summary>
    /// <param name="applicationPaths">The server's paths.</param>
    /// <param name="xmlSerializer">The XML serializer for the configuration.</param>
    public Plugin(IApplicationPaths applicationPaths, IXmlSerializer xmlSerializer)
        : base(applicationPaths, xmlSerializer)
    {
        Instance = this;
    }

    /// <inheritdoc />
    public override string Name => "LCARS";

    /// <inheritdoc />
    public override Guid Id => PluginId;

    /// <inheritdoc />
    public override string Description => "Records transcodes and storage use over time for the LCARS web client's admin dashboard.";

    /// <summary>Gets the running instance.</summary>
    public static Plugin? Instance { get; private set; }
}
