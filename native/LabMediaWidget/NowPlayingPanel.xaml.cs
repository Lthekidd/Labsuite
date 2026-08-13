using System;
using System.Linq;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Threading;

namespace LabMediaWidget
{
    public partial class NowPlayingPanel : Window
    {
        private readonly SmtcManager _smtc;
        private readonly DispatcherTimer _volumeCommitTimer;
        private MediaSessionState _state = new MediaSessionState();
        private QueueState _queueState = QueueState.Unavailable();
        private TaskbarInfo _anchor;
        private bool _updatingSession;
        private bool _updatingVolume;
        private bool _opening;

        public DateTime LastDeactivatedUtc { get; private set; } = DateTime.MinValue;

        public Action? OpenSettingsRequested { get; set; }
        public Action<string>? ProviderActionRequested { get; set; }

        public NowPlayingPanel(SmtcManager smtc)
        {
            InitializeComponent();
            _smtc = smtc;
            _volumeCommitTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(120) };
            _volumeCommitTimer.Tick += VolumeCommitTimer_Tick;
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
            string source = _state.SourceApp;
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
            string source = _state.SourceApp;
            float level = (float)(VolumeSlider.Value / 100.0);
            _ = Task.Run(() =>
            {
                AppVolume.SetMediaVolume(source, level);
                Dispatcher.Invoke(RefreshVolume);
            });
        }

        private void BtnMute_Click(object sender, RoutedEventArgs e)
        {
            string source = _state.SourceApp;
            bool mute = TxtMuteIcon.Text != "MUTE";
            _ = Task.Run(() =>
            {
                AppVolume.SetMediaMute(source, mute);
                Dispatcher.Invoke(RefreshVolume);
            });
        }

        private void BtnOpenSource_Click(object sender, RoutedEventArgs e) => _smtc.BringAppToFront();

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
