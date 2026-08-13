using System.Collections.Generic;
using System.Text.Json.Serialization;

namespace LabMediaWidget
{
    public static class QueueStatuses
    {
        public const string Unavailable = "unavailable";
        public const string RequiresAuth = "requiresAuth";
        public const string Loading = "loading";
        public const string Ready = "ready";
        public const string Empty = "empty";
        public const string Error = "error";
    }

    public sealed class QueueItem
    {
        [JsonPropertyName("id")]
        public string Id { get; set; } = string.Empty;

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("artist")]
        public string Artist { get; set; } = string.Empty;

        [JsonPropertyName("artworkUrl")]
        public string ArtworkUrl { get; set; } = string.Empty;

        [JsonPropertyName("durationMs")]
        public long DurationMs { get; set; }

        [JsonPropertyName("attribution")]
        public string Attribution { get; set; } = string.Empty;
    }

    public sealed class QueueState
    {
        [JsonPropertyName("status")]
        public string Status { get; set; } = QueueStatuses.Unavailable;

        [JsonPropertyName("provider")]
        public string Provider { get; set; } = string.Empty;

        [JsonPropertyName("message")]
        public string Message { get; set; } = "Up Next is not shared by this player.";

        [JsonPropertyName("attribution")]
        public string Attribution { get; set; } = string.Empty;

        [JsonPropertyName("items")]
        public List<QueueItem> Items { get; set; } = new List<QueueItem>();

        public static QueueState Unavailable(string sourceApp = "this player")
        {
            string source = string.IsNullOrWhiteSpace(sourceApp) ? "this player" : sourceApp.Trim();
            return new QueueState
            {
                Status = QueueStatuses.Unavailable,
                Message = $"Up Next is not shared by {source}."
            };
        }
    }

    internal sealed class RuntimeMessage
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        [JsonPropertyName("queue")]
        public QueueState? Queue { get; set; }
    }
}
