param(
    [string]$config,
    [int]$parentPid
)

$ErrorActionPreference = 'SilentlyContinue'

# Load assemblies
$null = [System.Reflection.Assembly]::LoadWithPartialName("System.Runtime.WindowsRuntime")
$null = [System.Reflection.Assembly]::LoadWithPartialName("PresentationFramework")
$null = [System.Reflection.Assembly]::LoadWithPartialName("PresentationCore")
$null = [System.Reflection.Assembly]::LoadWithPartialName("WindowsBase")
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType=WindowsRuntime]

# Win32 API setup via C# Add-Type
$code = @"
using System;
using System.Runtime.InteropServices;

namespace LabMediaWin32 {
    public static class Native {
        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr FindWindow(string lpClassName, string lpWindowName);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern IntPtr FindWindowEx(IntPtr hwndParent, IntPtr hwndChildAfter, string lpszClass, string lpszWindow);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool GetWindowRect(IntPtr hWnd, out RECT lpRect);

        [DllImport("user32.dll")]
        public static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll")]
        public static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll", SetLastError = true)]
        public static extern bool SetWindowPos(IntPtr hWnd, IntPtr hWndInsertAfter, int X, int Y, int cx, int cy, uint uFlags);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong")]
        public static extern int GetWindowLong(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "SetWindowLong")]
        public static extern int SetWindowLong(IntPtr hWnd, int nIndex, int dwNewLong);

        [StructLayout(LayoutKind.Sequential)]
        public struct RECT {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
            public int Width { get { return Right - Left; } }
            public int Height { get { return Bottom - Top; } }
        }

        public static readonly IntPtr HWND_TOPMOST = new IntPtr(-1);
        public const uint SWP_NOACTIVATE = 0x0010;
        public const uint SWP_SHOWWINDOW = 0x0040;
        public const uint SWP_NOSIZE = 0x0001;
        public const uint SWP_NOMOVE = 0x0002;
        public const int GWL_EXSTYLE = -20;
        public const int WS_EX_TOOLWINDOW = 0x00000080;
        public const int WS_EX_NOACTIVATE = 0x08000000;
        public const int SW_RESTORE = 9;

        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    internal class MMDeviceEnumeratorComObject { }

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IMMDevice
    {
        [PreserveSig]
        int Activate(
            ref Guid iid,
            int classContext,
            IntPtr activationParameters,
            [MarshalAs(UnmanagedType.IUnknown)] out object activatedInterface);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionManager2
    {
        [PreserveSig] int GetAudioSessionControl(IntPtr sessionGuid, uint streamFlags, out IntPtr sessionControl);
        [PreserveSig] int GetSimpleAudioVolume(IntPtr sessionGuid, uint streamFlags, out IntPtr audioVolume);
        [PreserveSig] int GetSessionEnumerator(out IAudioSessionEnumerator sessionEnumerator);
    }

    [ComImport]
    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionEnumerator
    {
        [PreserveSig] int GetCount(out int sessionCount);
        [PreserveSig] int GetSession(int sessionIndex, out IAudioSessionControl sessionControl);
    }

    [ComImport]
    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, IntPtr eventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, IntPtr eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingId);
        [PreserveSig] int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
    }

    [ComImport]
    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioSessionControl2
    {
        [PreserveSig] int GetState(out int state);
        [PreserveSig] int GetDisplayName([MarshalAs(UnmanagedType.LPWStr)] out string displayName);
        [PreserveSig] int SetDisplayName([MarshalAs(UnmanagedType.LPWStr)] string displayName, IntPtr eventContext);
        [PreserveSig] int GetIconPath([MarshalAs(UnmanagedType.LPWStr)] out string iconPath);
        [PreserveSig] int SetIconPath([MarshalAs(UnmanagedType.LPWStr)] string iconPath, IntPtr eventContext);
        [PreserveSig] int GetGroupingParam(out Guid groupingId);
        [PreserveSig] int SetGroupingParam(ref Guid groupingId, IntPtr eventContext);
        [PreserveSig] int RegisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int UnregisterAudioSessionNotification(IntPtr client);
        [PreserveSig] int GetSessionIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionIdentifier);
        [PreserveSig] int GetSessionInstanceIdentifier([MarshalAs(UnmanagedType.LPWStr)] out string sessionInstanceIdentifier);
        [PreserveSig] int GetProcessId(out uint processId);
    }

    [ComImport]
    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISimpleAudioVolume
    {
        [PreserveSig] int SetMasterVolume(float level, ref Guid eventContext);
        [PreserveSig] int GetMasterVolume(out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool muted, ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool muted);
    }

    public static class AppVolume
    {
        public static float AdjustMediaVolume(string activeAppHint, float delta)
        {
            IMMDeviceEnumerator deviceEnumerator = null;
            IMMDevice device = null;
            object sessionManagerObject = null;
            IAudioSessionEnumerator sessionEnumerator = null;

            try
            {
                deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                if (deviceEnumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0 || device == null)
                    return 0.0f;

                Guid managerId = typeof(IAudioSessionManager2).GUID;
                if (device.Activate(ref managerId, 1, IntPtr.Zero, out sessionManagerObject) < 0
                    || sessionManagerObject is not IAudioSessionManager2 manager)
                    return 0.0f;

                if (manager.GetSessionEnumerator(out sessionEnumerator) < 0 || sessionEnumerator == null
                    || sessionEnumerator.GetCount(out int sessionCount) < 0)
                    return 0.0f;

                bool adjustedAny = false;
                for (int i = 0; i < sessionCount; i++)
                {
                    IAudioSessionControl session = null;
                    try
                    {
                        if (sessionEnumerator.GetSession(i, out session) < 0 || session == null
                            || session is not IAudioSessionControl2 session2
                            || session is not ISimpleAudioVolume volume
                            || session2.GetProcessId(out uint processId) < 0)
                            continue;

                        string processName = "";
                        try { processName = System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; } catch { }
                        if (!IsMediaProcess(processName, activeAppHint))
                            continue;

                        if (volume.GetMasterVolume(out float currentVolume) < 0)
                            continue;

                        float newVolume = Math.Max(0.0f, Math.Min(1.0f, currentVolume + delta));
                        Guid eventContext = Guid.Empty;
                        if (volume.SetMasterVolume(newVolume, ref eventContext) >= 0)
                            adjustedAny = true;
                    }
                    finally
                    {
                        ReleaseComObject(session);
                    }
                }

                return adjustedAny ? 1.0f : 0.0f;
            }
            catch
            {
                return 0.0f;
            }
            finally
            {
                ReleaseComObject(sessionEnumerator);
                ReleaseComObject(sessionManagerObject);
                ReleaseComObject(device);
                ReleaseComObject(deviceEnumerator);
            }
        }

        private static bool IsMediaProcess(string processName, string activeAppHint)
        {
            if (string.IsNullOrWhiteSpace(processName)) return false;

            if (!string.IsNullOrWhiteSpace(activeAppHint)
                && (processName.Contains(activeAppHint, StringComparison.OrdinalIgnoreCase)
                    || activeAppHint.Contains(processName, StringComparison.OrdinalIgnoreCase)))
                return true;

            string name = processName.ToLowerInvariant();
            return name.Contains("spotify") ||
                   name.Contains("chrome") ||
                   name.Contains("msedge") ||
                   name.Contains("firefox") ||
                   name.Contains("brave") ||
                   name.Contains("opera") ||
                   name.Contains("vivaldi") ||
                   name.Contains("vlc") ||
                   name.Contains("wmplayer") ||
                   name.Contains("musicbee") ||
                   name.Contains("foobar2000") ||
                   name.Contains("itunes") ||
                   name.Contains("applemusic") ||
                   name.Contains("tidal") ||
                   name.Contains("deezer");
        }

        private static void ReleaseComObject(object value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); } catch { }
        }
    }
}
"@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

function Await-WinRT($asyncOp, $resultType) {
    try {
        $asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object { $_.Name -eq 'AsTask' -and $_.GetParameters().Length -eq 1 -and $_.IsGenericMethod } | Select-Object -First 1
        if (-not $asTask) { return $null }
        $genericMethod = $asTask.MakeGenericMethod($resultType)
        $task = $genericMethod.Invoke($null, @($asyncOp))
        $task.Wait(1500)
        return $task.Result
    } catch {
        return $null
    }
}

# Parse Config if provided
$targetWidth = 300
$targetOpacity = 1.0
$bgHex = "#18181b"
$accentHex = "#1db954"
$borderHex = "#27272a"

if ($config -and (Test-Path $config)) {
    try {
        $json = Get-Content $config -Raw | ConvertFrom-Json
        if ($json.size -eq 'micro') { $targetWidth = 140 }
        elseif ($json.size -eq 'compact') { $targetWidth = 240 }
        elseif ($json.size -eq 'large') { $targetWidth = 380 }
        if ($json.opacity) { $targetOpacity = [double]$json.opacity }

        if ($json.theme -eq 'oled') {
            $bgHex = "#000000"; $accentHex = "#10b981"; $borderHex = "#18181b"
        } elseif ($json.theme -eq 'neon') {
            $bgHex = "#0d0221"; $accentHex = "#00f5d4"; $borderHex = "#7209b7"
        } elseif ($json.theme -eq 'glass') {
            $bgHex = "#1a1a2e"; $accentHex = "#38bdf8"; $borderHex = "#334155"
        } elseif ($json.theme -eq 'minimal') {
            $bgHex = "#111827"; $accentHex = "#9ca3af"; $borderHex = "#1f2937"
        }
    } catch {}
}

# Build WPF XAML Window
[xml]$xaml = @"
<Window xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"
        xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"
        Title="LabMedia" Height="40" Width="$targetWidth"
        WindowStyle="None" AllowsTransparency="True" Background="Transparent"
        Topmost="True" ShowInTaskbar="False">
    <Border Name="MainBorder" Background="$bgHex" BorderBrush="$borderHex" BorderThickness="1" CornerRadius="8" Opacity="$targetOpacity" Margin="2">
        <Grid Margin="6,2,6,2">
            <Grid.ColumnDefinitions>
                <ColumnDefinition Width="Auto"/>
                <ColumnDefinition Width="*"/>
                <ColumnDefinition Width="Auto"/>
            </Grid.ColumnDefinitions>

            <!-- Album Art / Icon -->
            <Border Name="ArtContainer" Grid.Column="0" Width="30" Height="30" CornerRadius="6" Background="#27272a" Margin="0,0,8,0" Cursor="Hand">
                <Path Name="PathIcon" Data="M 12,2 C 6.48,2 2,6.48 2,12 C 2,17.52 6.48,22 12,22 C 17.52,22 22,17.52 22,12 C 22,6.48 17.52,2 12,2 Z M 12,16.5 C 9.51,16.5 7.5,14.49 7.5,12 C 7.5,9.51 9.51,7.5 12,7.5 C 14.49,7.5 16.5,9.51 16.5,12 C 16.5,14.49 14.49,16.5 12,16.5 Z M 12,10.5 C 11.17,10.5 10.5,11.17 10.5,12 C 10.5,12.83 11.17,13.5 12,13.5 C 12.83,13.5 13.5,12.83 13.5,12 C 13.5,11.17 12.83,10.5 12,10.5 Z" Fill="$accentHex" Width="16" Height="16" Stretch="Uniform" HorizontalAlignment="Center" VerticalAlignment="Center"/>
            </Border>

            <!-- Track Info -->
            <StackPanel Name="InfoPanel" Grid.Column="1" VerticalAlignment="Center" Cursor="Hand">
                <TextBlock Name="TxtTitle" Text="No Media Session" FontSize="12" FontWeight="Bold" Foreground="#ffffff" TextTrimming="CharacterEllipsis"/>
                <TextBlock Name="TxtArtist" Text="Play Spotify, YouTube, or browser" FontSize="10.5" Foreground="#a1a1aa" TextTrimming="CharacterEllipsis" Margin="0,1,0,0"/>
            </StackPanel>

            <!-- Media Control Buttons -->
            <StackPanel Grid.Column="2" Orientation="Horizontal" VerticalAlignment="Center" Margin="6,0,0,0">
                <Button Name="BtnPrev" Width="26" Height="26" Background="Transparent" BorderThickness="0" Cursor="Hand" Margin="0,0,2,0">
                    <Path Data="M 6,5 V 19 H 8 V 5 Z M 18,5.5 L 9.5,12 L 18,18.5 Z" Fill="#ffffff" Width="10" Height="10" Stretch="Uniform"/>
                </Button>
                <Button Name="BtnPlayPause" Width="26" Height="26" Background="$accentHex" BorderThickness="0" Cursor="Hand" Margin="0,0,2,0">
                    <Button.Resources>
                        <Style TargetType="Border">
                            <Setter Property="CornerRadius" Value="13"/>
                        </Style>
                    </Button.Resources>
                    <Path Name="PathPlayPause" Data="M 7,5 L 18,12 L 7,19 Z" Fill="#ffffff" Width="11" Height="11" Stretch="Uniform"/>
                </Button>
                <Button Name="BtnNext" Width="26" Height="26" Background="Transparent" BorderThickness="0" Cursor="Hand">
                    <Path Data="M 16,5 V 19 H 18 V 5 Z M 6,5.5 L 14.5,12 L 6,18.5 Z" Fill="#ffffff" Width="10" Height="10" Stretch="Uniform"/>
                </Button>
            </StackPanel>

            <!-- Progress & Seeking Bar -->
            <ProgressBar Name="ProgressTrack" Grid.Column="0" Grid.ColumnSpan="3" Height="3" VerticalAlignment="Bottom" Background="#20ffffff" Foreground="$accentHex" BorderThickness="0" Minimum="0" Maximum="100" Value="0" Cursor="Hand" Margin="-6,0,-6,-2"/>
        </Grid>
    </Border>
</Window>
"@

$reader = (New-Object System.Xml.XmlNodeReader $xaml)
$window = [System.Windows.Markup.XamlReader]::Load($reader)

$mainBorder = $window.FindName("MainBorder")
$progressTrack = $window.FindName("ProgressTrack")
$artContainer = $window.FindName("ArtContainer")
$infoPanel = $window.FindName("InfoPanel")
$txtTitle = $window.FindName("TxtTitle")
$txtArtist = $window.FindName("TxtArtist")
$btnPrev = $window.FindName("BtnPrev")
$btnPlayPause = $window.FindName("BtnPlayPause")
$pathPlayPause = $window.FindName("PathPlayPause")
$btnNext = $window.FindName("BtnNext")

# Context Menu
$cm = New-Object System.Windows.Controls.ContextMenu
$miHide = New-Object System.Windows.Controls.MenuItem
$miHide.Header = "Hide LabMedia"
$miHide.Add_Click({
    $evt = @{ event = "action"; type = "hide" }
    Write-Output ($evt | ConvertTo-Json -Compress)
    [Console]::Out.Flush()
    $window.Hide()
})
$miSettings = New-Object System.Windows.Controls.MenuItem
$miSettings.Header = "Open LabMedia Settings"
$miSettings.Add_Click({
    $evt = @{ event = "action"; type = "openSettings" }
    Write-Output ($evt | ConvertTo-Json -Compress)
    [Console]::Out.Flush()
})
$cm.Items.Add($miHide) | Out-Null
$cm.Items.Add($miSettings) | Out-Null
$window.ContextMenu = $cm

# Position Window on Taskbar
function Anchor-Taskbar {
    try {
        $tray = [LabMediaWin32.Native]::FindWindow("Shell_TrayWnd", $null)
        if ($tray -ne [IntPtr]::Zero) {
            $rect = New-Object LabMediaWin32.Native+RECT
            if ([LabMediaWin32.Native]::GetWindowRect($tray, [ref]$rect)) {
                $notify = [LabMediaWin32.Native]::FindWindowEx($tray, [IntPtr]::Zero, "TrayNotifyWnd", $null)
                $notifyRect = New-Object LabMediaWin32.Native+RECT
                $notifyLeft = $rect.Right - 200
                if ($notify -ne [IntPtr]::Zero -and [LabMediaWin32.Native]::GetWindowRect($notify, [ref]$notifyRect)) {
                    $notifyLeft = $notifyRect.Left
                }

                $wWidth = $window.Width
                $wHeight = 40
                $posX = $notifyLeft - $wWidth - 12
                $posY = $rect.Top + [Math]::Max(0, ($rect.Height - $wHeight) / 2)

                if ($posX -lt $rect.Left + 200) {
                    $posX = $rect.Right - $wWidth - 220
                }

                $window.Left = $posX
                $window.Top = $posY
            }
        }
    } catch {}
}

# Make window non-activating
$window.Add_SourceInitialized({
    $helper = New-Object System.Windows.Interop.WindowInteropHelper($window)
    $exStyle = [LabMediaWin32.Native]::GetWindowLong($helper.Handle, [LabMediaWin32.Native]::GWL_EXSTYLE)
    [LabMediaWin32.Native]::SetWindowLong($helper.Handle, [LabMediaWin32.Native]::GWL_EXSTYLE, $exStyle -bor [LabMediaWin32.Native]::WS_EX_TOOLWINDOW -bor [LabMediaWin32.Native]::WS_EX_NOACTIVATE)
    Anchor-Taskbar
})

# Bring App To Front function
$script:activeAppId = ""
function Bring-ActiveAppToFront {
    if (-not $script:activeAppId) { return }
    $appId = $script:activeAppId.ToLower()
    $procName = "Spotify"
    if ($appId.Contains("chrome")) { $procName = "chrome" }
    elseif ($appId.Contains("msedge") -or $appId.Contains("edge")) { $procName = "msedge" }
    elseif ($appId.Contains("firefox")) { $procName = "firefox" }
    elseif ($appId.Contains("brave")) { $procName = "brave" }
    elseif ($appId.Contains("opera")) { $procName = "opera" }

    try {
        $procs = Get-Process -Name $procName -ErrorAction SilentlyContinue
        foreach ($p in $procs) {
            if ($p.MainWindowHandle -ne [IntPtr]::Zero) {
                [LabMediaWin32.Native]::ShowWindow($p.MainWindowHandle, [LabMediaWin32.Native]::SW_RESTORE)
                [LabMediaWin32.Native]::SetForegroundWindow($p.MainWindowHandle)
                break
            }
        }
    } catch {}
}

$artContainer.Add_MouseLeftButtonDown({ Bring-ActiveAppToFront })
$infoPanel.Add_MouseLeftButtonDown({ Bring-ActiveAppToFront })

# Media Controls
function Send-MediaCommand($cmd) {
    try {
        $asyncMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        $mgr = Await-WinRT $asyncMgr ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        if ($mgr) {
            $sessions = $mgr.GetSessions()
            $s = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
            if (-not $s) { $s = $mgr.GetCurrentSession() }
            if (-not $s) { $s = $sessions | Select-Object -First 1 }

            if ($s) {
                if ($cmd -eq 'playPause') { $null = Await-WinRT ($s.TryTogglePlayPauseAsync()) ([bool]) }
                elseif ($cmd -eq 'next') { $null = Await-WinRT ($s.TrySkipNextAsync()) ([bool]) }
                elseif ($cmd -eq 'previous') { $null = Await-WinRT ($s.TrySkipPreviousAsync()) ([bool]) }
            }
        }
    } catch {}
}

$btnPlayPause.Add_Click({ Send-MediaCommand 'playPause' })
$btnPrev.Add_Click({ Send-MediaCommand 'previous' })
$btnNext.Add_Click({ Send-MediaCommand 'next' })

# Scroll Wheel Volume Control (Global PreviewMouseWheel over the entire widget Window)
$window.Add_PreviewMouseWheel({
    param($sender, $e)
    try {
        $delta = if ($e.Delta -gt 0) { 0.05 } else { -0.05 }
        $appHint = if ($script:activeAppId) { $script:activeAppId } else { "" }
        $null = [LabMediaWin32.AppVolume]::AdjustMediaVolume($appHint, $delta)
        $e.Handled = $true
    } catch {}
})

# Interactive Timeline Seeking
$script:currentDurationSec = 0
function Send-MediaSeek($targetSec) {
    try {
        $asyncMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        $mgr = Await-WinRT $asyncMgr ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        if ($mgr) {
            $sessions = $mgr.GetSessions()
            $s = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
            if (-not $s) { $s = $mgr.GetCurrentSession() }
            if (-not $s) { $s = $sessions | Select-Object -First 1 }

            if ($s) {
                $ticks = [long]($targetSec * [TimeSpan]::TicksPerSecond)
                $null = Await-WinRT ($s.TryChangePlaybackPositionAsync($ticks)) ([bool])
            }
        }
    } catch {}
}

if ($progressTrack) {
    $progressTrack.Add_MouseLeftButtonDown({
        param($sender, $e)
        try {
            $pos = $e.GetPosition($progressTrack)
            $totalWidth = $progressTrack.ActualWidth
            if ($totalWidth -gt 0 -and $script:currentDurationSec -gt 0) {
                $ratio = [Math]::Max(0.0, [Math]::Min(1.0, $pos.X / $totalWidth))
                $targetSec = $ratio * $script:currentDurationSec
                Send-MediaSeek $targetSec
            }
        } catch {}
    })
}

# Timer for SMTC Monitoring
$timer = New-Object System.Windows.Threading.DispatcherTimer
$timer.Interval = [TimeSpan]::FromMilliseconds(500)
$script:lastTitle = ""
$script:lastArtist = ""
$script:lastPlaying = $false

$timer.Add_Tick({
    Anchor-Taskbar
    if ($parentPid -gt 0) {
        $parent = Get-Process -Id $parentPid -ErrorAction SilentlyContinue
        if (-not $parent) {
            $window.Close()
            return
        }
    }

    try {
        $asyncMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
        $mgr = Await-WinRT $asyncMgr ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])
        $sessions = if ($mgr) { $mgr.GetSessions() } else { @() }

        $s = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
        if (-not $s -and $mgr) { $s = $mgr.GetCurrentSession() }
        if (-not $s -and $sessions.Count -gt 0) { $s = $sessions[0] }

        if ($s) {
            $asyncProps = $s.TryGetMediaPropertiesAsync()
            $props = Await-WinRT $asyncProps ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
            $pb = $s.GetPlaybackInfo()

            $title = if ($props -and $props.Title) { $props.Title } else { "Unknown Track" }
            $artist = if ($props -and $props.Artist) { $props.Artist } else { "" }
            $appId = if ($s.SourceAppUserModelId) { $s.SourceAppUserModelId } else { "Media Player" }
            $script:activeAppId = $appId

            if (-not $artist -and $title.Contains(" - ")) {
                $parts = $title.Split(@(" - "), 2, [System.StringSplitOptions]::RemoveEmptyEntries)
                if ($parts.Count -eq 2) {
                    $title = $parts[0].Trim()
                    $artist = $parts[1].Trim()
                }
            }
            if (-not $artist) { $artist = $appId }

            $isPlaying = ($pb -and $pb.PlaybackStatus -eq 'Playing')

            $txtTitle.Text = $title
            $txtArtist.Text = "$artist • " + (if ($isPlaying) { "Playing" } else { "Paused" })
            if ($pathPlayPause) {
                $pathPlayPause.Data = [System.Windows.Media.Geometry]::Parse(if ($isPlaying) { "M 6,5 H 10 V 19 H 6 Z M 14,5 H 18 V 19 H 14 Z" } else { "M 7,5 L 18,12 L 7,19 Z" })
            }

            try {
                $timeline = $s.GetTimelineProperties()
                if ($timeline) {
                    $posSec = $timeline.Position.TotalSeconds
                    $durSec = ($timeline.EndTime - $timeline.StartTime).TotalSeconds
                    if ($durSec -gt 0) {
                        $script:currentDurationSec = $durSec
                        if ($progressTrack) {
                            $percent = [Math]::Max(0.0, [Math]::Min(100.0, ($posSec / $durSec) * 100))
                            $progressTrack.Value = $percent
                        }
                    }
                }
            } catch {}

            if ($title -ne $script:lastTitle -or $artist -ne $script:lastArtist -or $isPlaying -ne $script:lastPlaying) {
                $script:lastTitle = $title
                $script:lastArtist = $artist
                $script:lastPlaying = $isPlaying

                $evt = @{
                    event = "session"
                    hasSession = $true
                    title = $title
                    artist = $artist
                    isPlaying = $isPlaying
                    sourceApp = $appId
                }
                Write-Output ($evt | ConvertTo-Json -Compress)
                [Console]::Out.Flush()
            }
        } else {
            $txtTitle.Text = "No Media Session"
            $txtArtist.Text = "Play Spotify, YouTube, or browser"
            if ($pathPlayPause) {
                $pathPlayPause.Data = [System.Windows.Media.Geometry]::Parse("M 7,5 L 18,12 L 7,19 Z")
            }

            if ($script:lastTitle -ne "") {
                $script:lastTitle = ""
                $script:lastArtist = ""
                $script:lastPlaying = $false
                $evt = @{ event = "session"; hasSession = $false }
                Write-Output ($evt | ConvertTo-Json -Compress)
                [Console]::Out.Flush()
            }
        }
    } catch {}
})

# Emit Ready Event to stdout
$readyObj = @{ event = "ready"; pid = $PID }
Write-Output ($readyObj | ConvertTo-Json -Compress)
[Console]::Out.Flush()

$timer.Start()
$window.ShowDialog() | Out-Null
