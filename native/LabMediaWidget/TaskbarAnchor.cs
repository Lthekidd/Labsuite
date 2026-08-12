using System;
using System.Diagnostics;
using System.Windows.Automation;
using Microsoft.Win32;

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

                var anchors = ReadTaskbarAnchors(taskbar);
                if (!anchors.Ok)
                    return info;

                int leftPx;
                int rightLimitPx;
                bool isLeftAligned = IsTaskbarLeftAligned();
                if (!isLeftAligned)
                {
                    if (!anchors.StartLeft.HasValue)
                        return info;

                    // Centered taskbar: use the real Widgets/Start bounds. With
                    // Widgets disabled, the physical left edge is the safe anchor.
                    leftPx = anchors.WidgetsRight.HasValue
                        ? (int)Math.Ceiling(anchors.WidgetsRight.Value) + 8
                        : taskbarRect.Left + 12;
                    rightLimitPx = (int)Math.Floor(anchors.StartLeft.Value) - 8;
                }
                else
                {
                    // Left aligned: right-align before the notification area and
                    // require a trustworthy end bound for Start/task buttons.
                    int? notifyLeft = NativeMethods.GetTrayNotifyLeft(taskbar);
                    if (!notifyLeft.HasValue)
                        return info;
                    double? taskButtonsEnd = anchors.TaskButtonsRight ?? anchors.StartRight;
                    if (!taskButtonsEnd.HasValue)
                        return info;
                    int taskButtonsRight = (int)Math.Ceiling(taskButtonsEnd.Value);
                    leftPx = notifyLeft.Value - 8 - requestedWidthPx;
                    rightLimitPx = notifyLeft.Value - 8;
                    if (leftPx < taskButtonsRight + 8)
                        return info;
                }

                if (rightLimitPx - leftPx < requestedWidthPx)
                    return info;

                int topPx = taskbarRect.Bottom - taskbarBandPx
                    + Math.Max(0, (taskbarBandPx - requestedHeightPx) / 2);

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

        private static bool IsTaskbarLeftAligned()
        {
            // Windows 10 has no TaskbarAl value and always uses the classic
            // left-aligned taskbar. A missing value only means centered on 11.
            if (Environment.OSVersion.Version.Build < 22000) return true;

            try
            {
                using var key = Registry.CurrentUser.OpenSubKey(
                    @"Software\Microsoft\Windows\CurrentVersion\Explorer\Advanced");
                return key?.GetValue("TaskbarAl") is int value && value == 0;
            }
            catch
            {
                return false;
            }
        }

        private static (bool Ok, double? WidgetsRight, double? StartLeft, double? StartRight,
            double? TaskButtonsRight) ReadTaskbarAnchors(IntPtr taskbar)
        {
            double? startLeft = null;
            double? startRight = null;
            double? taskButtonsRight = NativeMethods.GetLegacyTaskButtonsRight(taskbar);

            var nativeStart = NativeMethods.GetStartButtonBounds(taskbar);
            if (nativeStart.HasValue)
            {
                startLeft = nativeStart.Value.Left;
                startRight = nativeStart.Value.Right;
            }

            try
            {
                var root = AutomationElement.FromHandle(taskbar);
                var widgets = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "WidgetsButton"));
                var start = root.FindFirst(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.AutomationIdProperty, "StartButton"));

                double? widgetsRight = null;

                if (widgets != null)
                {
                    var bounds = widgets.Current.BoundingRectangle;
                    if (!bounds.IsEmpty) widgetsRight = bounds.Right;
                }

                if (start != null)
                {
                    var bounds = start.Current.BoundingRectangle;
                    if (!bounds.IsEmpty)
                    {
                        startLeft = bounds.Left;
                        startRight = bounds.Right;
                    }
                }

                var buttons = root.FindAll(TreeScope.Descendants,
                    new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Button));
                foreach (AutomationElement button in buttons)
                {
                    try
                    {
                        string className = button.Current.ClassName ?? string.Empty;
                        if (!className.StartsWith("Taskbar.TaskListButton", StringComparison.Ordinal))
                            continue;
                        var bounds = button.Current.BoundingRectangle;
                        if (!bounds.IsEmpty && (!taskButtonsRight.HasValue || bounds.Right > taskButtonsRight.Value))
                            taskButtonsRight = bounds.Right;
                    }
                    catch { }
                }

                return (true, widgetsRight, startLeft, startRight, taskButtonsRight);
            }
            catch
            {
                // Windows 10's classic taskbar does not expose its buttons via
                // UI Automation. Native Start/MSAA bounds remain authoritative.
                return (startLeft.HasValue, null, startLeft, startRight, taskButtonsRight);
            }
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
