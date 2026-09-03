using System.Collections.Generic;
using System.Text.Json.Serialization;
using System.Windows.Media;

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

        [JsonPropertyName("queueIndex")]
        public int QueueIndex { get; set; } = -1;

        [JsonPropertyName("kind")]
        public string Kind { get; set; } = "queue";

        [JsonPropertyName("available")]
        public bool Available { get; set; } = true;
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

        [JsonPropertyName("autoplay")]
        public bool Autoplay { get; set; }

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

    public sealed class YTMDesktopPlaybackState
    {
        [JsonPropertyName("hasTrack")]
        public bool HasTrack { get; set; }

        [JsonPropertyName("videoId")]
        public string VideoId { get; set; } = string.Empty;

        [JsonPropertyName("title")]
        public string Title { get; set; } = string.Empty;

        [JsonPropertyName("artist")]
        public string Artist { get; set; } = string.Empty;

        [JsonPropertyName("album")]
        public string Album { get; set; } = string.Empty;

        [JsonPropertyName("artworkUrl")]
        public string ArtworkUrl { get; set; } = string.Empty;

        [JsonPropertyName("durationSeconds")]
        public double DurationSeconds { get; set; }

        [JsonPropertyName("positionSeconds")]
        public double PositionSeconds { get; set; }

        [JsonPropertyName("isPlaying")]
        public bool IsPlaying { get; set; }

        [JsonPropertyName("isBuffering")]
        public bool IsBuffering { get; set; }

        [JsonPropertyName("volume")]
        public double Volume { get; set; }

        [JsonPropertyName("muted")]
        public bool Muted { get; set; }

        [JsonPropertyName("shuffleActive")]
        public bool ShuffleActive { get; set; }

        [JsonPropertyName("repeatMode")]
        public string RepeatMode { get; set; } = "none";

        [JsonPropertyName("likeState")]
        public string LikeState { get; set; } = "unknown";

        [JsonPropertyName("autoplay")]
        public bool Autoplay { get; set; }

        [JsonPropertyName("isGenerating")]
        public bool IsGenerating { get; set; }

        [JsonPropertyName("isInfinite")]
        public bool IsInfinite { get; set; }
    }

    public sealed class YTMDesktopRuntimeState
    {
        [JsonPropertyName("status")]
        public string Status { get; set; } = "notInstalled";

        [JsonPropertyName("message")]
        public string Message { get; set; } = string.Empty;

        [JsonPropertyName("installed")]
        public bool Installed { get; set; }

        [JsonPropertyName("running")]
        public bool Running { get; set; }

        [JsonPropertyName("paired")]
        public bool Paired { get; set; }

        [JsonPropertyName("active")]
        public bool Active { get; set; }

        [JsonPropertyName("playback")]
        public YTMDesktopPlaybackState Playback { get; set; } = new YTMDesktopPlaybackState();

        [JsonPropertyName("capabilities")]
        public YTMDesktopCapabilities Capabilities { get; set; } = new YTMDesktopCapabilities();
    }

    public sealed class YTMDesktopCapabilities
    {
        [JsonPropertyName("canPlayPause")]
        public bool CanPlayPause { get; set; }

        [JsonPropertyName("canSkipPrevious")]
        public bool CanSkipPrevious { get; set; }

        [JsonPropertyName("canSkipNext")]
        public bool CanSkipNext { get; set; }

        [JsonPropertyName("canSeek")]
        public bool CanSeek { get; set; }

        [JsonPropertyName("canShuffle")]
        public bool CanShuffle { get; set; }

        [JsonPropertyName("canRepeat")]
        public bool CanRepeat { get; set; }

        [JsonPropertyName("canLike")]
        public bool CanLike { get; set; }

        [JsonPropertyName("canDislike")]
        public bool CanDislike { get; set; }

        [JsonPropertyName("canSetVolume")]
        public bool CanSetVolume { get; set; }

        [JsonPropertyName("canMute")]
        public bool CanMute { get; set; }

        [JsonPropertyName("canPlayQueueItem")]
        public bool CanPlayQueueItem { get; set; }
    }

    internal sealed class RuntimeMessage
    {
        [JsonPropertyName("type")]
        public string Type { get; set; } = string.Empty;

        [JsonPropertyName("queue")]
        public QueueState? Queue { get; set; }

        [JsonPropertyName("ytmd")]
        public YTMDesktopRuntimeState? YTMDesktop { get; set; }
    }
}
