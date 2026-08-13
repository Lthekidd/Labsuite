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
        public static void VolUp() { keybd_event(0xAF, 0, 0, UIntPtr.Zero); keybd_event(0xAF, 0, 2, UIntPtr.Zero); }
        public static void VolDown() { keybd_event(0xAE, 0, 0, UIntPtr.Zero); keybd_event(0xAE, 0, 2, UIntPtr.Zero); }
    }

    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject {}

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2 {
        [PreserveSig] int M0();
        [PreserveSig] int M1();
        [PreserveSig] int GetSessionEnumerator(out IntPtr SessionEnum);
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int GetCountDelegate(IntPtr instance, out int count);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int GetSessionDelegate(IntPtr instance, int index, out IntPtr sessionControl);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int GetMasterVolumeDelegate(IntPtr instance, out float level);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int SetMasterVolumeDelegate(IntPtr instance, float level, ref Guid eventContext);

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    public delegate int GetProcessIdDelegate(IntPtr instance, out uint pid);

    public static class AppVolume {
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public static float AdjustMediaVolume(string activeAppHint, float delta) {
            try {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice device;
                if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) == 0 && device != null) {
                    Guid IID_IAudioSessionManager2 = typeof(IAudioSessionManager2).GUID;
                    object sessionManagerObj;
                    if (device.Activate(ref IID_IAudioSessionManager2, 1, IntPtr.Zero, out sessionManagerObj) == 0 && sessionManagerObj != null) {
                        IAudioSessionManager2 mgr = (IAudioSessionManager2)sessionManagerObj;
                        IntPtr enumPtr;
                        if (mgr.GetSessionEnumerator(out enumPtr) == 0 && enumPtr != IntPtr.Zero) {
                            IntPtr enumVtbl = Marshal.ReadIntPtr(enumPtr);
                            IntPtr getCountPtr = Marshal.ReadIntPtr(enumVtbl, 3 * IntPtr.Size);
                            IntPtr getSessionPtr = Marshal.ReadIntPtr(enumVtbl, 4 * IntPtr.Size);

                            GetCountDelegate getCount = (GetCountDelegate)Marshal.GetDelegateForFunctionPointer(getCountPtr, typeof(GetCountDelegate));
                            GetSessionDelegate getSession = (GetSessionDelegate)Marshal.GetDelegateForFunctionPointer(getSessionPtr, typeof(GetSessionDelegate));

                            int count = 0;
                            getCount(enumPtr, out count);

                            bool adjustedAny = false;
                            for (int i = 0; i < count; i++) {
                                IntPtr ctrlPtr;
                                if (getSession(enumPtr, i, out ctrlPtr) == 0 && ctrlPtr != IntPtr.Zero) {
                                    Guid iidCtrl2 = new Guid("bfb962ee-9719-4635-972d-11a248e55e6a");
                                    IntPtr ctrl2Ptr;
                                    int hrQ2 = Marshal.QueryInterface(ctrlPtr, ref iidCtrl2, out ctrl2Ptr);

                                    Guid iidVol = new Guid("87017A66-5343-4165-894E-577265F76C2A");
                                    IntPtr volPtr;
                                    int hrQVol = Marshal.QueryInterface(ctrlPtr, ref iidVol, out volPtr);

                                    if (hrQVol == 0 && volPtr != IntPtr.Zero) {
                                        string pName = "";
                                        if (hrQ2 == 0 && ctrl2Ptr != IntPtr.Zero) {
                                            IntPtr ctrl2Vtbl = Marshal.ReadIntPtr(ctrl2Ptr);
                                            IntPtr getPidPtr = Marshal.ReadIntPtr(ctrl2Vtbl, 14 * IntPtr.Size);
                                            GetProcessIdDelegate getPid = (GetProcessIdDelegate)Marshal.GetDelegateForFunctionPointer(getPidPtr, typeof(GetProcessIdDelegate));
                                            uint pid = 0;
                                            getPid(ctrl2Ptr, out pid);
                                            try { pName = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch {}
                                        }

                                        bool isMatch = false;
                                        if (!string.IsNullOrEmpty(activeAppHint) && pName.Length > 0) {
                                            if (pName.IndexOf(activeAppHint, StringComparison.OrdinalIgnoreCase) >= 0 || activeAppHint.IndexOf(pName, StringComparison.OrdinalIgnoreCase) >= 0) {
                                                isMatch = true;
                                            }
                                        }
                                        if (!isMatch && pName.Length > 0) {
                                            if (pName.IndexOf("spotify", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("msedge", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("firefox", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("brave", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("opera", StringComparison.OrdinalIgnoreCase) >= 0) {
                                                isMatch = true;
                                            }
                                        }

                                        if (isMatch) {
                                            IntPtr volVtbl = Marshal.ReadIntPtr(volPtr);
                                            IntPtr setVolPtr = Marshal.ReadIntPtr(volVtbl, 3 * IntPtr.Size);
                                            IntPtr getVolPtr = Marshal.ReadIntPtr(volVtbl, 4 * IntPtr.Size);

                                            SetMasterVolumeDelegate setVol = (SetMasterVolumeDelegate)Marshal.GetDelegateForFunctionPointer(setVolPtr, typeof(SetMasterVolumeDelegate));
                                            GetMasterVolumeDelegate getVol = (GetMasterVolumeDelegate)Marshal.GetDelegateForFunctionPointer(getVolPtr, typeof(GetMasterVolumeDelegate));

                                            float currentVol = 0;
                                            getVol(volPtr, out currentVol);
                                            float newVol = Math.Max(0.0f, Math.Min(1.0f, currentVol + delta));
                                            Guid empty = Guid.Empty;
                                            setVol(volPtr, newVol, ref empty);
                                            adjustedAny = true;
                                        }

                                        Marshal.Release(volPtr);
                                        if (ctrl2Ptr != IntPtr.Zero) Marshal.Release(ctrl2Ptr);
                                    }
                                    Marshal.Release(ctrlPtr);
                                }
                            }
                            Marshal.Release(enumPtr);
                            if (adjustedAny) return 1.0f;
                        }
                    }
                }
            } catch {}

            byte vk = (delta > 0) ? (byte)0xAF : (byte)0xAE;
            keybd_event(vk, 0, 0, UIntPtr.Zero);
            keybd_event(vk, 0, 2, UIntPtr.Zero);
            return 0.0f;
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
        if ($json.size -eq 'compact') { $targetWidth = 240 }
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
