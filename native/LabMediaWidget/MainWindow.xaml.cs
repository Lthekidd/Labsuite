using System;
using System.Diagnostics;
using System.IO;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
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
        private SmtcManager _smtc;
        private uint _taskbarCreatedMsg;
        private double _currentDurationSeconds = 0;
        private bool _hasSession;

        public MainWindow()
        {
            InitializeComponent();
            _smtc = new SmtcManager();
            _pollTimer = new DispatcherTimer { Interval = TimeSpan.FromSeconds(1) };
            _pollTimer.Tick += PollTimer_Tick;
            PreviewMouseWheel += Window_PreviewMouseWheel;
        }

        private void Window_PreviewMouseWheel(object sender, MouseWheelEventArgs e)
        {
            try
            {
                float delta = e.Delta > 0 ? 0.05f : -0.05f;
                string appHint = _smtc?.CurrentSessionState?.SourceApp ?? "";
                AppVolume.AdjustMediaVolume(appHint, delta);
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
                Hide();
                return;
            }

            Opacity = Math.Clamp(_config.Opacity, 0.4, 1.0);

            // Size modes
            double width = 280;
            switch ((_config.Size ?? "normal").ToLower())
            {
                case "micro":
                    width = 140;
                    TxtTitle.MaxWidth = 0;
                    TxtArtist.MaxWidth = 0;
                    TxtTitle.Visibility = Visibility.Collapsed;
                    TxtArtist.Visibility = Visibility.Collapsed;
                    break;
                case "compact":
                    width = 200;
                    TxtTitle.MaxWidth = 90;
                    TxtArtist.MaxWidth = 90;
                    TxtTitle.Visibility = Visibility.Visible;
                    TxtArtist.Visibility = Visibility.Visible;
                    break;
                case "large":
                    width = 360;
                    TxtTitle.MaxWidth = 200;
                    TxtArtist.MaxWidth = 200;
                    TxtTitle.Visibility = Visibility.Visible;
                    TxtArtist.Visibility = Visibility.Visible;
                    break;
                default: // normal
                    width = 280;
                    TxtTitle.MaxWidth = 140;
                    TxtArtist.MaxWidth = 140;
                    TxtTitle.Visibility = Visibility.Visible;
                    TxtArtist.Visibility = Visibility.Visible;
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
                if (BtnPlayPause != null)
                {
                    BtnPlayPause.Background = accentBrush;
                    BtnPlayPause.BorderBrush = accentBrush;
                }
            }
            catch { }

            // Element toggles
            ArtContainer.Visibility = _config.ShowAlbumArt ? Visibility.Visible : Visibility.Collapsed;
            ProgressTrack.Visibility = _config.ShowProgress ? Visibility.Visible : Visibility.Collapsed;

            BtnPrev.Visibility = _config.Controls.Previous ? Visibility.Visible : Visibility.Collapsed;
            BtnPlayPause.Visibility = _config.Controls.PlayPause ? Visibility.Visible : Visibility.Collapsed;
            BtnNext.Visibility = _config.Controls.Next ? Visibility.Visible : Visibility.Collapsed;

            UpdatePositionAndVisibility();
        }

        private void Smtc_SessionStateChanged(object? sender, MediaSessionState e)
        {
            Dispatcher.Invoke(() =>
            {
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
                    EmitEvent("session", new { hasSession = false });
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
                    title = e.Title,
                    artist = e.Artist,
                    isPlaying = e.IsPlaying,
                    position = e.PositionSeconds,
                    duration = e.DurationSeconds
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
            if (!_config.Enabled || !_hasSession)
            {
                Hide();
                return;
            }

            var tbInfo = TaskbarAnchor.CalculatePosition(Width, Height);
            if (!tbInfo.IsVisible || !tbInfo.HasSufficientSpace)
            {
                Hide();
                return;
            }

            IntPtr hwnd = new WindowInteropHelper(this).Handle;
            if (_config.HideWhenFullscreen && TaskbarAnchor.IsForegroundFullscreen(hwnd, tbInfo.TaskbarHwnd))
            {
                Hide();
                return;
            }

            NativeMethods.SetWindowPos(hwnd, NativeMethods.HWND_TOPMOST,
                tbInfo.X, tbInfo.Y, tbInfo.Width, tbInfo.Height,
                NativeMethods.SWP_NOACTIVATE | NativeMethods.SWP_SHOWWINDOW);

            if (!IsVisible) Show();
        }

        private IntPtr WndProc(IntPtr hwnd, int msg, IntPtr wParam, IntPtr lParam, ref bool handled)
        {
            if (msg == _taskbarCreatedMsg)
            {
                UpdatePositionAndVisibility();
                handled = true;
            }
            return IntPtr.Zero;
        }

        private async void BtnPrev_Click(object sender, RoutedEventArgs e)
        {
            await _smtc.SkipPreviousAsync();
        }

        private async void BtnPlayPause_Click(object sender, RoutedEventArgs e)
        {
            await _smtc.TogglePlayPauseAsync();
        }

        private async void BtnNext_Click(object sender, RoutedEventArgs e)
        {
            await _smtc.SkipNextAsync();
        }

        private async void ProgressTrack_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            if (_currentDurationSeconds <= 0) return;
            Point pt = e.GetPosition(ProgressTrack);
            double ratio = pt.X / ProgressTrack.ActualWidth;
            double targetSeconds = Math.Clamp(ratio * _currentDurationSeconds, 0, _currentDurationSeconds);
            await _smtc.SeekToAsync(targetSeconds);
        }

        private void Art_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            _smtc.BringAppToFront();
        }

        private void TrackInfo_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
        {
            _smtc.BringAppToFront();
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
            Hide();
        }

        private void MenuItem_OpenSettings_Click(object sender, RoutedEventArgs e)
        {
            EmitEvent("action", new { type = "openSettings" });
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
