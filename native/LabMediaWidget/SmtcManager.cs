using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media.Imaging;
using Windows.Media;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace LabMediaWidget
{
    public sealed class MediaSessionSummary
    {
        public string SessionId { get; set; } = string.Empty;
        public string SourceApp { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string Artist { get; set; } = string.Empty;
        public bool IsPlaying { get; set; }
        public string DisplayLabel => string.IsNullOrWhiteSpace(Title)
            ? SourceApp
            : $"{SourceApp} — {Title}";
    }

    public class MediaSessionState
    {
        public bool HasSession { get; set; }
        public string SessionId { get; set; } = string.Empty;
        public string Title { get; set; } = string.Empty;
        public string Artist { get; set; } = string.Empty;
        public string Album { get; set; } = string.Empty;
        public string SourceApp { get; set; } = string.Empty;
        public bool IsPlaying { get; set; }
        public double PositionSeconds { get; set; }
        public double DurationSeconds { get; set; }
        public BitmapImage? AlbumArt { get; set; }
        public bool CanSkipPrevious { get; set; }
        public bool CanPlayPause { get; set; }
        public bool CanSkipNext { get; set; }
        public bool CanSeek { get; set; }
        public bool CanShuffle { get; set; }
        public bool CanRepeat { get; set; }
        public bool ShuffleActive { get; set; }
        public string RepeatMode { get; set; } = "none";
        public IReadOnlyList<MediaSessionSummary> Sessions { get; set; } = Array.Empty<MediaSessionSummary>();
        public int SessionCount => Sessions.Count;
    }

    public class SmtcManager
    {
        private GlobalSystemMediaTransportControlsSessionManager? _manager;
        private GlobalSystemMediaTransportControlsSession? _currentSession;
        private readonly SemaphoreSlim _refreshGate = new SemaphoreSlim(1, 1);
        private readonly Dictionary<string, string> _sessionIds =
            new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
        private string _albumArtKey = string.Empty;
        private BitmapImage? _cachedAlbumArt;
        private string? _forcedSessionId;

        public MediaSessionState CurrentSessionState { get; private set; } = new MediaSessionState();
        public event EventHandler<MediaSessionState>? SessionStateChanged;

        public async Task InitializeAsync()
        {
            try
            {
                _manager = await GlobalSystemMediaTransportControlsSessionManager.RequestAsync();
                if (_manager != null)
                {
                    _manager.SessionsChanged += Manager_SessionsChanged;
                    await RefreshAsync();
                }
            }
            catch (Exception ex)
            {
                EmitError($"SMTC init failed: {ex.Message}");
            }
        }

        public async Task SelectSessionAsync(string sessionId)
        {
            if (string.IsNullOrWhiteSpace(sessionId) || _manager == null) return;
            _forcedSessionId = sessionId;
            await RefreshAsync(forceWait: true);
        }

        private void Manager_SessionsChanged(
            GlobalSystemMediaTransportControlsSessionManager sender,
            SessionsChangedEventArgs args)
        {
            _ = RefreshAsync();
        }

        private string GetSessionId(GlobalSystemMediaTransportControlsSession session)
        {
            string key = GetRuntimeSessionKey(session);
            if (!_sessionIds.TryGetValue(key, out string? id))
            {
                id = Guid.NewGuid().ToString("N");
                _sessionIds[key] = id;
            }
            return id;
        }

        private static string GetRuntimeSessionKey(GlobalSystemMediaTransportControlsSession session)
        {
            // GSMTC exposes one session per source application. Use the AUMID as
            // the process-lifetime identity so fresh WinRT wrappers do not make
            // the dropdown selection jump between refreshes.
            string appId = (session.SourceAppUserModelId ?? string.Empty).Trim();
            return string.IsNullOrWhiteSpace(appId)
                ? $"anonymous:{System.Runtime.CompilerServices.RuntimeHelpers.GetHashCode(session)}"
                : appId;
        }

        private void ReconcileSessionIds(IReadOnlyList<GlobalSystemMediaTransportControlsSession> sessions)
        {
            var live = new HashSet<string>(sessions.Select(GetRuntimeSessionKey), StringComparer.OrdinalIgnoreCase);
            foreach (var stale in _sessionIds.Keys.Where(key => !live.Contains(key)).ToList())
                _sessionIds.Remove(stale);
        }

        private void SelectCurrentSession()
        {
            if (_manager == null) return;
            var sessions = _manager.GetSessions();
            ReconcileSessionIds(sessions);

            GlobalSystemMediaTransportControlsSession? next = null;
            if (!string.IsNullOrWhiteSpace(_forcedSessionId))
                next = sessions.FirstOrDefault(session => GetSessionId(session) == _forcedSessionId);

            if (next == null)
            {
                _forcedSessionId = null;
                foreach (var session in sessions)
                {
                    try
                    {
                        if (session.GetPlaybackInfo()?.PlaybackStatus
                            == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                        {
                            next = session;
                            break;
                        }
                    }
                    catch { }
                }
                next ??= _manager.GetCurrentSession();
                next ??= sessions.FirstOrDefault();
            }

            SetCurrentSession(next);
        }

        private void SetCurrentSession(GlobalSystemMediaTransportControlsSession? next)
        {
            if (ReferenceEquals(_currentSession, next)) return;

            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged -= CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged -= CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged -= CurrentSession_TimelinePropertiesChanged;
            }

            _currentSession = next;
            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged += CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged += CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged += CurrentSession_TimelinePropertiesChanged;
            }
        }

        private void CurrentSession_MediaPropertiesChanged(
            GlobalSystemMediaTransportControlsSession sender,
            MediaPropertiesChangedEventArgs args) => _ = RefreshAsync();

        private void CurrentSession_PlaybackInfoChanged(
            GlobalSystemMediaTransportControlsSession sender,
            PlaybackInfoChangedEventArgs args) => _ = RefreshAsync();

        private void CurrentSession_TimelinePropertiesChanged(
            GlobalSystemMediaTransportControlsSession sender,
            TimelinePropertiesChangedEventArgs args) => _ = RefreshAsync();

        public async Task RefreshAsync(bool forceWait = false)
        {
            bool entered = forceWait
                ? await _refreshGate.WaitAsync(TimeSpan.FromSeconds(2))
                : await _refreshGate.WaitAsync(0);
            if (!entered) return;

            try
            {
                SelectCurrentSession();
                await RefreshStateAsync();
            }
            catch (Exception ex)
            {
                EmitError($"SMTC session refresh failed: {ex.Message}");
            }
            finally
            {
                _refreshGate.Release();
            }
        }

        private async Task<IReadOnlyList<MediaSessionSummary>> BuildSessionSummariesAsync()
        {
            if (_manager == null) return Array.Empty<MediaSessionSummary>();
            var result = new List<MediaSessionSummary>();

            foreach (var session in _manager.GetSessions())
            {
                var summary = new MediaSessionSummary
                {
                    SessionId = GetSessionId(session),
                    SourceApp = DetermineSourceAppName(session.SourceAppUserModelId ?? string.Empty)
                };
                try
                {
                    var info = session.GetPlaybackInfo();
                    summary.IsPlaying = info?.PlaybackStatus
                        == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                    var properties = await session.TryGetMediaPropertiesAsync();
                    summary.Title = properties?.Title ?? string.Empty;
                    summary.Artist = properties?.Artist ?? string.Empty;
                }
                catch { }
                result.Add(summary);
            }

            return result;
        }

        private async Task RefreshStateAsync()
        {
            var state = new MediaSessionState
            {
                Sessions = await BuildSessionSummariesAsync()
            };

            if (_currentSession == null)
            {
                CurrentSessionState = state;
                SessionStateChanged?.Invoke(this, state);
                return;
            }

            try
            {
                state.HasSession = true;
                state.SessionId = GetSessionId(_currentSession);
                state.SourceApp = DetermineSourceAppName(_currentSession.SourceAppUserModelId ?? string.Empty);

                var mediaProps = await _currentSession.TryGetMediaPropertiesAsync();
                if (mediaProps != null)
                {
                    state.Title = mediaProps.Title ?? string.Empty;
                    state.Artist = mediaProps.Artist ?? string.Empty;
                    state.Album = mediaProps.AlbumTitle ?? string.Empty;
                    NormalizeBrowserMetadata(state);
                    state.AlbumArt = await ReadAlbumArtAsync(mediaProps.Thumbnail, state);
                }

                var playbackInfo = _currentSession.GetPlaybackInfo();
                if (playbackInfo != null)
                {
                    state.IsPlaying = playbackInfo.PlaybackStatus
                        == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                    state.ShuffleActive = playbackInfo.IsShuffleActive ?? false;
                    state.RepeatMode = NormalizeRepeatMode(playbackInfo.AutoRepeatMode);
                    var controls = playbackInfo.Controls;
                    if (controls != null)
                    {
                        state.CanSkipPrevious = controls.IsPreviousEnabled;
                        state.CanPlayPause = controls.IsPlayEnabled || controls.IsPauseEnabled;
                        state.CanSkipNext = controls.IsNextEnabled;
                        state.CanSeek = controls.IsPlaybackPositionEnabled;
                        state.CanShuffle = controls.IsShuffleEnabled;
                        state.CanRepeat = controls.IsRepeatEnabled;
                    }
                }

                var timeline = _currentSession.GetTimelineProperties();
                if (timeline != null)
                {
                    state.PositionSeconds = timeline.Position.TotalSeconds;
                    state.DurationSeconds = Math.Max(0, (timeline.EndTime - timeline.StartTime).TotalSeconds);
                }
            }
            catch (Exception ex)
            {
                EmitError($"SMTC refresh error: {ex.Message}");
            }

            CurrentSessionState = state;
            SessionStateChanged?.Invoke(this, state);
        }

        private static void NormalizeBrowserMetadata(MediaSessionState state)
        {
            if (string.IsNullOrWhiteSpace(state.Artist) && state.Title.Contains(" - "))
            {
                var parts = state.Title.Split(new[] { " - " }, 2, StringSplitOptions.RemoveEmptyEntries);
                if (parts.Length == 2)
                {
                    state.Title = parts[0].Trim();
                    state.Artist = parts[1].Trim();
                }
            }
            if (string.IsNullOrWhiteSpace(state.Artist)) state.Artist = state.SourceApp;
        }

        private async Task<BitmapImage?> ReadAlbumArtAsync(
            IRandomAccessStreamReference? thumbnail,
            MediaSessionState state)
        {
            if (thumbnail == null)
            {
                _albumArtKey = string.Empty;
                _cachedAlbumArt = null;
                return null;
            }

            string key = $"{state.SourceApp}\n{state.Title}\n{state.Artist}\n{state.Album}";
            if (key == _albumArtKey) return _cachedAlbumArt;

            try
            {
                using IRandomAccessStreamWithContentType stream = await thumbnail.OpenReadAsync();
                using Stream netStream = stream.AsStreamForRead();
                using MemoryStream memory = new MemoryStream();
                await netStream.CopyToAsync(memory);
                memory.Position = 0;

                var bitmap = new BitmapImage();
                bitmap.BeginInit();
                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                bitmap.StreamSource = memory;
                bitmap.EndInit();
                bitmap.Freeze();
                _albumArtKey = key;
                _cachedAlbumArt = bitmap;
                return bitmap;
            }
            catch
            {
                return null;
            }
        }

        private static string NormalizeRepeatMode(MediaPlaybackAutoRepeatMode? mode) => mode switch
        {
            MediaPlaybackAutoRepeatMode.List => "list",
            MediaPlaybackAutoRepeatMode.Track => "track",
            _ => "none"
        };

        private static string DetermineSourceAppName(string appId)
        {
            if (string.IsNullOrWhiteSpace(appId)) return "Media Player";
            string lower = appId.ToLowerInvariant();
            if (lower.Contains("spotify")) return "Spotify";
            if (lower.Contains("youtubemusic") || lower.Contains("youtube music")) return "YouTube Music";
            if (lower.Contains("youtube")) return "YouTube";
            if (lower.Contains("chrome")) return "YouTube / Chrome";
            if (lower.Contains("msedge") || lower.Contains("edge")) return "YouTube / Edge";
            if (lower.Contains("firefox")) return "YouTube / Firefox";
            if (lower.Contains("brave")) return "YouTube / Brave";
            if (lower.Contains("opera")) return "YouTube / Opera";
            if (lower.Contains("vlc")) return "VLC";
            return "Media Player";
        }

        public async Task SkipPreviousAsync()
        {
            if (_currentSession != null) await _currentSession.TrySkipPreviousAsync();
        }

        public async Task TogglePlayPauseAsync()
        {
            if (_currentSession != null) await _currentSession.TryTogglePlayPauseAsync();
        }

        public async Task SkipNextAsync()
        {
            if (_currentSession != null) await _currentSession.TrySkipNextAsync();
        }

        public async Task SeekToAsync(double seconds)
        {
            if (_currentSession == null || !CurrentSessionState.CanSeek) return;
            long ticks = (long)(Math.Max(0, seconds) * TimeSpan.TicksPerSecond);
            await _currentSession.TryChangePlaybackPositionAsync(ticks);
        }

        public async Task ToggleShuffleAsync()
        {
            if (_currentSession == null || !CurrentSessionState.CanShuffle) return;
            await _currentSession.TryChangeShuffleActiveAsync(!CurrentSessionState.ShuffleActive);
            await RefreshAsync(forceWait: true);
        }

        public async Task CycleRepeatAsync()
        {
            if (_currentSession == null || !CurrentSessionState.CanRepeat) return;
            MediaPlaybackAutoRepeatMode next = CurrentSessionState.RepeatMode switch
            {
                "none" => MediaPlaybackAutoRepeatMode.List,
                "list" => MediaPlaybackAutoRepeatMode.Track,
                _ => MediaPlaybackAutoRepeatMode.None
            };
            await _currentSession.TryChangeAutoRepeatModeAsync(next);
            await RefreshAsync(forceWait: true);
        }

        public void BringAppToFront()
        {
            if (_currentSession == null) return;
            string appId = (_currentSession.SourceAppUserModelId ?? string.Empty).ToLowerInvariant();
            string targetProcess = "Spotify";
            if (appId.Contains("chrome")) targetProcess = "chrome";
            else if (appId.Contains("msedge") || appId.Contains("edge")) targetProcess = "msedge";
            else if (appId.Contains("firefox")) targetProcess = "firefox";
            else if (appId.Contains("brave")) targetProcess = "brave";
            else if (appId.Contains("opera")) targetProcess = "opera";
            else if (appId.Contains("vlc")) targetProcess = "vlc";

            try
            {
                foreach (var process in System.Diagnostics.Process.GetProcessesByName(targetProcess))
                {
                    if (process.MainWindowHandle == IntPtr.Zero) continue;
                    NativeMethods.ShowWindow(process.MainWindowHandle, NativeMethods.SW_RESTORE);
                    NativeMethods.SetForegroundWindow(process.MainWindowHandle);
                    break;
                }
            }
            catch { }
        }

        private static void EmitError(string message)
        {
            Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { @event = "error", message }));
        }
    }
}
