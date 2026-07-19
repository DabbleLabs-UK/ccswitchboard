using System.Diagnostics;
using System.IO;

// Wraps the existing autostart/*.ps1 Task Scheduler scripts so the tray menu
// can call them without duplicating their registration logic.
internal static class AutostartTask
{
    public static async Task<(bool Success, string Message)> RunScriptAsync(string scriptName, params string[] extraArgs)
    {
        var scriptPath = FindAutostartScript(scriptName);
        if (scriptPath is null)
        {
            return (false, $"Could not find autostart script '{scriptName}' above {AppContext.BaseDirectory}.");
        }

        var psi = new ProcessStartInfo
        {
            FileName = "powershell.exe",
            UseShellExecute = false,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
            CreateNoWindow = true,
        };
        psi.ArgumentList.Add("-NoProfile");
        psi.ArgumentList.Add("-ExecutionPolicy");
        psi.ArgumentList.Add("Bypass");
        psi.ArgumentList.Add("-File");
        psi.ArgumentList.Add(scriptPath);
        foreach (var arg in extraArgs)
        {
            psi.ArgumentList.Add(arg);
        }

        using var process = new Process { StartInfo = psi };
        process.Start();
        var stdoutTask = process.StandardOutput.ReadToEndAsync();
        var stderrTask = process.StandardError.ReadToEndAsync();
        await process.WaitForExitAsync();
        var stdout = (await stdoutTask).Trim();
        var stderr = (await stderrTask).Trim();

        var success = process.ExitCode == 0;
        var message = success ? stdout : (string.IsNullOrWhiteSpace(stderr) ? stdout : stderr);
        return (success, string.IsNullOrWhiteSpace(message) ? (success ? "Done." : $"Exit code {process.ExitCode}.") : message);
    }

    // Walks up from the running exe's directory looking for an "autostart"
    // folder containing the named script -- avoids hardcoding the exact
    // bin/<Debug|Release>/net10.0-windows depth, which would silently break
    // if the output layout ever changes.
    private static string? FindAutostartScript(string scriptName)
    {
        var dir = new DirectoryInfo(AppContext.BaseDirectory);
        for (var i = 0; i < 8 && dir is not null; i++, dir = dir.Parent)
        {
            var candidate = Path.Combine(dir.FullName, "autostart", scriptName);
            if (File.Exists(candidate))
            {
                return candidate;
            }
        }
        return null;
    }
}
