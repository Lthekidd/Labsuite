using System;
using System.IO;
using System.Linq;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Media.Imaging;
using Windows.Media.Control;
using Windows.Storage.Streams;

namespace LabMediaWidget
{
    public class MediaSessionState
    {
        public bool HasSession { get; set; }
        public string Title { get; set; } = string.Empty;
        public string Artist { get; set; } = string.Empty;
        public string Album { get; set; } = string.Empty;
        public string SourceApp { get; set; } = string.Empty;
        public bool IsPlaying { get; set; }
        public double PositionSeconds { get; set; }
        public double DurationSeconds { get; set; }
        public BitmapImage? AlbumArt { get; set; }
        public bool CanSkipPrevious { get; set; } = true;
        public bool CanPlayPause { get; set; } = true;
        public bool CanSkipNext { get; set; } = true;
        public int SessionCount { get; set; } = 1;
    }

    public class SmtcManager
    {
        private GlobalSystemMediaTransportControlsSessionManager? _manager;
        private GlobalSystemMediaTransportControlsSession? _currentSession;
        private readonly SemaphoreSlim _refreshGate = new SemaphoreSlim(1, 1);
        private string _albumArtKey = string.Empty;
        private BitmapImage? _cachedAlbumArt;
        private int _forcedSessionIndex = -1;

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
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { @event = "error", message = $"SMTC init failed: {ex.Message}" }));
            }
        }

        public async Task CycleNextSessionAsync()
        {
            if (_manager == null) return;
            var sessions = _manager.GetSessions();
            if (sessions == null || sessions.Count <= 1) return;

            if (_forcedSessionIndex < 0) _forcedSessionIndex = 0;
            _forcedSessionIndex = (_forcedSessionIndex + 1) % sessions.Count;

            var nextSession = sessions[_forcedSessionIndex];

            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged -= CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged -= CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged -= CurrentSession_TimelinePropertiesChanged;
            }

            _currentSession = nextSession;

            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged += CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged += CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged += CurrentSession_TimelinePropertiesChanged;
            }

            await RefreshStateAsync();
        }

        private void Manager_SessionsChanged(GlobalSystemMediaTransportControlsSessionManager sender, SessionsChangedEventArgs args)
        {
            _ = RefreshAsync();
        }

        private void SelectCurrentSession()
        {
            if (_manager == null) return;

            var sessions = _manager.GetSessions();
            if (_forcedSessionIndex >= 0 && sessions != null && _forcedSessionIndex < sessions.Count)
            {
                _currentSession = sessions[_forcedSessionIndex];
                return;
            }

            GlobalSystemMediaTransportControlsSession? nextSession = null;
            if (sessions != null)
            {
                foreach (var session in sessions)
                {
                    try
                    {
                        if (session.GetPlaybackInfo()?.PlaybackStatus
                            == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing)
                        {
                            nextSession = session;
                            break;
                        }
                    }
                    catch { }
                }

                nextSession ??= _manager.GetCurrentSession();
                nextSession ??= sessions.FirstOrDefault();
            }

            if (ReferenceEquals(_currentSession, nextSession)) return;

            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged -= CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged -= CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged -= CurrentSession_TimelinePropertiesChanged;
            }

            _currentSession = nextSession;

            if (_currentSession != null)
            {
                _currentSession.MediaPropertiesChanged += CurrentSession_MediaPropertiesChanged;
                _currentSession.PlaybackInfoChanged += CurrentSession_PlaybackInfoChanged;
                _currentSession.TimelinePropertiesChanged += CurrentSession_TimelinePropertiesChanged;
            }
        }

        private void CurrentSession_MediaPropertiesChanged(GlobalSystemMediaTransportControlsSession sender, MediaPropertiesChangedEventArgs args)
        {
            _ = RefreshAsync();
        }

        private void CurrentSession_PlaybackInfoChanged(GlobalSystemMediaTransportControlsSession sender, PlaybackInfoChangedEventArgs args)
        {
            _ = RefreshAsync();
        }

        private void CurrentSession_TimelinePropertiesChanged(GlobalSystemMediaTransportControlsSession sender, TimelinePropertiesChangedEventArgs args)
        {
            _ = RefreshAsync();
        }

        public async Task RefreshAsync()
        {
            if (!await _refreshGate.WaitAsync(0)) return;

            try
            {
                SelectCurrentSession();
                await RefreshStateAsync();
            }
            catch (Exception ex)
            {
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new
                {
                    @event = "error",
                    message = $"SMTC session refresh failed: {ex.Message}"
                }));
            }
            finally
            {
                _refreshGate.Release();
            }
        }

        private async Task RefreshStateAsync()
        {
            var state = new MediaSessionState();

            if (_currentSession == null)
            {
                state.HasSession = false;
                CurrentSessionState = state;
                SessionStateChanged?.Invoke(this, state);
                return;
            }

            try
            {
                state.HasSession = true;
                try { state.SessionCount = _manager?.GetSessions()?.Count ?? 1; } catch { state.SessionCount = 1; }
                string appId = _currentSession.SourceAppUserModelId ?? "";
                state.SourceApp = DetermineSourceAppName(appId);

                var mediaProps = await _currentSession.TryGetMediaPropertiesAsync();
                if (mediaProps != null)
                {
                    state.Title = mediaProps.Title ?? "";
                    state.Artist = mediaProps.Artist ?? "";
                    state.Album = mediaProps.AlbumTitle ?? "";

                    // For YouTube / browser sessions where Title contains " - " and Artist is empty or generic
                    if (string.IsNullOrWhiteSpace(state.Artist) && state.Title.Contains(" - "))
                    {
                        var parts = state.Title.Split(new[] { " - " }, 2, StringSplitOptions.RemoveEmptyEntries);
                        if (parts.Length == 2)
                        {
                            state.Title = parts[0].Trim();
                            state.Artist = parts[1].Trim();
                        }
                    }

                    if (string.IsNullOrWhiteSpace(state.Artist))
                    {
                        state.Artist = state.SourceApp;
                    }

                    if (mediaProps.Thumbnail != null)
                    {
                        string albumArtKey = $"{state.SourceApp}\n{state.Title}\n{state.Artist}\n{state.Album}";
                        if (albumArtKey == _albumArtKey)
                        {
                            state.AlbumArt = _cachedAlbumArt;
                        }
                        else
                        {
                            try
                            {
                                IRandomAccessStreamWithContentType stream = await mediaProps.Thumbnail.OpenReadAsync();
                                using Stream netStream = stream.AsStreamForRead();
                                using MemoryStream memStream = new MemoryStream();
                                await netStream.CopyToAsync(memStream);
                                memStream.Position = 0;

                                BitmapImage bitmap = new BitmapImage();
                                bitmap.BeginInit();
                                bitmap.CacheOption = BitmapCacheOption.OnLoad;
                                bitmap.StreamSource = memStream;
                                bitmap.EndInit();
                                bitmap.Freeze();
                                _albumArtKey = albumArtKey;
                                _cachedAlbumArt = bitmap;
                                state.AlbumArt = bitmap;
                            }
                            catch { }
                        }
                    }
                    else
                    {
                        _albumArtKey = string.Empty;
                        _cachedAlbumArt = null;
                    }
                }

                var playbackInfo = _currentSession.GetPlaybackInfo();
                if (playbackInfo != null)
                {
                    state.IsPlaying = playbackInfo.PlaybackStatus == GlobalSystemMediaTransportControlsSessionPlaybackStatus.Playing;
                    var controls = playbackInfo.Controls;
                    if (controls != null)
                    {
                        state.CanSkipPrevious = controls.IsPreviousEnabled;
                        state.CanPlayPause = controls.IsPlayEnabled || controls.IsPauseEnabled;
                        state.CanSkipNext = controls.IsNextEnabled;
                    }
                }

                var timelineProps = _currentSession.GetTimelineProperties();
                if (timelineProps != null)
                {
                    state.PositionSeconds = timelineProps.Position.TotalSeconds;
                    state.DurationSeconds = (timelineProps.EndTime - timelineProps.StartTime).TotalSeconds;
                    if (state.DurationSeconds < 0) state.DurationSeconds = 0;
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine(System.Text.Json.JsonSerializer.Serialize(new { @event = "error", message = $"SMTC refresh error: {ex.Message}" }));
            }

            SessionStateChanged?.Invoke(this, state);
        }

        private string DetermineSourceAppName(string appId)
        {
            if (string.IsNullOrWhiteSpace(appId)) return "Media Player";
            string lower = appId.ToLower();

            if (lower.Contains("spotify")) return "Spotify";
            if (lower.Contains("youtubemusic") || lower.Contains("youtube music")) return "YouTube Music";
            if (lower.Contains("youtube")) return "YouTube";
            if (lower.Contains("chrome")) return "YouTube / Browser";
            if (lower.Contains("msedge") || lower.Contains("edge")) return "YouTube / Edge";
            if (lower.Contains("firefox")) return "YouTube / Firefox";
            if (lower.Contains("brave")) return "YouTube / Brave";
            if (lower.Contains("opera")) return "YouTube / Opera";

            return "Media Player";
        }

        public async Task SkipPreviousAsync()
        {
            if (_currentSession != null)
            {
                await _currentSession.TrySkipPreviousAsync();
            }
        }

        public async Task TogglePlayPauseAsync()
        {
            if (_currentSession != null)
            {
                await _currentSession.TryTogglePlayPauseAsync();
            }
        }

        public async Task SkipNextAsync()
        {
            if (_currentSession != null)
            {
                await _currentSession.TrySkipNextAsync();
            }
        }

        public async Task SeekToAsync(double seconds)
        {
            if (_currentSession != null)
            {
                long ticks = (long)(seconds * TimeSpan.TicksPerSecond);
                await _currentSession.TryChangePlaybackPositionAsync(ticks);
            }
        }

        public void BringAppToFront()
        {
            if (_currentSession == null) return;
            string appId = (_currentSession.SourceAppUserModelId ?? "").ToLower();

            string targetProc = "Spotify";
            if (appId.Contains("chrome")) targetProc = "chrome";
            else if (appId.Contains("msedge") || appId.Contains("edge")) targetProc = "msedge";
            else if (appId.Contains("firefox")) targetProc = "firefox";
            else if (appId.Contains("brave")) targetProc = "brave";
            else if (appId.Contains("opera")) targetProc = "opera";
            else if (appId.Contains("spotify")) targetProc = "Spotify";

            try
            {
                var processes = System.Diagnostics.Process.GetProcessesByName(targetProc);
                foreach (var proc in processes)
                {
                    if (proc.MainWindowHandle != IntPtr.Zero)
                    {
                        NativeMethods.ShowWindow(proc.MainWindowHandle, NativeMethods.SW_RESTORE);
                        NativeMethods.SetForegroundWindow(proc.MainWindowHandle);
                        break;
                    }
                }
            }
            catch { }
        }

        public void BringSpotifyToFront()
        {
            BringAppToFront();
        }
    }
}
