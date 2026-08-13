using System;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Animation;
using System.Windows.Threading;

namespace LabMediaWidget
{
    public partial class MainWindow : Window
    {
        private string? _configPath;
        private int _parentPid;
        private LabMediaConfig _config = new LabMediaConfig();
        private FileSystemWatcher? _configWatcher;
        private DispatcherTimer _pollTimer;
        private DispatcherTimer _volToastTimer;
        private SmtcManager _smtc;
        private NowPlayingPanel _panel;
        private QueueState _queueState = QueueState.Unavailable();
        private YouTubeLibraryState _libraryState = YouTubeLibraryState.RequiresSetup();
        private TaskbarInfo _lastTaskbarInfo;
        private CancellationTokenSource _runtimeInputCancellation = new CancellationTokenSource();
        private uint _taskbarCreatedMsg;
        private double _currentDurationSeconds = 0;
        private bool _hasSession;
        private bool _isWidgetHovered;

        public MainWindow()
        {
            InitializeComponent();
            _smtc = new SmtcManager();
            _panel = new NowPlayingPanel(_smtc)
            {
                OpenSettingsRequested = () => EmitEvent("action", new { type = "openSettings" }),
                ProviderActionRequested = action => EmitEvent("providerAction", new { action }),
                LibraryActionRequested = (action, playlistId, videoId) =>
                    EmitEvent("libraryAction", new { action, playlistId, videoId })
            };
            _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _pollTimer.Tick += PollTimer_Tick;

            _volToastTimer = new DispatcherTimer { Interval = TimeSpan.FromMilliseconds(1500) };
            _volToastTimer.Tick += (s, e) => { VolToastBorder.Visibility = Visibility.Collapsed; _volToastTimer.Stop(); };

            PreviewMouseWheel += Window_PreviewMouseWheel;
            SystemParameters.StaticPropertyChanged += SystemParameters_StaticPropertyChanged;
            Closed += MainWindow_Closed;
        }

        private void SystemParameters_StaticPropertyChanged(object? sender, System.ComponentModel.PropertyChangedEventArgs e)
        {
            if (e.PropertyName is nameof(SystemParameters.HighContrast)
                or nameof(SystemParameters.ClientAreaAnimation))
                Dispatcher.BeginInvoke(ApplyConfig);
        }

        private void Window_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            try
            {
                MediaSessionState state = _smtc?.CurrentSessionState ?? new MediaSessionState();
                if (!state.HasSession) return;
                float delta = e.Delta > 0 ? 0.05f : -0.05f;
                string appHint = string.IsNullOrWhiteSpace(state.SourceAppId) ? state.SourceApp : state.SourceAppId;
                float currentVol = AppVolume.AdjustMediaVolume(appHint, delta);
                if (currentVol < 0) return;

                int volPercent = Math.Clamp((int)Math.Round(currentVol * 100), 0, 100);
                TxtVolToast.Text = $"{volPercent}%";
                VolToastBorder.Visibility = Visibility.Visible;
                _volToastTimer.Stop();
                _volToastTimer.Start();

                e.Handled = true;
            }
            catch { }
        }

        protected override async void OnSourceInitialized(EventArgs e)
        {
            base.OnSourceInitialized(e);

            // Set WS_EX_TOOLWINDOW and WS_EX_NOACTIVATE
            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            IntPtr exStyle = NativeMethods.GetWindowLongPtr(hwnd, NativeMethods.GWL_EXSTYLE);
            exStyle = new IntPtr(exStyle.ToInt64() | NativeMethods.WS_EX_TOOLWINDOW | NativeMethods.WS_EX_NOACTIVATE);
            NativeMethods.SetWindowLongPtr(hwnd, NativeMethods.GWL_EXSTYLE, exStyle);

            HwndSource source = HwndSource.FromHwnd(hwnd);
            source.AddHook(WndProc);

            _taskbarCreatedMsg = NativeMethods.RegisterWindowMessage("TaskbarCreated");

            ParseCommandLine();
            InitParentMonitoring();
            InitConfigWatcher();
            LoadConfig();

            _smtc.SessionStateChanged += Smtc_SessionStateChanged;
            await _smtc.InitializeAsync();

            _pollTimer.Start();
            StartRuntimeInputReader();

            EmitEvent("ready", new { pid = Process.GetCurrentProcess().Id });
        }

        private void ParseCommandLine()
        {
            string[] args = Environment.GetCommandLineArgs();
            for (int i = 1; i < args.Length; i++)
            {
                if (args[i] == "--config" && i + 1 < args.Length)
                {
                    _configPath = args[++i];
                }
                else if (args[i] == "--parent-pid" && i + 1 < args.Length)
                {
                    int.TryParse(args[++i], out _parentPid);
                }
            }
        }

        private void StartRuntimeInputReader()
        {
            CancellationToken cancellation = _runtimeInputCancellation.Token;
            _ = Task.Run(async () =>
            {
                while (!cancellation.IsCancellationRequested)
                {
                    string? line;
                    try
                    {
                        line = await Console.In.ReadLineAsync(cancellation);
                    }
                    catch (OperationCanceledException)
                    {
                        break;
                    }
                    catch
                    {
                        break;
                    }

                    if (line == null) break;
                    try
                    {
                        var message = JsonSerializer.Deserialize<RuntimeMessage>(line,
                            new JsonSerializerOptions { PropertyNameCaseInsensitive = true });
                        if (message?.Type == "queue:update" && message.Queue != null)
                        {
                            QueueState queue = SanitizeQueueState(message.Queue);
                            Dispatcher.Invoke(() =>
                            {
                                _queueState = queue;
                                _panel.UpdateQueueState(queue);
                            });
                        }
                        else if (message?.Type == "library:update" && message.Library != null)
                        {
                            YouTubeLibraryState library = SanitizeLibraryState(message.Library);
                            Dispatcher.Invoke(() =>
                            {
                                _libraryState = library;
                                _panel.UpdateLibraryState(library);
                            });
                        }
                    }
                    catch
                    {
                        // Runtime messages are an optional capability channel.
                        // Malformed provider data must never destabilize playback.
                    }
                }
            }, cancellation);
        }

        private static QueueState SanitizeQueueState(QueueState value)
        {
            string[] allowed =
            {
                QueueStatuses.Unavailable,
                QueueStatuses.RequiresAuth,
                QueueStatuses.Loading,
                QueueStatuses.Ready,
                QueueStatuses.Empty,
                QueueStatuses.Error
            };
            if (!allowed.Contains(value.Status, StringComparer.Ordinal))
                value.Status = QueueStatuses.Error;
            value.Items = (value.Items ?? new System.Collections.Generic.List<QueueItem>())
                .Take(8)
                .Select((item, index) => SanitizeQueueItem(item, index))
                .ToList();
            if (value.Status == QueueStatuses.Ready && value.Items.Count == 0)
                value.Status = QueueStatuses.Empty;
            value.Message = LimitText(value.Message, 500);
            value.Provider = LimitText(value.Provider, 80);
            value.Attribution = LimitText(value.Attribution, 80);
            return value;
        }

        private static QueueItem SanitizeQueueItem(QueueItem? item, int index)
        {
            item ??= new QueueItem();
            item.Id = LimitText(item.Id, 160);
            if (string.IsNullOrWhiteSpace(item.Id)) item.Id = $"queue-{index}";
            item.Title = LimitText(item.Title, 300);
            if (string.IsNullOrWhiteSpace(item.Title)) item.Title = "Unknown title";
            item.Artist = LimitText(item.Artist, 300);
            item.Attribution = LimitText(item.Attribution, 80);
            item.DurationMs = Math.Max(0, item.DurationMs);
            item.ArtworkUrl = Uri.TryCreate(item.ArtworkUrl, UriKind.Absolute, out Uri? artwork)
                && artwork.Scheme == Uri.UriSchemeHttps
                ? LimitText(artwork.AbsoluteUri, 2048)
                : string.Empty;
            return item;
        }

        private static YouTubeLibraryState SanitizeLibraryState(YouTubeLibraryState value)
        {
            value.Connection ??= new LibraryConnectionState();
            value.Library ??= new LibraryContentState();
            string[] connectionStatuses =
            {
                LibraryConnectionStatuses.RequiresSetup,
                LibraryConnectionStatuses.RequiresAuth,
                LibraryConnectionStatuses.Connecting,
                LibraryConnectionStatuses.Connected,
                LibraryConnectionStatuses.ReauthRequired,
                LibraryConnectionStatuses.Error
            };
            if (!connectionStatuses.Contains(value.Connection.Status, StringComparer.Ordinal))
                value.Connection.Status = LibraryConnectionStatuses.Error;
            value.Connection.Email = LimitText(value.Connection.Email, 320);
            value.Connection.ChannelTitle = LimitText(value.Connection.ChannelTitle, 200);
            value.Connection.Message = LimitText(value.Connection.Message, 500);

            string[] libraryStatuses =
            {
                LibraryStatuses.Idle,
                LibraryStatuses.Loading,
                LibraryStatuses.Ready,
                LibraryStatuses.Empty,
                LibraryStatuses.Offline,
                LibraryStatuses.QuotaExceeded,
                LibraryStatuses.Error
            };
            if (!libraryStatuses.Contains(value.Library.Status, StringComparer.Ordinal))
                value.Library.Status = LibraryStatuses.Error;
            value.Library.Message = LimitText(value.Library.Message, 500);
            value.Library.Attribution = LimitText(value.Library.Attribution, 80);
            value.Library.Playlists = (value.Library.Playlists ?? new System.Collections.Generic.List<LibraryPlaylist>())
                .Where(item => IsSafeYouTubeId(item?.Id, 128))
                .Take(200)
                .Select(SanitizeLibraryPlaylist)
                .GroupBy(item => item.Id, StringComparer.Ordinal)
                .Select(group => group.First())
                .ToList();

            string selectedId = value.Library.SelectedPlaylist?.Id ?? string.Empty;
            value.Library.SelectedPlaylist = value.Library.Playlists
                .FirstOrDefault(item => string.Equals(item.Id, selectedId, StringComparison.Ordinal));
            value.Library.Items = (value.Library.Items ?? new System.Collections.Generic.List<LibraryItem>())
                .Take(500)
                .Select((item, index) => SanitizeLibraryItem(item, index))
                .ToList();
            if (value.Library.SelectedPlaylist == null) value.Library.Items.Clear();
            if (value.Library.Status == LibraryStatuses.Ready
                && (value.Library.SelectedPlaylist != null ? value.Library.Items.Count == 0 : value.Library.Playlists.Count == 0))
                value.Library.Status = LibraryStatuses.Empty;
            return value;
        }

        private static LibraryPlaylist SanitizeLibraryPlaylist(LibraryPlaylist? item)
        {
            item ??= new LibraryPlaylist();
            item.Id = LimitText(item.Id, 128);
            item.Title = LimitText(item.Title, 300);
            if (string.IsNullOrWhiteSpace(item.Title)) item.Title = "Untitled playlist";
            item.ThumbnailUrl = SanitizeHttpsUrl(item.ThumbnailUrl);
            item.ItemCount = Math.Max(0, item.ItemCount);
            item.Attribution = "YouTube";
            return item;
        }

        private static LibraryItem SanitizeLibraryItem(LibraryItem? item, int index)
        {
            item ??= new LibraryItem();
            item.Id = LimitText(item.Id, 160);
            if (string.IsNullOrWhiteSpace(item.Id)) item.Id = $"library-{index}";
            item.VideoId = IsSafeYouTubeId(item.VideoId, 11) && item.VideoId.Length == 11 ? item.VideoId : string.Empty;
            item.Title = LimitText(item.Title, 300);
            if (string.IsNullOrWhiteSpace(item.Title)) item.Title = "Unavailable video";
            item.Artist = LimitText(item.Artist, 300);
            item.ThumbnailUrl = SanitizeHttpsUrl(item.ThumbnailUrl);
            item.DurationMs = Math.Max(0, item.DurationMs);
            item.Available = item.Available && item.VideoId.Length == 11;
            item.UnavailableReason = LimitText(item.UnavailableReason, 300);
            item.Attribution = "YouTube";
            return item;
        }

        private static bool IsSafeYouTubeId(string? value, int maxLength)
        {
            string id = value ?? string.Empty;
            return id.Length > 0 && id.Length <= maxLength
                && id.All(character => char.IsLetterOrDigit(character) || character == '_' || character == '-');
        }

        private static string SanitizeHttpsUrl(string? value)
        {
            return Uri.TryCreate(value, UriKind.Absolute, out Uri? uri)
                && uri.Scheme == Uri.UriSchemeHttps
                ? LimitText(uri.AbsoluteUri, 2048)
                : string.Empty;
        }

        private static string LimitText(string? value, int maxLength)
        {
            string clean = (value ?? string.Empty).Trim();
            return clean.Length <= maxLength ? clean : clean.Substring(0, maxLength);
        }

        private void InitParentMonitoring()
        {
            if (_parentPid <= 0) return;

            Task.Run(() =>
            {
                try
                {
                    var parent = Process.GetProcessById(_parentPid);
                    parent.WaitForExit();
                    Dispatcher.Invoke(() => Application.Current.Shutdown());
                }
                catch
                {
                    Dispatcher.Invoke(() => Application.Current.Shutdown());
                }
            });
        }

        private void InitConfigWatcher()
        {
            if (string.IsNullOrEmpty(_configPath) || !File.Exists(_configPath)) return;

            try
            {
                string? dir = Path.GetDirectoryName(_configPath);
                string file = Path.GetFileName(_configPath);
                if (string.IsNullOrEmpty(dir)) return;

                _configWatcher = new FileSystemWatcher(dir, file)
                {
                    NotifyFilter = NotifyFilters.LastWrite | NotifyFilters.Size
                };
                _configWatcher.Changed += (s, e) => Dispatcher.Invoke(LoadConfig);
                _configWatcher.EnableRaisingEvents = true;
            }
            catch { }
        }

        private void LoadConfig()
        {
            if (string.IsNullOrEmpty(_configPath) || !File.Exists(_configPath)) return;

            try
            {
                string json = File.ReadAllText(_configPath);
                var parsed = JsonSerializer.Deserialize<LabMediaConfig>(json);
                if (parsed != null)
                {
                    _config = parsed;
                    ApplyConfig();
                }
            }
            catch (Exception ex)
            {
                EmitEvent("error", new { message = $"Failed to read config: {ex.Message}" });
            }
        }

        private void ApplyConfig()
        {
            if (!_config.Enabled)
            {
                _panel.HideFlyout();
                Hide();
                return;
            }

            Opacity = Math.Clamp(_config.Opacity, 0.4, 1.0);

            // Fixed 40-DIP adaptive size modes. The outer native window never
            // animates or changes height while controls reveal on hover.
            double width = 280;
            switch ((_config.Size ?? "normal").ToLower())
            {
                case "micro":
                    width = 140;
                    break;
                case "compact":
                    width = 200;
                    break;
                case "large":
                    width = 360;
                    break;
                default: // normal
                    width = 280;
                    break;
            }

            Width = width;
            MainBorder.Width = width;

            // Theme presets
            string bgHex = "#CC18181B";
            string borderHex = "#3027272A";
            string accentHex = "#1DB954";

            switch ((_config.Theme ?? "spotify").ToLower())
            {
                case "oled":
                    bgHex = "#CC000000";
                    borderHex = "#3018181B";
                    accentHex = "#10B981";
                    break;
                case "neon":
                    bgHex = "#CC0D0221";
                    borderHex = "#7209B7";
                    accentHex = "#00F5D4";
                    break;
                case "glass":
                    bgHex = "#CC1A1A2E";
                    borderHex = "#38BDF8";
                    accentHex = "#38BDF8";
                    break;
                case "minimal":
                    bgHex = "#CC111827";
                    borderHex = "#1F2937";
                    accentHex = "#9CA3AF";
                    break;
                case "transparent":
                    bgHex = "#00000000";
                    borderHex = "#35FFFFFF";
                    accentHex = "#38BDF8";
                    break;
                default: // spotify
                    bgHex = "#CC18181B";
                    borderHex = "#3027272A";
                    accentHex = "#1DB954";
                    break;
            }

            try
            {
                var bgBrush = (Brush)new BrushConverter().ConvertFromString(bgHex)!;
                var borderBrush = (Brush)new BrushConverter().ConvertFromString(borderHex)!;
                var accentBrush = (Brush)new BrushConverter().ConvertFromString(accentHex)!;
                Color accentColor = (Color)ColorConverter.ConvertFromString(accentHex)!;

                MainBorder.Background = bgBrush;
                MainBorder.BorderBrush = borderBrush;
                ProgressTrack.Foreground = accentBrush;
                if (ProgressGlow != null) ProgressGlow.Color = accentColor;
                if (TxtFallbackArt != null) TxtFallbackArt.Fill = accentBrush;
                TxtTitle.Foreground = new SolidColorBrush(Color.FromRgb(0xF8, 0xFA, 0xFC));
                TxtArtist.Foreground = new SolidColorBrush(Color.FromRgb(0x88, 0x99, 0xAA));
                if (BtnPlayPause != null)
                {
                    BtnPlayPause.Background = accentBrush;
                    BtnPlayPause.BorderBrush = accentBrush;
                    BtnPlayPause.Foreground = Brushes.White;
                }
                _panel.ApplyTheme(bgBrush, borderBrush, accentBrush);

                if (SystemParameters.HighContrast)
                {
                    MainBorder.Background = SystemColors.WindowBrush;
                    MainBorder.BorderBrush = SystemColors.WindowTextBrush;
                    TxtTitle.Foreground = SystemColors.WindowTextBrush;
                    TxtArtist.Foreground = SystemColors.WindowTextBrush;
                    ProgressTrack.Foreground = SystemColors.HighlightBrush;
                    if (TxtFallbackArt != null) TxtFallbackArt.Fill = SystemColors.HighlightBrush;
                    if (BtnPlayPause != null)
                    {
                        BtnPlayPause.Background = SystemColors.HighlightBrush;
                        BtnPlayPause.BorderBrush = SystemColors.HighlightBrush;
                        BtnPlayPause.Foreground = SystemColors.HighlightTextBrush;
                    }
                }
            }
            catch { }

            // Element toggles and adaptive control density.
            ArtContainer.Visibility = _config.ShowAlbumArt ? Visibility.Visible : Visibility.Collapsed;
            ProgressTrack.Visibility = _config.ShowProgress ? Visibility.Visible : Visibility.Collapsed;
            ApplyAdaptiveLayout();

            UpdatePositionAndVisibility();
        }

        private void ApplyAdaptiveLayout()
        {
            string size = (_config.Size ?? "normal").ToLowerInvariant();
            string mode = (_config.TaskbarControlMode ?? "adaptive").ToLowerInvariant();

            bool micro = size == "micro";
            bool compact = size == "compact";
            bool large = size == "large";
            TrackInfoPanel.Visibility = micro ? Visibility.Collapsed : Visibility.Visible;
            TxtArtist.Visibility = compact || micro ? Visibility.Collapsed : Visibility.Visible;
            TxtTitle.MaxWidth = compact ? 90 : large ? 200 : 140;
            TxtArtist.MaxWidth = large ? 200 : 140;
            ArtContainer.Width = micro || compact ? 28 : 32;
            ArtContainer.Height = micro || compact ? 28 : 32;

            bool showSecondary;
            bool reserveSecondary = false;
            if (mode == "always")
            {
                showSecondary = true;
            }
            else if (mode == "minimal")
            {
                showSecondary = false;
            }
            else if (large)
            {
                showSecondary = true;
            }
            else if (!micro && !compact)
            {
                showSecondary = _isWidgetHovered;
                reserveSecondary = true;
            }
            else
            {
                showSecondary = false;
            }

            ControlsRail.Width = showSecondary || reserveSecondary ? 88 : 34;
            SetSecondaryControlState(BtnPrev, _config.Controls.Previous, showSecondary, reserveSecondary);
            SetSecondaryControlState(BtnNext, _config.Controls.Next, showSecondary, reserveSecondary);
            SetSecondaryControlState(BtnRewind, showSecondary, showSecondary, reserveSecondary);
            SetSecondaryControlState(BtnForward, showSecondary, showSecondary, reserveSecondary);
            SetSecondaryControlState(BtnLike, showSecondary, showSecondary, reserveSecondary);
            BtnPlayPause.Visibility = _config.Controls.PlayPause ? Visibility.Visible : Visibility.Collapsed;
        }

        private static void SetSecondaryControlState(
            UIElement control,
            bool configured,
            bool show,
            bool reserve)
        {
            if (!configured || (!show && !reserve))
            {
                control.BeginAnimation(OpacityProperty, null);
                control.Opacity = 0;
                control.IsHitTestVisible = false;
                control.Visibility = Visibility.Collapsed;
                return;
            }

            control.Visibility = Visibility.Visible;
            control.IsHitTestVisible = show;
            double target = show ? 1.0 : 0.0;
            var fade = new DoubleAnimation(target,
                SystemParameters.ClientAreaAnimation
                    ? TimeSpan.FromMilliseconds(120)
                    : TimeSpan.Zero)
            {
                FillBehavior = FillBehavior.Stop
            };
            fade.Completed += (_, _) => control.Opacity = target;
            control.BeginAnimation(OpacityProperty, fade);
        }

        private void MainBorder_MouseEnter(object sender, MouseEventArgs e)
        {
            _isWidgetHovered = true;
            ApplyAdaptiveLayout();
        }

        private void MainBorder_MouseLeave(object sender, MouseEventArgs e)
        {
            _isWidgetHovered = false;
            ApplyAdaptiveLayout();
        }

        private void Smtc_SessionStateChanged(object? sender, MediaSessionState e)
        {
            Dispatcher.Invoke(() =>
            {
                _panel.UpdateState(e);
                if (!e.HasSession)
                {
                    _hasSession = false;
                    TxtTitle.Text = "No Media Session";
                    TxtArtist.Text = "Play Spotify, YouTube, or browser";
                    ImgAlbumArt.Source = null;
                    TxtFallbackArt.Visibility = Visibility.Visible;
                    if (PathPlayPause != null)
                    {
                        PathPlayPause.Data = Geometry.Parse("M 7,5 L 18,12 L 7,19 Z");
                    }
                    ProgressTrack.Value = 0;
                    _currentDurationSeconds = 0;
                    EmitEvent("session", new { hasSession = false, sessionCount = e.SessionCount });
                    UpdatePositionAndVisibility();
                    return;
                }

                _hasSession = true;
                TxtTitle.Text = string.IsNullOrWhiteSpace(e.Title) ? "Unknown Track" : e.Title;
                TxtArtist.Text = string.IsNullOrWhiteSpace(e.Artist) ? "Unknown Artist" : e.Artist;

                if (e.AlbumArt != null)
                {
                    ImgAlbumArt.Source = e.AlbumArt;
                    TxtFallbackArt.Visibility = Visibility.Collapsed;
                }
                else
                {
                    ImgAlbumArt.Source = null;
                    TxtFallbackArt.Visibility = Visibility.Visible;
                }

                if (PathPlayPause != null)
                {
                    PathPlayPause.Data = Geometry.Parse(e.IsPlaying ? "M 6,5 H 10 V 19 H 6 Z M 14,5 H 18 V 19 H 14 Z" : "M 7,5 L 18,12 L 7,19 Z");
                }

                _currentDurationSeconds = e.DurationSeconds;
                if (e.DurationSeconds > 0)
                {
                    ProgressTrack.Maximum = e.DurationSeconds;
                    ProgressTrack.Value = Math.Clamp(e.PositionSeconds, 0, e.DurationSeconds);
                }
                else
                {
                    ProgressTrack.Value = 0;
                }

                EmitEvent("session", new
                {
                    hasSession = true,
                    sessionId = e.SessionId,
                    title = e.Title,
                    artist = e.Artist,
                    album = e.Album,
                    sourceApp = e.SourceApp,
                    isPlaying = e.IsPlaying,
                    position = e.PositionSeconds,
                    duration = e.DurationSeconds,
                    sessionCount = e.SessionCount,
                    canSeek = e.CanSeek,
                    canShuffle = e.CanShuffle,
                    canRepeat = e.CanRepeat,
                    shuffleActive = e.ShuffleActive,
                    repeatMode = e.RepeatMode
                });

                UpdatePositionAndVisibility();
            });
        }

        private async void PollTimer_Tick(object? sender, EventArgs e)
        {
            // Sessions can be created after LabSuite starts, and browsers do not
            // always raise SessionsChanged when a paused tab begins playback.
            await _smtc.RefreshAsync();
            UpdatePositionAndVisibility();
        }

        private void UpdatePositionAndVisibility()
        {
            if (!_config.Enabled)
            {
                _panel.HideFlyout();
                Hide();
                return;
            }

            if (_config.AutoHideWhenIdle && !_hasSession)
            {
                _panel.HideFlyout();
                Hide();
                return;
            }

            var tbInfo = TaskbarAnchor.CalculatePosition(Width, Height);
            if (!tbInfo.IsVisible || !tbInfo.HasSufficientSpace)
            {
                _panel.HideFlyout();
                Hide();
                return;
            }

            _lastTaskbarInfo = tbInfo;

            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            if (_config.HideWhenFullscreen && TaskbarAnchor.IsForegroundFullscreen(hwnd, tbInfo.TaskbarHwnd))
            {
                _panel.HideFlyout();
                Hide();
                return;
            }

            NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST,
                tbInfo.X, tbInfo.Y, tbInfo.Width, tbInfo.Height,
                NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);

            if (!IsVisible) Show();
            _panel.RepositionIfOpen(tbInfo);
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == _taskbarCreatedMsg)
            {
                _panel.HideFlyout();
                UpdatePositionAndVisibility();
                handled = true;
            }
            return IntPtr.Zero;
        }

        private async void BtnPrev_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            await _smtc.SkipPreviousAsync();
        }

        private async void BtnPlayPause_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            await _smtc.TogglePlayPauseAsync();
        }

        private async void BtnNext_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            await _smtc.SkipNextAsync();
        }

        private async void BtnRewind_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            await _smtc.SeekBackwardAsync(10);
        }

        private async void BtnForward_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            await _smtc.SeekForwardAsync(10);
        }

        private void BtnLike_Click(object sender, RoutedEventArgs e)
        {
            e.Handled = true;
            _smtc.LikeCurrentTrack();
        }

        private async void ProgressTrack_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (_currentDurationSeconds <= 0) return;
            Point pt = e.GetPosition(ProgressTrack);
            double ratio = pt.X / ProgressTrack.ActualWidth;
            double targetSeconds = Math.Clamp(ratio * _currentDurationSeconds, 0, _currentDurationSeconds);
            await _smtc.SeekToAsync(targetSeconds);
            e.Handled = true;
        }

        private void Art_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            HandlePrimaryClick();
            e.Handled = true;
        }

        private void TrackInfo_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            HandlePrimaryClick();
            e.Handled = true;
        }

        private void HandlePrimaryClick()
        {
            if (string.Equals(_config.PrimaryClickAction, "openSource", StringComparison.OrdinalIgnoreCase))
            {
                _smtc.BringAppToFront();
                return;
            }

            if (_panel.IsVisible)
            {
                _panel.HideFlyout();
                return;
            }

            // A click on the widget deactivates the flyout before this window
            // receives its mouse event. Treat that click as the requested toggle
            // off instead of immediately reopening the panel.
            if (DateTime.UtcNow - _panel.LastDeactivatedUtc < TimeSpan.FromMilliseconds(350))
                return;

            _panel.UpdateQueueState(_queueState);
            _panel.UpdateLibraryState(_libraryState);
            _panel.ShowAnchored(_lastTaskbarInfo);
        }

        private void MenuItem_CopyTitle_Click(object sender, RoutedEventArgs e)
        {
            try { Clipboard.SetText(TxtTitle.Text); } catch { }
        }

        private void MenuItem_CopyArtistTitle_Click(object sender, RoutedEventArgs e)
        {
            try { Clipboard.SetText($"{TxtArtist.Text} - {TxtTitle.Text}"); } catch { }
        }

        private void MenuItem_Hide_Click(object sender, RoutedEventArgs e)
        {
            EmitEvent("action", new { type = "hide" });
            _panel.HideFlyout();
            Hide();
        }

        private void MenuItem_OpenSettings_Click(object sender, RoutedEventArgs e)
        {
            EmitEvent("action", new { type = "openSettings" });
        }

        private void MainWindow_Closed(object? sender, EventArgs e)
        {
            _runtimeInputCancellation.Cancel();
            SystemParameters.StaticPropertyChanged -= SystemParameters_StaticPropertyChanged;
            _pollTimer.Stop();
            _volToastTimer.Stop();
            _configWatcher?.Dispose();
            try { _panel.Close(); } catch { }
        }

        private void EmitEvent(string eventName, object payload)
        {
            try
            {
                var evtObj = new { @event = eventName };
                string json = JsonSerializer.Serialize(payload);
                using var doc = JsonDocument.Parse(json);
                using var stream = new MemoryStream();
                using (var writer = new Utf8JsonWriter(stream))
                {
                    writer.WriteStartObject();
                    writer.WriteString("event", eventName);
                    foreach (var prop in doc.RootElement.EnumerateObject())
                    {
                        prop.WriteTo(writer);
                    }
                    writer.WriteEndObject();
                }

                string evtLine = System.Text.Encoding.UTF8.GetString(stream.ToArray());
                Console.Out.WriteLine(evtLine);
                Console.Out.Flush();
            }
            catch { }
        }
    }
}
