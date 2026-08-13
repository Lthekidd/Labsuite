using System.Text.Json.Serialization;

namespace LabMediaWidget
{
    public class ControlsConfig
    {
        [JsonPropertyName("previous")]
        public bool Previous { get; set; } = true;

        [JsonPropertyName("playPause")]
        public bool PlayPause { get; set; } = true;

        [JsonPropertyName("next")]
        public bool Next { get; set; } = true;
    }

    public class LabMediaConfig
    {
        [JsonPropertyName("schemaVersion")]
        public int SchemaVersion { get; set; } = 2;

        [JsonPropertyName("enabled")]
        public bool Enabled { get; set; } = true;

        [JsonPropertyName("size")]
        public string Size { get; set; } = "normal"; // "compact", "normal", "large"

        [JsonPropertyName("theme")]
        public string Theme { get; set; } = "spotify"; // "spotify", "oled", "neon", "glass", "minimal"

        [JsonPropertyName("opacity")]
        public double Opacity { get; set; } = 1.0;

        [JsonPropertyName("showAlbumArt")]
        public bool ShowAlbumArt { get; set; } = true;

        [JsonPropertyName("showProgress")]
        public bool ShowProgress { get; set; } = true;

        [JsonPropertyName("autoHideWhenIdle")]
        public bool AutoHideWhenIdle { get; set; } = false;

        [JsonPropertyName("hideWhenFullscreen")]
        public bool HideWhenFullscreen { get; set; } = true;

        [JsonPropertyName("primaryClickAction")]
        public string PrimaryClickAction { get; set; } = "panel"; // "panel", "openSource"

        [JsonPropertyName("taskbarControlMode")]
        public string TaskbarControlMode { get; set; } = "adaptive"; // "adaptive", "always", "minimal"

        [JsonPropertyName("controls")]
        public ControlsConfig Controls { get; set; } = new ControlsConfig();
    }
}
