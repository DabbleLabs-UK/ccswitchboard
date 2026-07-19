using System.IO;

// Picks and validates the folder popup.log lives in. Kept separate from
// FileLogger so the Settings dialog can run the exact same writability check
// before saving that FileLogger runs at startup.
internal static class LogPathResolver
{
    // Per-user default: never hardcode a specific machine's path (e.g. V:/tmp
    // or a dev box's profile) -- this resolves per-account wherever the app runs.
    public static string DefaultFolder { get; } = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CcswPopup");

    // Attempts to create (if needed) and write into the folder. Returns null
    // on success, or a short human-readable reason on failure.
    public static string? TryValidate(string folder)
    {
        try
        {
            Directory.CreateDirectory(folder);
            var probePath = Path.Combine(folder, $".write-test-{Guid.NewGuid():N}.tmp");
            File.WriteAllText(probePath, string.Empty);
            File.Delete(probePath);
            return null;
        }
        catch (Exception ex)
        {
            return ex.Message;
        }
    }

    // Resolution order: the configured folder, if set and writable; else the
    // per-user default; else next to the exe as a last resort. Returns the
    // chosen folder plus a warning describing any fallback that occurred.
    public static string Resolve(string? configuredFolder, out string? warning)
    {
        warning = null;

        // Best-effort: make sure the fallback location exists up front, even
        // when a custom configured folder ends up being the one actually
        // used below -- so the default is always a real, Browse-able folder.
        try
        {
            Directory.CreateDirectory(DefaultFolder);
        }
        catch
        {
            // TryValidate below will surface any real problem with this
            // folder if resolution actually needs to fall back to it.
        }

        if (!string.IsNullOrWhiteSpace(configuredFolder))
        {
            var error = TryValidate(configuredFolder);
            if (error is null)
            {
                return configuredFolder;
            }
            warning = $"Configured log path \"{configuredFolder}\" is not writable ({error}); falling back to default.";
        }

        var defaultError = TryValidate(DefaultFolder);
        if (defaultError is null)
        {
            return DefaultFolder;
        }

        warning = (warning is null ? "" : warning + " ") +
            $"Default log path \"{DefaultFolder}\" is not writable ({defaultError}); falling back to exe folder.";
        return AppContext.BaseDirectory;
    }
}
