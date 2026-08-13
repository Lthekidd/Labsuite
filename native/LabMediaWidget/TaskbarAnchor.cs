using System;
using System.Diagnostics;

namespace LabMediaWidget
{
    public struct TaskbarInfo
    {
        public bool IsVisible;
        public bool HasSufficientSpace;
        public bool IsAutoHide;
        public IntPtr TaskbarHwnd;
        public int X;
        public int Y;
        public int Width;
        public int Height;
    }

    public static class TaskbarAnchor
    {
        public static TaskbarInfo CalculatePosition(double requestedWidthDip, double requestedHeightDip)
        {
            var info = new TaskbarInfo();

            try
            {
                IntPtr taskbar = NativeMethods.FindWindow("Shell_TrayWnd", null);
                if (taskbar == IntPtr.Zero || !NativeMethods.GetWindowRect(taskbar, out NativeMethods.RECT taskbarRect))
                    return info;

                info.TaskbarHwnd = taskbar;
                info.IsAutoHide = NativeMethods.IsAutoHideEnabled();

                uint dpi = NativeMethods.GetDpiForWindow(taskbar);
                if (dpi == 0) dpi = 96;
                double scale = dpi / 96.0;
                int requestedWidthPx = Math.Max(1, (int)Math.Round(requestedWidthDip * scale));
                int requestedHeightPx = Math.Max(1, (int)Math.Round(requestedHeightDip * scale));

                IntPtr monitor = NativeMethods.MonitorFromWindow(taskbar, NativeMethods.MONITOR_DEFAULTTONEAREST);
                var monitorInfo = new NativeMethods.MONITORINFO
                {
                    cbSize = System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.MONITORINFO>()
                };
                if (monitor == IntPtr.Zero || !NativeMethods.GetMonitorInfo(monitor, ref monitorInfo))
                    return info;

                int visibleTaskbarPx = Math.Min(taskbarRect.Bottom, monitorInfo.rcMonitor.Bottom)
                    - Math.Max(taskbarRect.Top, monitorInfo.rcMonitor.Top);
                if (visibleTaskbarPx <= 8)
                    return info; // auto-hidden or outside the primary monitor

                int taskbarHeightPx = taskbarRect.Height;
                int reservedPx = monitorInfo.rcMonitor.Bottom - monitorInfo.rcWork.Bottom;
                int taskbarBandPx = reservedPx > 8
                    ? Math.Min(taskbarHeightPx, reservedPx)
                    : Math.Min(taskbarHeightPx, (int)Math.Round(48 * scale));
                if (visibleTaskbarPx < taskbarBandPx - 4 || requestedHeightPx > taskbarBandPx)
                    return info; // wait until an auto-hide animation has settled

                int? notifyLeft = NativeMethods.GetTrayNotifyLeft(taskbar);
                int rightBound = notifyLeft.HasValue ? notifyLeft.Value : taskbarRect.Right - 200;

                int leftPx = rightBound - 12 - requestedWidthPx;
                int topPx = taskbarRect.Bottom - taskbarBandPx + Math.Max(0, (taskbarBandPx - requestedHeightPx) / 2);

                info.X = leftPx;
                info.Y = topPx;
                info.Width = requestedWidthPx;
                info.Height = requestedHeightPx;
                info.HasSufficientSpace = true;
                info.IsVisible = true;
            }
            catch
            {
                // UI Automation can fail transiently while Explorer rebuilds the
                // taskbar. Hiding is safer than placing over unknown controls.
            }

            return info;
        }

        public static bool IsForegroundFullscreen(IntPtr self, IntPtr taskbar)
        {
            try
            {
                // With auto-hide, maximized windows cover the monitor and look
                // fullscreen; taskbar visibility already controls the widget.
                if (NativeMethods.IsAutoHideEnabled()) return false;

                IntPtr foreground = NativeMethods.GetForegroundWindow();
                if (foreground == IntPtr.Zero || foreground == self || foreground == taskbar)
                    return false;

                string className = NativeMethods.GetWindowClassName(foreground);
                if (className is "Progman" or "WorkerW" or "Shell_TrayWnd" or "Shell_SecondaryTrayWnd"
                    or "XamlExplorerHostIslandWindow")
                    return false;

                IntPtr foregroundMonitor = NativeMethods.MonitorFromWindow(
                    foreground, NativeMethods.MONITOR_DEFAULTTONEAREST);
                IntPtr taskbarMonitor = NativeMethods.MonitorFromWindow(
                    taskbar, NativeMethods.MONITOR_DEFAULTTONEAREST);
                if (foregroundMonitor == IntPtr.Zero || foregroundMonitor != taskbarMonitor)
                    return false;

                if (!NativeMethods.GetWindowRect(foreground, out NativeMethods.RECT windowRect))
                    return false;
                var monitorInfo = new NativeMethods.MONITORINFO
                {
                    cbSize = System.Runtime.InteropServices.Marshal.SizeOf<NativeMethods.MONITORINFO>()
                };
                if (!NativeMethods.GetMonitorInfo(foregroundMonitor, ref monitorInfo))
                    return false;

                bool coversMonitor = windowRect.Left <= monitorInfo.rcMonitor.Left
                    && windowRect.Top <= monitorInfo.rcMonitor.Top
                    && windowRect.Right >= monitorInfo.rcMonitor.Right
                    && windowRect.Bottom >= monitorInfo.rcMonitor.Bottom;
                if (!coversMonitor) return false;

                if (className is "Windows.UI.Core.CoreWindow" or "ApplicationFrameWindow")
                {
                    NativeMethods.GetWindowThreadProcessId(foreground, out uint pid);
                    try
                    {
                        using var process = Process.GetProcessById((int)pid);
                        if (process.ProcessName is "explorer" or "StartMenuExperienceHost" or "SearchHost"
                            or "ShellExperienceHost" or "ShellHost" or "SearchApp" or "SearchUI"
                            or "Cortana" or "LockApp" or "TextInputHost" or "ScreenClippingHost")
                            return false;
                    }
                    catch
                    {
                        return false;
                    }
                }

                return true;
            }
            catch
            {
                return false;
            }
        }
    }
}
