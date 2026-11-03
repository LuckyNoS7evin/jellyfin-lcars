using Jellyfin.Plugin.Lcars.History;
using MediaBrowser.Controller;
using MediaBrowser.Controller.Plugins;
using Microsoft.Extensions.DependencyInjection;

namespace Jellyfin.Plugin.Lcars;

/// <summary>Registers the history store and the recorder that fills it.</summary>
public class ServiceRegistrator : IPluginServiceRegistrator
{
    /// <inheritdoc />
    public void RegisterServices(IServiceCollection serviceCollection, IServerApplicationHost applicationHost)
    {
        serviceCollection.AddSingleton<HistoryStore>();
        serviceCollection.AddHostedService<Recorder>();
    }
}
