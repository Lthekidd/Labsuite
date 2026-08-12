param(
    [string]$action = 'playPause',
    [double]$positionSeconds = 0
)

$ErrorActionPreference = 'SilentlyContinue'
$code = @"
using System;
using System.Runtime.InteropServices;
public class Vol {
    [DllImport("user32.dll")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);
    public static void Up() { keybd_event(0xAF, 0, 0, UIntPtr.Zero); keybd_event(0xAF, 0, 2, UIntPtr.Zero); }
    public static void Down() { keybd_event(0xAE, 0, 0, UIntPtr.Zero); keybd_event(0xAE, 0, 2, UIntPtr.Zero); }
}
"@
Add-Type -TypeDefinition $code -ErrorAction SilentlyContinue

if ($action -eq 'volumeUp') {
    [Vol]::Up()
    exit
} elseif ($action -eq 'volumeDown') {
    [Vol]::Down()
    exit
}

$null = [System.Reflection.Assembly]::LoadWithPartialName("System.Runtime.WindowsRuntime")
[void][Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media, ContentType=WindowsRuntime]

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

try {
    $asyncMgr = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()
    $mgr = Await-WinRT $asyncMgr ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

    if ($mgr) {
        $sessions = $mgr.GetSessions()
        $s = $sessions | Where-Object { $_.GetPlaybackInfo().PlaybackStatus -eq 'Playing' } | Select-Object -First 1
        if (-not $s) { $s = $mgr.GetCurrentSession() }
        if (-not $s) { $s = $sessions | Select-Object -First 1 }

        if ($s) {
            if ($action -eq 'playPause') {
                $asyncAct = $s.TryTogglePlayPauseAsync()
                $res = Await-WinRT $asyncAct ([bool])
            } elseif ($action -eq 'next') {
                $asyncAct = $s.TrySkipNextAsync()
                $res = Await-WinRT $asyncAct ([bool])
            } elseif ($action -eq 'previous') {
                $asyncAct = $s.TrySkipPreviousAsync()
                $res = Await-WinRT $asyncAct ([bool])
            } elseif ($action -eq 'seek') {
                $ticks = [long]($positionSeconds * [TimeSpan]::TicksPerSecond)
                $asyncAct = $s.TryChangePlaybackPositionAsync($ticks)
                $res = Await-WinRT $asyncAct ([bool])
            }
        }
    }
} catch {}
