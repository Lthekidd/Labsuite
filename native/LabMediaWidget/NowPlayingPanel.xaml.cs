using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using System.Windows.Threading;

namespace LabMediaWidget
{
    public partial class NowPlayingPanel : Window
    {
        private readonly SmtcManager _smtc;
        private readonly DispatcherTimer _volumeCommitTimer;
        private MediaSessionState _state = new MediaSessionState();
        private QueueState _queueState = QueueState.Unavailable();
        private YouTubeLibraryState _libraryState = YouTubeLibraryState.RequiresSetup();
        private TaskbarInfo _anchor;
        private bool _updatingSession;
        private bool _updatingVolume;
        private bool _opening;
        private int _thumbnailGeneration;
        private CancellationTokenSource _thumbnailCancellation = new CancellationTokenSource();
        private readonly Dictionary<string, ImageSource> _thumbnailCache = new Dictionary<string, ImageSource>();
        private static readonly SemaphoreSlim ThumbnailConcurrency = new SemaphoreSlim(4);
        private static readonly HttpClient ThumbnailClient = CreateThumbnailClient();

        public DateTime LastDeactivatedUtc { get; private set; } = DateTime.MinValue;

        public Action? OpenSettingsRequested { get; set; }
        public Action<string>? ProviderActionRequested { get; set; }
        public Action<string, string?, string?>? LibraryActionRequested { get; set; }

        public NowPlayingPanel(SmtcManager smtc)
        {
            InitializeComponent();
            _smtc = smtc;
            _volumeCommitTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
            _volumeCommitTimer.Tick += VolumeCommitTimer_Tick;
            UpdateLibraryState(_libraryState);
        }

        public void UpdateState(MediaSessionState state)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => UpdateState(state));
                return;
            }

            string previousSource = _state.SourceApp;
            _state = state;
            TxtSource.Text = string.IsNullOrWhiteSpace(state.SourceApp) ? "Media Player" : state.SourceApp;
            TxtTitle.Text = state.HasSession && !string.IsNullOrWhiteSpace(state.Title) ? state.Title : "No media playing";
            TxtArtist.Text = state.HasSession && !string.IsNullOrWhiteSpace(state.Artist)
                ? state.Artist
                : "Start playback in a supported app";
            TxtAlbum.Text = state.Album ?? string.Empty;
            TxtAlbum.Visibility = string.IsNullOrWhiteSpace(state.Album) ? Visibility.Collapsed : Visibility.Visible;
            ImgArtwork.Source = state.AlbumArt;
            FallbackArtwork.Visibility = state.AlbumArt == null ? Visibility.Visible : Visibility.Collapsed;

            TimelineSlider.Maximum = Math.Max(1, state.DurationSeconds);
            TimelineSlider.Value = Math.Clamp(state.PositionSeconds, 0, TimelineSlider.Maximum);
            TimelineSlider.IsEnabled = state.CanSeek && state.DurationSeconds > 0;
            TxtElapsed.Text = FormatTime(state.PositionSeconds);
            TxtDuration.Text = FormatTime(state.DurationSeconds);

            PathPlayPause.Data = Geometry.Parse(state.IsPlaying
                ? "M 6,5 H 10 V 19 H 6 Z M 14,5 H 18 V 19 H 14 Z"
                : "M 7,5 L 18,12 L 7,19 Z");
            BtnPrevious.IsEnabled = state.CanSkipPrevious;
            BtnPlayPause.IsEnabled = state.CanPlayPause;
            BtnNext.IsEnabled = state.CanSkipNext;
            BtnShuffle.IsEnabled = state.CanShuffle;
            BtnRepeat.IsEnabled = state.CanRepeat;
            BtnShuffle.Background = state.ShuffleActive ? AccentBrush() : NeutralBrush();
            BtnRepeat.Background = state.RepeatMode != "none" ? AccentBrush() : NeutralBrush();
            TxtRepeat.Text = state.RepeatMode == "track" ? "Repeat 1" : "Repeat";

            _updatingSession = true;
            SessionPicker.ItemsSource = state.Sessions.ToList();
            SessionPicker.SelectedValue = state.SessionId;
            SessionPicker.Visibility = state.Sessions.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
            _updatingSession = false;

            if (IsVisible && !string.Equals(previousSource, state.SourceApp, StringComparison.Ordinal))
                RefreshVolume();
        }

        public void UpdateQueueState(QueueState? queue)
        {
            _queueState = queue ?? QueueState.Unavailable(_state.SourceApp);
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => UpdateQueueState(_queueState));
                return;
            }

            TxtQueueAttribution.Text = _queueState.Attribution ?? string.Empty;
            bool hasItems = _queueState.Status == QueueStatuses.Ready && _queueState.Items.Count > 0;
            QueueItemsScroll.Visibility = hasItems ? Visibility.Visible : Visibility.Collapsed;
            QueueStatusBorder.Visibility = hasItems ? Visibility.Collapsed : Visibility.Visible;
            QueueItems.ItemsSource = _queueState.Items;
            TxtQueueStatus.Text = QueueMessage(_queueState);

            BtnQueueAction.Visibility = Visibility.Collapsed;
            if (_queueState.Status == QueueStatuses.RequiresAuth)
            {
                BtnQueueAction.Content = "Connect Spotify";
                BtnQueueAction.Tag = "connectSpotify";
                BtnQueueAction.Visibility = Visibility.Visible;
            }
            else if (_queueState.Status == QueueStatuses.Error)
            {
                BtnQueueAction.Content = "Retry";
                BtnQueueAction.Tag = "refreshQueue";
                BtnQueueAction.Visibility = Visibility.Visible;
            }
        }

        public void UpdateLibraryState(YouTubeLibraryState? state)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => UpdateLibraryState(state));
                return;
            }

            _libraryState = state ?? YouTubeLibraryState.RequiresSetup();
            LibraryConnectionState connection = _libraryState.Connection ?? new LibraryConnectionState();
            LibraryContentState library = _libraryState.Library ?? new LibraryContentState();
            bool connected = connection.Status == LibraryConnectionStatuses.Connected;
            bool selected = library.SelectedPlaylist != null;
            bool hasContent = selected ? library.Items.Count > 0 : library.Playlists.Count > 0;

            TxtLibraryTitle.Text = selected ? library.SelectedPlaylist!.Title : "YouTube Library";
            TxtLibraryAccount.Text = string.Join(" · ", new[] { connection.ChannelTitle, connection.Email }
                .Where(value => !string.IsNullOrWhiteSpace(value)));
            BtnLibraryBack.Visibility = selected ? Visibility.Visible : Visibility.Collapsed;
            BtnLibraryRefresh.IsEnabled = connected && library.Status != LibraryStatuses.Loading;
            BtnLibraryDisconnect.Visibility = connected || !string.IsNullOrWhiteSpace(connection.Email)
                ? Visibility.Visible : Visibility.Collapsed;
            BtnLibraryOpenPlaylist.Visibility = selected ? Visibility.Visible : Visibility.Collapsed;
            BtnLibraryLoadMore.Visibility = connected && library.HasMore ? Visibility.Visible : Visibility.Collapsed;
            BtnLibraryLoadMore.IsEnabled = library.Status != LibraryStatuses.Loading;

            LibraryPlaylists.ItemsSource = library.Playlists;
            LibraryTracks.ItemsSource = library.Items;
            LibraryPlaylists.Visibility = !selected ? Visibility.Visible : Visibility.Collapsed;
            LibraryTracks.Visibility = selected ? Visibility.Visible : Visibility.Collapsed;
            LibraryScroll.Visibility = connected && hasContent ? Visibility.Visible : Visibility.Collapsed;

            string message = LibraryMessage(connection, library);
            bool showStatus = !connected || library.Status != LibraryStatuses.Ready || !string.IsNullOrWhiteSpace(message);
            LibraryStatusBorder.Visibility = showStatus ? Visibility.Visible : Visibility.Collapsed;
            TxtLibraryStatus.Text = message;

            BtnLibraryConnect.Visibility = Visibility.Collapsed;
            if (connection.Status == LibraryConnectionStatuses.RequiresSetup)
            {
                BtnLibraryConnect.Content = "Open OAuth setup";
                BtnLibraryConnect.Tag = "openOAuthSettings";
                BtnLibraryConnect.Visibility = Visibility.Visible;
            }
            else if (connection.Status == LibraryConnectionStatuses.RequiresAuth)
            {
                BtnLibraryConnect.Content = "Connect YouTube";
                BtnLibraryConnect.Tag = "connect";
                BtnLibraryConnect.Visibility = Visibility.Visible;
            }
            else if (connection.Status == LibraryConnectionStatuses.ReauthRequired
                || connection.Status == LibraryConnectionStatuses.Error)
            {
                BtnLibraryConnect.Content = "Reconnect";
                BtnLibraryConnect.Tag = "reconnect";
                BtnLibraryConnect.Visibility = Visibility.Visible;
            }

            _thumbnailCancellation.Cancel();
            _thumbnailCancellation.Dispose();
            _thumbnailCancellation = new CancellationTokenSource();
            if (!connected && library.Playlists.Count == 0) _thumbnailCache.Clear();
            int generation = ++_thumbnailGeneration;
            ApplyCachedThumbnails(library);
            _ = LoadLibraryThumbnailsAsync(library, generation, _thumbnailCancellation.Token);
        }

        public void ApplyTheme(Brush background, Brush border, Brush accent)
        {
            if (SystemParameters.HighContrast)
            {
                PanelBorder.Background = SystemColors.WindowBrush;
                PanelBorder.BorderBrush = SystemColors.WindowTextBrush;
                BtnPlayPause.Background = SystemColors.HighlightBrush;
                BtnPlayPause.BorderBrush = SystemColors.HighlightBrush;
                BtnPlayPause.Foreground = SystemColors.HighlightTextBrush;
                FallbackArtwork.Fill = SystemColors.HighlightBrush;
                SourceBadge.Background = SystemColors.HighlightBrush;
                TxtSource.Foreground = SystemColors.HighlightTextBrush;
                foreach (TextBlock text in FindVisualChildren<TextBlock>(PanelBorder))
                    text.Foreground = SystemColors.WindowTextBrush;
                TxtSource.Foreground = SystemColors.HighlightTextBrush;
                return;
            }

            PanelBorder.Background = background;
            PanelBorder.BorderBrush = border;
            BtnPlayPause.Background = accent;
            BtnPlayPause.BorderBrush = accent;
            FallbackArtwork.Fill = accent;
            SourceBadge.Background = WithOpacity(accent, 0.16);
            TxtSource.Foreground = accent;
            Brush primaryText = new SolidColorBrush(Color.FromRgb(0xE5, 0xE7, 0xEB));
            Brush secondaryText = new SolidColorBrush(Color.FromRgb(0xA7, 0xB0, 0xBC));
            Brush mutedText = new SolidColorBrush(Color.FromRgb(0x70, 0x7B, 0x88));
            foreach (TextBlock text in FindVisualChildren<TextBlock>(PanelBorder))
                text.Foreground = primaryText;
            TxtSource.Foreground = accent;
            TxtArtist.Foreground = secondaryText;
            TxtAlbum.Foreground = mutedText;
            TxtElapsed.Foreground = mutedText;
            TxtDuration.Foreground = mutedText;
            TxtVolume.Foreground = secondaryText;
            TxtQueueAttribution.Foreground = mutedText;
            TxtQueueStatus.Foreground = secondaryText;
            TxtLibraryAccount.Foreground = mutedText;
            TxtLibraryStatus.Foreground = secondaryText;
        }

        public void ShowAnchored(TaskbarInfo anchor)
        {
            _anchor = anchor;
            SelectNowPlayingTab(false);
            UpdateState(_smtc.CurrentSessionState);
            RefreshVolume();
            _opening = true;
            Opacity = 0;
            Left = -10000;
            Top = -10000;
            if (!IsVisible) Show();
            UpdateLayout();

            double desiredHeight = Math.Min(520, Math.Max(360, ActualHeight));
            var placement = TaskbarAnchor.CalculateFlyoutPosition(anchor, Width, desiredHeight);
            if (!placement.IsValid)
            {
                Hide();
                _opening = false;
                return;
            }

            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST,
                placement.X, placement.Y, placement.Width, placement.Height,
                NativeMethods.SWP_SHOWWINDOW);
            Opacity = 1;
            Activate();
            Focus();
            Dispatcher.BeginInvoke(() => _opening = false, DispatcherPriority.ApplicationIdle);
        }

        public void RepositionIfOpen(TaskbarInfo anchor)
        {
            if (!IsVisible) return;
            _anchor = anchor;
            var placement = TaskbarAnchor.CalculateFlyoutPosition(anchor, Width, Math.Min(520, ActualHeight));
            if (!placement.IsValid)
            {
                HideFlyout();
                return;
            }
            NativeMethods.SetWindowPos(new WindowInteropHelper(this).Handle, NativeMethods.HWND_TOPMOST,
                placement.X, placement.Y, placement.Width, placement.Height,
                NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);
        }

        public void HideFlyout()
        {
            _volumeCommitTimer.Stop();
            if (IsVisible) Hide();
        }

        private void RefreshVolume()
        {
            string source = VolumeProcessHint();
            _ = Task.Run(() =>
            {
                float level = AppVolume.GetMediaVolume(source);
                bool muted = AppVolume.GetMediaMute(source);
                Dispatcher.Invoke(() =>
                {
                    _updatingVolume = true;
                    VolumeSlider.Value = Math.Clamp(level * 100, 0, 100);
                    TxtVolume.Text = $"{Math.Round(VolumeSlider.Value):0}%";
                    TxtMuteIcon.Text = muted ? "MUTE" : "VOL";
                    _updatingVolume = false;
                });
            });
        }

        private async void SessionPicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_updatingSession || SessionPicker.SelectedValue is not string sessionId
                || sessionId == _state.SessionId) return;
            await _smtc.SelectSessionAsync(sessionId);
        }

        private async void TimelineSlider_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (!_state.CanSeek || _state.DurationSeconds <= 0 || TimelineSlider.ActualWidth <= 0) return;
            Point point = e.GetPosition(TimelineSlider);
            double target = Math.Clamp(point.X / TimelineSlider.ActualWidth * _state.DurationSeconds, 0, _state.DurationSeconds);
            TimelineSlider.Value = target;
            await _smtc.SeekToAsync(target);
            e.Handled = true;
        }

        private async void BtnPrevious_Click(object sender, RoutedEventArgs e) => await _smtc.SkipPreviousAsync();
        private async void BtnPlayPause_Click(object sender, RoutedEventArgs e) => await _smtc.TogglePlayPauseAsync();
        private async void BtnNext_Click(object sender, RoutedEventArgs e) => await _smtc.SkipNextAsync();
        private async void BtnShuffle_Click(object sender, RoutedEventArgs e) => await _smtc.ToggleShuffleAsync();
        private async void BtnRepeat_Click(object sender, RoutedEventArgs e) => await _smtc.CycleRepeatAsync();

        private void VolumeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
        {
            TxtVolume.Text = $"{Math.Round(VolumeSlider.Value):0}%";
            if (_updatingVolume || !IsVisible) return;
            _volumeCommitTimer.Stop();
            _volumeCommitTimer.Start();
        }

        private void VolumeCommitTimer_Tick(object? sender, EventArgs e)
        {
            _volumeCommitTimer.Stop();
            string source = VolumeProcessHint();
            float level = (float)(VolumeSlider.Value / 100.0);
            _ = Task.Run(() =>
            {
                AppVolume.SetMediaVolume(source, level);
                Dispatcher.Invoke(RefreshVolume);
            });
        }

        private void BtnMute_Click(object sender, RoutedEventArgs e)
        {
            string source = VolumeProcessHint();
            bool mute = TxtMuteIcon.Text != "MUTE";
            _ = Task.Run(() =>
            {
                AppVolume.SetMediaMute(source, mute);
                Dispatcher.Invoke(RefreshVolume);
            });
        }

        private void BtnOpenSource_Click(object sender, RoutedEventArgs e) => _smtc.BringAppToFront();

        private string VolumeProcessHint() => string.IsNullOrWhiteSpace(_state.SourceAppId)
            ? _state.SourceApp
            : _state.SourceAppId;

        private void MenuItem_Copy_Click(object sender, RoutedEventArgs e)
        {
            try { Clipboard.SetText($"{_state.Artist} - {_state.Title}".Trim(' ', '-')); } catch { }
        }

        private void BtnOverflow_Click(object sender, RoutedEventArgs e)
        {
            if (BtnOverflow.ContextMenu == null) return;
            BtnOverflow.ContextMenu.PlacementTarget = BtnOverflow;
            BtnOverflow.ContextMenu.IsOpen = true;
        }

        private void MenuItem_OpenSettings_Click(object sender, RoutedEventArgs e) => OpenSettingsRequested?.Invoke();

        private void BtnQueueAction_Click(object sender, RoutedEventArgs e)
        {
            if (BtnQueueAction.Tag is string action) ProviderActionRequested?.Invoke(action);
        }

        private void BtnNowPlayingTab_Click(object sender, RoutedEventArgs e) => SelectNowPlayingTab(false);

        private void BtnLibraryTab_Click(object sender, RoutedEventArgs e)
        {
            NowPlayingContent.Visibility = Visibility.Collapsed;
            LibraryContent.Visibility = Visibility.Visible;
            BtnNowPlayingTab.Background = NeutralBrush();
            BtnLibraryTab.Background = WithOpacity(AccentBrush(), 0.24);
            LibraryActionRequested?.Invoke("openLibrary", null, null);
        }

        private void SelectNowPlayingTab(bool requestFocus)
        {
            NowPlayingContent.Visibility = Visibility.Visible;
            LibraryContent.Visibility = Visibility.Collapsed;
            BtnNowPlayingTab.Background = WithOpacity(AccentBrush(), 0.24);
            BtnLibraryTab.Background = NeutralBrush();
            if (requestFocus) BtnNowPlayingTab.Focus();
        }

        private void BtnLibraryConnect_Click(object sender, RoutedEventArgs e)
        {
            if (BtnLibraryConnect.Tag is string action) LibraryActionRequested?.Invoke(action, null, null);
        }

        private void BtnLibraryRefresh_Click(object sender, RoutedEventArgs e) =>
            LibraryActionRequested?.Invoke("refresh", null, null);

        private void BtnLibraryDisconnect_Click(object sender, RoutedEventArgs e) =>
            LibraryActionRequested?.Invoke("disconnect", null, null);

        private void BtnLibraryBack_Click(object sender, RoutedEventArgs e) =>
            LibraryActionRequested?.Invoke("backToPlaylists", null, null);

        private void BtnLibraryLoadMore_Click(object sender, RoutedEventArgs e) =>
            LibraryActionRequested?.Invoke("loadMore", null, null);

        private void BtnLibraryOpenPlaylist_Click(object sender, RoutedEventArgs e)
        {
            string? playlistId = _libraryState.Library.SelectedPlaylist?.Id;
            if (!string.IsNullOrWhiteSpace(playlistId))
            {
                LibraryActionRequested?.Invoke("openPlaylist", playlistId, null);
                SelectNowPlayingTab(false);
            }
        }

        private void LibraryPlaylist_Click(object sender, RoutedEventArgs e)
        {
            if (sender is Button button && button.Tag is string playlistId)
                LibraryActionRequested?.Invoke("selectPlaylist", playlistId, null);
        }

        private void LibraryPlaylistOpen_Click(object sender, RoutedEventArgs e)
        {
            if (sender is Button button && button.Tag is string playlistId)
            {
                LibraryActionRequested?.Invoke("openPlaylist", playlistId, null);
                SelectNowPlayingTab(false);
            }
        }

        private void LibraryTrack_Click(object sender, RoutedEventArgs e)
        {
            if (sender is not Button button || button.Tag is not string videoId) return;
            string? playlistId = _libraryState.Library.SelectedPlaylist?.Id;
            if (!string.IsNullOrWhiteSpace(playlistId))
            {
                LibraryActionRequested?.Invoke("openTrack", playlistId, videoId);
                SelectNowPlayingTab(false);
            }
        }

        private void Window_Deactivated(object? sender, EventArgs e)
        {
            if (_opening) return;
            LastDeactivatedUtc = DateTime.UtcNow;
            HideFlyout();
        }

        private void Window_PreviewKeyDown(object sender, KeyEventArgs e)
        {
            if (e.Key != Key.Escape) return;
            HideFlyout();
            e.Handled = true;
        }

        private static string FormatTime(double seconds)
        {
            if (!double.IsFinite(seconds) || seconds <= 0) return "0:00";
            var value = TimeSpan.FromSeconds(seconds);
            return value.TotalHours >= 1 ? value.ToString(@"h\:mm\:ss") : value.ToString(@"m\:ss");
        }

        private static string QueueMessage(QueueState state) => state.Status switch
        {
            QueueStatuses.Loading => "Loading Up Next…",
            QueueStatuses.Empty => "The provider queue is currently empty.",
            QueueStatuses.RequiresAuth => string.IsNullOrWhiteSpace(state.Message) ? "Connect Spotify to show its queue." : state.Message,
            QueueStatuses.Error => string.IsNullOrWhiteSpace(state.Message) ? "Up Next could not be loaded." : state.Message,
            _ => string.IsNullOrWhiteSpace(state.Message) ? "Up Next is not shared by this player." : state.Message
        };

        private static string LibraryMessage(LibraryConnectionState connection, LibraryContentState library)
        {
            if (connection.Status != LibraryConnectionStatuses.Connected)
                return string.IsNullOrWhiteSpace(connection.Message) ? "Connect YouTube to browse playlists." : connection.Message;
            return library.Status switch
            {
                LibraryStatuses.Idle => "Open Library to load playlists.",
                LibraryStatuses.Loading => string.IsNullOrWhiteSpace(library.Message) ? "Loading YouTube Library…" : library.Message,
                LibraryStatuses.Empty => string.IsNullOrWhiteSpace(library.Message) ? "No playlists were found." : library.Message,
                LibraryStatuses.Offline => string.IsNullOrWhiteSpace(library.Message) ? "Offline." : library.Message,
                LibraryStatuses.QuotaExceeded => string.IsNullOrWhiteSpace(library.Message) ? "YouTube API quota is exhausted." : library.Message,
                LibraryStatuses.Error => string.IsNullOrWhiteSpace(library.Message) ? "YouTube Library could not be loaded." : library.Message,
                _ => library.Message ?? string.Empty
            };
        }

        private void ApplyCachedThumbnails(LibraryContentState library)
        {
            foreach (LibraryPlaylist playlist in library.Playlists)
                if (_thumbnailCache.TryGetValue(playlist.ThumbnailUrl ?? string.Empty, out ImageSource? image)) playlist.ThumbnailImage = image;
            foreach (LibraryItem item in library.Items)
                if (_thumbnailCache.TryGetValue(item.ThumbnailUrl ?? string.Empty, out ImageSource? image)) item.ThumbnailImage = image;
        }

        private async Task LoadLibraryThumbnailsAsync(LibraryContentState library, int generation, CancellationToken cancellation)
        {
            var targets = library.Playlists.Select(item => (item.ThumbnailUrl, Assign: (Action<ImageSource>)(image => item.ThumbnailImage = image)))
                .Concat(library.Items.Select(item => (item.ThumbnailUrl, Assign: (Action<ImageSource>)(image => item.ThumbnailImage = image))))
                .Where(target => IsSafeThumbnailUrl(target.ThumbnailUrl))
                .GroupBy(target => target.ThumbnailUrl, StringComparer.Ordinal)
                .Select(group => group.ToList())
                .ToList();

            foreach (var targetGroup in targets)
            {
                if (generation != _thumbnailGeneration || cancellation.IsCancellationRequested) return;
                string url = targetGroup[0].ThumbnailUrl;
                ImageSource? image = null;
                if (!_thumbnailCache.TryGetValue(url, out image))
                {
                    image = await DownloadThumbnailAsync(url, cancellation);
                    if (generation != _thumbnailGeneration || cancellation.IsCancellationRequested) return;
                    if (image != null)
                    {
                        if (_thumbnailCache.Count >= 256) _thumbnailCache.Clear();
                        _thumbnailCache[url] = image;
                    }
                }
                if (image == null || generation != _thumbnailGeneration) continue;
                foreach (var target in targetGroup) target.Assign(image);
            }

            if (generation == _thumbnailGeneration)
            {
                LibraryPlaylists.Items.Refresh();
                LibraryTracks.Items.Refresh();
            }
        }

        private static async Task<ImageSource?> DownloadThumbnailAsync(string url, CancellationToken cancellation)
        {
            bool entered = false;
            try
            {
                await ThumbnailConcurrency.WaitAsync(cancellation);
                entered = true;
                using HttpResponseMessage response = await ThumbnailClient.GetAsync(url, HttpCompletionOption.ResponseHeadersRead, cancellation);
                if (!response.IsSuccessStatusCode || response.Content.Headers.ContentLength > 4 * 1024 * 1024) return null;
                byte[] bytes = await response.Content.ReadAsByteArrayAsync(cancellation);
                if (bytes.Length == 0 || bytes.Length > 4 * 1024 * 1024) return null;
                using var stream = new MemoryStream(bytes, writable: false);
                var image = new BitmapImage();
                image.BeginInit();
                image.CacheOption = BitmapCacheOption.OnLoad;
                image.CreateOptions = BitmapCreateOptions.IgnoreColorProfile;
                image.StreamSource = stream;
                image.EndInit();
                image.Freeze();
                return image;
            }
            catch { return null; }
            finally { if (entered) ThumbnailConcurrency.Release(); }
        }

        private static HttpClient CreateThumbnailClient()
        {
            var client = new HttpClient { Timeout = TimeSpan.FromSeconds(10) };
            client.DefaultRequestHeaders.CacheControl = new CacheControlHeaderValue { NoCache = true, NoStore = true };
            client.DefaultRequestHeaders.UserAgent.ParseAdd("LabMedia/1.0");
            return client;
        }

        private static bool IsSafeThumbnailUrl(string? value) =>
            Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
            && uri.Scheme == Uri.UriSchemeHttps
            && value!.Length <= 2048;

        private Brush AccentBrush() => BtnPlayPause.Background;
        private static Brush NeutralBrush() => new SolidColorBrush(Color.FromArgb(0x14, 0xFF, 0xFF, 0xFF));

        private static Brush WithOpacity(Brush source, double opacity)
        {
            if (source is not SolidColorBrush solid) return NeutralBrush();
            Color color = solid.Color;
            color.A = (byte)Math.Clamp((int)Math.Round(opacity * 255), 0, 255);
            return new SolidColorBrush(color);
        }

        private static System.Collections.Generic.IEnumerable<T> FindVisualChildren<T>(DependencyObject parent)
            where T : DependencyObject
        {
            for (int index = 0; index < VisualTreeHelper.GetChildrenCount(parent); index++)
            {
                DependencyObject child = VisualTreeHelper.GetChild(parent, index);
                if (child is T typed) yield return typed;
                foreach (T descendant in FindVisualChildren<T>(child)) yield return descendant;
            }
        }
    }
}
