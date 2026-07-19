using System.IO;
using System.Text.Json;

// Loads/saves popup.config.json. Kept separate from Program.cs so settings
// added later (this is step one of the DECONFIG epic) have one obvious place
// to add a read/write pair instead of duplicating JsonSerializer calls.
internal static class PopupConfigStore
{
    private static readonly JsonSerializerOptions ReadOptions = new()
    {
        PropertyNameCaseInsensitive = true,
    };

    private static readonly JsonSerializerOptions WriteOptions = new()
    {
        WriteIndented = true,
        PropertyNamingPolicy = JsonNamingPolicy.CamelCase,
        DefaultIgnoreCondition = System.Text.Json.Serialization.JsonIgnoreCondition.WhenWritingNull,
    };

    public static PopupConfig? Load(string path)
    {
        var json = File.ReadAllText(path);
        return JsonSerializer.Deserialize<PopupConfig>(json, ReadOptions);
    }

    public static void Save(string path, PopupConfig config)
    {
        var json = JsonSerializer.Serialize(config, WriteOptions);
        File.WriteAllText(path, json);
    }
}
