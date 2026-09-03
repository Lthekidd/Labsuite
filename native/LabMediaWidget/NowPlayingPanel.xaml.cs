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
        private static readonly Geometry SpeakerHighGeometry = Geometry.Parse("M 3,9 V 15 H 7 L 12,20 V 4 L 7,9 H 3 Z M 16.5,12 C 16.5,10.23 15.48,8.71 14,7.97 V 16.02 C 15.48,15.29 16.5,13.77 16.5,12 Z M 14,3.23 V 5.29 C 16.89,6.15 19,8.83 19,12 C 19,15.17 16.89,17.85 14,18.71 V 20.77 C 18.01,19.86 21,16.28 21,12 C 21,7.72 18.01,4.14 14,3.23 Z");
        private static readonly Geometry SpeakerMutedGeometry = Geometry.Parse("M 3,9 V 15 H 7 L 12,20 V 4 L 7,9 H 3 Z M 16,9 L 21,14 M 21,9 L 16,14");

        private readonly SmtcManager _smtc;
        private readonly DispatcherTimer _volumeCommitTimer;
        private MediaSessionState _state = new MediaSessionState();
        private QueueState _queueState = QueueState.Unavailable();
        private YTMDesktopRuntimeState _ytmdState = new YTMDesktopRuntimeState();
        private TaskbarInfo _anchor;
        private bool _updatingSession;
        private bool _updatingVolume;
        private bool _opening;
        private bool _isMuted;

        public DateTime LastDeactivatedUtc { get; private set; } = DateTime.MinValue;

        public Action? OpenSettingsRequested { get; set; }
        public Action<string, object?, int?>? ProviderActionRequested { get; set; }

        public NowPlayingPanel(SmtcManager smtc)
        {
            InitializeComponent();
            _smtc = smtc;
            _volumeCommitTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
            _volumeCommitTimer.Tick += VolumeCommitTimer_Tick;
            BtnLike.IsEnabled = false;
            BtnDislike.IsEnabled = false;
            BtnLike.Background = NeutralBrush();
            BtnDislike.Background = NeutralBrush();
            BtnLike.ToolTip = "Ratings are not supported for this player";
            BtnDislike.ToolTip = "Ratings are not supported for this player";
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
            BtnShuffle.IsEnabled = state.HasSession;
            BtnRepeat.IsEnabled = state.HasSession;
            BtnRewind.IsEnabled = state.HasSession;
            BtnForward.IsEnabled = state.HasSession;
            BtnShuffle.Background = state.ShuffleActive ? AccentBrush() : NeutralBrush();
            BtnRepeat.Background = state.RepeatMode != "none" ? AccentBrush() : NeutralBrush();
            TxtRepeat.Text = state.RepeatMode == "track" ? "1" : string.Empty;

            if (!_ytmdState.Active)
            {
                BtnLike.IsEnabled = false;
                BtnDislike.IsEnabled = false;
                BtnLike.Background = NeutralBrush();
                BtnDislike.Background = NeutralBrush();
                BtnLike.ToolTip = "Ratings are not supported for this player";
                BtnDislike.ToolTip = "Ratings are not supported for this player";
            }

            _updatingSession = true;
            SessionPicker.ItemsSource = state.Sessions.ToList();
            SessionPicker.SelectedValue = state.SessionId;
            SessionPicker.Visibility = state.Sessions.Count > 1 ? Visibility.Visible : Visibility.Collapsed;
            _updatingSession = false;

            if (IsVisible && !string.Equals(previousSource, state.SourceApp, StringComparison.Ordinal))
                RefreshVolume();
            ApplyYTMDesktopState();
        }

        public void UpdateYTMDesktopState(YTMDesktopRuntimeState? state)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => UpdateYTMDesktopState(state));
                return;
            }
            _ytmdState = state ?? new YTMDesktopRuntimeState();
            ApplyYTMDesktopState();
        }

        private void ApplyYTMDesktopState()
        {
            MenuItemOpenYTMDesktop.Visibility = _ytmdState.Installed ? Visibility.Visible : Visibility.Collapsed;
            if (!_ytmdState.Active)
            {
                BtnLike.IsEnabled = false;
                BtnDislike.IsEnabled = false;
                BtnLike.Background = NeutralBrush();
                BtnDislike.Background = NeutralBrush();
                BtnLike.ToolTip = "Ratings are not supported for this player";
                BtnDislike.ToolTip = "Ratings are not supported for this player";
                return;
            }

            YTMDesktopPlaybackState playback = _ytmdState.Playback ?? new YTMDesktopPlaybackState();
            YTMDesktopCapabilities capabilities = _ytmdState.Capabilities ?? new YTMDesktopCapabilities();
            TxtSource.Text = "YTmusic";
            if (playback.HasTrack)
            {
                TxtTitle.Text = string.IsNullOrWhiteSpace(playback.Title) ? "Unknown track" : playback.Title;
                TxtArtist.Text = string.IsNullOrWhiteSpace(playback.Artist) ? "Unknown artist" : playback.Artist;
                TxtAlbum.Text = playback.Album ?? string.Empty;
                TxtAlbum.Visibility = string.IsNullOrWhiteSpace(playback.Album) ? Visibility.Collapsed : Visibility.Visible;
            }
            double duration = Math.Max(0, playback.DurationSeconds);
            TimelineSlider.Maximum = Math.Max(1, duration);
            TimelineSlider.Value = Math.Clamp(playback.PositionSeconds, 0, TimelineSlider.Maximum);
            TimelineSlider.IsEnabled = duration > 0;
            TxtElapsed.Text = FormatTime(playback.PositionSeconds);
            TxtDuration.Text = FormatTime(duration);
            PathPlayPause.Data = Geometry.Parse(playback.IsPlaying
                ? "M 6,5 H 10 V 19 H 6 Z M 14,5 H 18 V 19 H 14 Z"
                : "M 7,5 L 18,12 L 7,19 Z");

            BtnPrevious.IsEnabled = capabilities.CanSkipPrevious;
            BtnPlayPause.IsEnabled = capabilities.CanPlayPause;
            BtnNext.IsEnabled = capabilities.CanSkipNext;
            BtnShuffle.IsEnabled = capabilities.CanShuffle;
            BtnRepeat.IsEnabled = capabilities.CanRepeat;
            BtnRewind.IsEnabled = capabilities.CanSeek;
            BtnForward.IsEnabled = capabilities.CanSeek;
            BtnLike.IsEnabled = capabilities.CanLike;
            BtnDislike.IsEnabled = capabilities.CanDislike;
            VolumeSlider.IsEnabled = capabilities.CanSetVolume;
            BtnMute.IsEnabled = capabilities.CanMute;
            BtnShuffle.Background = playback.ShuffleActive ? AccentBrush() : NeutralBrush();
            BtnRepeat.Background = playback.RepeatMode != "none" ? AccentBrush() : NeutralBrush();
            BtnLike.Background = playback.LikeState == "liked" ? AccentBrush() : NeutralBrush();
            BtnDislike.Background = playback.LikeState == "disliked" ? WithOpacity(AccentBrush(), 0.35) : NeutralBrush();
            BtnLike.ToolTip = playback.LikeState == "liked" ? "Unlike track" : "Like track";
            BtnDislike.ToolTip = playback.LikeState == "disliked" ? "Remove dislike" : "Dislike track";
            TxtRepeat.Text = playback.RepeatMode == "one" ? "1" : string.Empty;

            _updatingVolume = true;
            VolumeSlider.Value = Math.Clamp(playback.Volume, 0, 100);
            TxtVolume.Text = $"{Math.Round(VolumeSlider.Value):0}%";
            UpdateMuteVisuals(playback.Muted);
            _updatingVolume = false;
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
                bool isYTMDesktop = string.Equals(_queueState.Provider, "ytmdesktop", StringComparison.Ordinal);
                BtnQueueAction.Content = isYTMDesktop ? "Connect YTmusic" : "Connect Spotify";
                BtnQueueAction.Tag = isYTMDesktop ? "ytmd:connect" : "connectSpotify";
                BtnQueueAction.Visibility = Visibility.Visible;
            }
            else if (_queueState.Status == QueueStatuses.Error)
            {
                BtnQueueAction.Content = "Retry";
                BtnQueueAction.Tag = string.Equals(_queueState.Provider, "ytmdesktop", StringComparison.Ordinal)
                    ? "ytmd:refresh" : "refreshQueue";
                BtnQueueAction.Visibility = Visibility.Visible;
            }
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

            // The expanded flyout panel must ALWAYS maintain 100% solid opacity
            // so underlying desktop text or windows never bleed through, regardless of taskbar theme.
            PanelBorder.Background = new SolidColorBrush(Color.FromRgb(0x11, 0x13, 0x18));
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
        }

        public void ShowAnchored(TaskbarInfo anchor)
        {
            _anchor = anchor;
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
            if (_ytmdState.Active)
            {
                ApplyYTMDesktopState();
                return;
            }
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
                    UpdateMuteVisuals(muted);
                    _updatingVolume = false;
                });
            });
        }

        private void UpdateMuteVisuals(bool muted)
        {
            _isMuted = muted;
            TxtMuteIcon.Text = muted ? "MUTE" : "VOL";
            PathMuteIcon.Data = muted ? SpeakerMutedGeometry : SpeakerHighGeometry;
            BtnMute.ToolTip = muted ? "Unmute application" : "Mute application";
        }

        private async void SessionPicker_SelectionChanged(object sender, SelectionChangedEventArgs e)
        {
            if (_updatingSession || SessionPicker.SelectedValue is not string sessionId
                || sessionId == _state.SessionId) return;
            await _smtc.SelectSessionAsync(sessionId);
        }

        private async void TimelineSlider_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            bool providerSeek = _ytmdState.Active && _ytmdState.Playback.DurationSeconds > 0;
            if ((!providerSeek && (!_state.CanSeek || _state.DurationSeconds <= 0)) || TimelineSlider.ActualWidth <= 0) return;
            Point point = e.GetPosition(TimelineSlider);
            double duration = providerSeek ? _ytmdState.Playback.DurationSeconds : _state.DurationSeconds;
            double target = Math.Clamp(point.X / TimelineSlider.ActualWidth * duration, 0, duration);
            TimelineSlider.Value = target;
            if (providerSeek) RequestYTMDesktopAction("seekTo", target);
            else await _smtc.SeekToAsync(target);
            e.Handled = true;
        }

        private void VolumeSlider_PreviewMouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (VolumeSlider.ActualWidth <= 0) return;
            Point point = e.GetPosition(VolumeSlider);
            double target = Math.Clamp((point.X / VolumeSlider.ActualWidth) * VolumeSlider.Maximum, VolumeSlider.Minimum, VolumeSlider.Maximum);
            VolumeSlider.Value = target;
        }

        private void VolumeSlider_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            AdjustPanelVolume(e.Delta > 0 ? 5.0 : -5.0);
            e.Handled = true;
        }

        private void Window_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            if (IsVisualDescendantOf(e.OriginalSource as DependencyObject, QueueItemsScroll)
                || IsVisualDescendantOf(e.OriginalSource as DependencyObject, SessionPicker))
            {
                return;
            }

            AdjustPanelVolume(e.Delta > 0 ? 5.0 : -5.0);
            e.Handled = true;
        }

        private void AdjustPanelVolume(double deltaPercent)
        {
            double target = Math.Clamp(VolumeSlider.Value + deltaPercent, 0, 100);
            VolumeSlider.Value = target;
        }

        public void SyncVolumeLevel(float level)
        {
            if (!Dispatcher.CheckAccess())
            {
                Dispatcher.Invoke(() => SyncVolumeLevel(level));
                return;
            }

            _updatingVolume = true;
            VolumeSlider.Value = Math.Clamp(level * 100, 0, 100);
            TxtVolume.Text = $"{Math.Round(VolumeSlider.Value):0}%";
            _updatingVolume = false;
        }

        private static bool IsVisualDescendantOf(DependencyObject? node, DependencyObject? targetParent)
        {
            if (node == null || targetParent == null) return false;
            while (node != null)
            {
                if (ReferenceEquals(node, targetParent)) return true;
                if (node is Visual || node is System.Windows.Media.Media3D.Visual3D)
                    node = VisualTreeHelper.GetParent(node);
                else if (node is FrameworkContentElement contentElement)
                    node = contentElement.Parent;
                else
                    break;
            }
            return false;
        }

        private async void BtnPrevious_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("previous");
            else await _smtc.SkipPreviousAsync();
        }

        private async void BtnPlayPause_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("playPause");
            else await _smtc.TogglePlayPauseAsync();
        }

        private async void BtnNext_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("next");
            else await _smtc.SkipNextAsync();
        }

        private async void BtnShuffle_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("shuffle");
            else await _smtc.ToggleShuffleAsync();
        }

        private async void BtnRepeat_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active)
            {
                string nextMode = _ytmdState.Playback.RepeatMode switch
                {
                    "none" => "all",
                    "all" => "one",
                    _ => "none"
                };
                RequestYTMDesktopAction("repeatMode", nextMode);
            }
            else await _smtc.CycleRepeatAsync();
        }

        private async void BtnRewind_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("seekTo", Math.Max(0, _ytmdState.Playback.PositionSeconds - 10));
            else await _smtc.SeekBackwardAsync(10);
        }

        private async void BtnForward_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("seekTo", Math.Min(_ytmdState.Playback.DurationSeconds, _ytmdState.Playback.PositionSeconds + 10));
            else await _smtc.SeekForwardAsync(10);
        }

        private void BtnLike_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active && (_ytmdState.Capabilities?.CanLike ?? false))
            {
                RequestYTMDesktopAction("toggleLike");
            }
        }

        private void BtnDislike_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active && (_ytmdState.Capabilities?.CanDislike ?? false))
            {
                RequestYTMDesktopAction("toggleDislike");
            }
        }

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
            if (_ytmdState.Active)
            {
                RequestYTMDesktopAction("setVolume", VolumeSlider.Value);
                return;
            }
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
            if (_ytmdState.Active)
            {
                RequestYTMDesktopAction(_ytmdState.Playback.Muted ? "unmute" : "mute");
                return;
            }
            string source = VolumeProcessHint();
            bool mute = !_isMuted;
            _ = Task.Run(() =>
            {
                AppVolume.SetMediaMute(source, mute);
                Dispatcher.Invoke(RefreshVolume);
            });
        }

        private void BtnOpenSource_Click(object sender, RoutedEventArgs e)
        {
            if (_ytmdState.Active) RequestYTMDesktopAction("open");
            else _smtc.BringAppToFront();
        }

        private void RequestYTMDesktopAction(string action, object? value = null, int? queueIndex = null) =>
            ProviderActionRequested?.Invoke($"ytmd:{action}", value, queueIndex);

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

        private void MenuItem_OpenYTMDesktop_Click(object sender, RoutedEventArgs e) => RequestYTMDesktopAction("open");

        private void BtnQueueAction_Click(object sender, RoutedEventArgs e)
        {
            if (BtnQueueAction.Tag is string action) ProviderActionRequested?.Invoke(action, null, null);
        }

        private void QueueItem_Click(object sender, RoutedEventArgs e)
        {
            if (sender is Button { Tag: QueueItem item } && item.Available && item.QueueIndex >= 0)
                RequestYTMDesktopAction("playQueueIndex", null, item.QueueIndex);
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
