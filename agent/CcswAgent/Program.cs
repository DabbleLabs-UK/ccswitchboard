using System.Text.Json;
using System.Windows.Forms;

namespace CcswAgent;

internal static class Program
{
    [STAThread]
    private static int Main()
    {
        var configPath = Path.Combine(AppContext.BaseDirectory, "agent.config.json");
        if (!File.Exists(configPath))
        {
            MessageBox.Show(
                $"{configPath} not found. Copy agent.config.example.json and fill in values.",
                "CcswAgent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var configJson = File.ReadAllText(configPath);
        var config = JsonSerializer.Deserialize<AgentConfig>(configJson, new JsonSerializerOptions
        {
            PropertyNameCaseInsensitive = true
        });
        if (config is null || string.IsNullOrWhiteSpace(config.Machine))
        {
            MessageBox.Show(
                $"{configPath} missing 'machine'.",
                "CcswAgent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        var relays = BuildRelays(config);
        if (relays.Count == 0)
        {
            MessageBox.Show(
                $"{configPath} must define either 'relays' (a non-empty array of {{base, token}}) or the legacy 'relayBase'.",
                "CcswAgent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            return 1;
        }

        Application.EnableVisualStyles();
        Application.SetCompatibleTextRenderingDefault(false);

        var router = new RelayRouter(relays);
        var core = new AgentCore(router, config.BashPath, config.Machine, config.McpConfigPath, config.ClaudeExePath);
        Application.Run(new TrayAppContext(core, config.WorkerCount));
        return 0;
    }

    // Ordered relay list, index 0 = primary. Prefers the new "relays" array;
    // falls back to the legacy single "relayBase" + "token" pair so an existing
    // agent.config.json written before multi-relay existed keeps working
    // verbatim -- it just yields a one-element list with nothing to fail over
    // to, which is exactly the old behaviour.
    private static List<RelayEndpoint> BuildRelays(AgentConfig config)
    {
        var relays = new List<RelayEndpoint>();

        if (config.Relays is { Count: > 0 })
        {
            var priority = 0;
            foreach (var entry in config.Relays)
            {
                if (entry is null || string.IsNullOrWhiteSpace(entry.Base))
                {
                    continue;
                }

                relays.Add(new RelayEndpoint(entry.Base, entry.Token, priority++));
            }

            return relays;
        }

        if (!string.IsNullOrWhiteSpace(config.RelayBase))
        {
            relays.Add(new RelayEndpoint(config.RelayBase, config.Token, 0));
        }

        return relays;
    }
}
