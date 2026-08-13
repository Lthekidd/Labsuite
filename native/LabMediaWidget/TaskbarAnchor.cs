using System;
using System.Diagnostics;

namespace LabMediaWidget
{
    public enum TaskbarEdge
    {
        Bottom,
        Top,
        Left,
        Right
    }

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
        public uint Dpi;
        public TaskbarEdge Edge;
        public NativeMethods.RECT TaskbarBounds;
        public NativeMethods.RECT MonitorBounds;
        public NativeMethods.RECT WorkArea;
    }

    public struct FlyoutPosition
    {
        public bool IsValid;
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
                info.Dpi = dpi;
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

                info.TaskbarBounds = taskbarRect;
                info.MonitorBounds = monitorInfo.rcMonitor;
                info.WorkArea = monitorInfo.rcWork;
                info.Edge = DetermineEdge(taskbarRect, monitorInfo.rcMonitor);

                // The collapsed LabMedia strip is horizontal. Vertical taskbars
                // cannot safely accommodate it, so the widget waits rather than
                // covering taskbar controls. The flyout positioner supports all edges.
                if (info.Edge is TaskbarEdge.Left or TaskbarEdge.Right)
                    return info;

                int visibleTaskbarPx = Math.Min(taskbarRect.Bottom, monitorInfo.rcMonitor.Bottom)
                    - Math.Max(taskbarRect.Top, monitorInfo.rcMonitor.Top);
                if (visibleTaskbarPx <= 8)
                    return info; // auto-hidden or outside the primary monitor

                int taskbarBandPx = taskbarRect.Height;
                if (visibleTaskbarPx < taskbarBandPx - 4 || requestedHeightPx > taskbarBandPx)
                    return info; // wait until an auto-hide animation has settled

                int? notifyLeft = NativeMethods.GetTrayNotifyLeft(taskbar);
                int rightBound = notifyLeft.HasValue ? notifyLeft.Value : taskbarRect.Right - 200;

                int leftPx = rightBound - 12 - requestedWidthPx;
                int topPx = taskbarRect.Top + Math.Max(0, (taskbarBandPx - requestedHeightPx) / 2);

                info.X = leftPx;
                info.Y = topPx;
                info.Width = requestedWidthPx;
                info.Height = requestedHeightPx;
                info.HasSufficientSpace = true;
                info.IsVisible = true;
            }
            catch
            {
                // Explorer can rebuild taskbar handles during display changes.
                // Hiding is safer than placing over unknown controls.
            }

            return info;
        }

        public static FlyoutPosition CalculateFlyoutPosition(
            TaskbarInfo anchor,
            double requestedWidthDip,
            double requestedHeightDip,
            double gapDip = 8)
        {
            var result = new FlyoutPosition();
            if (anchor.TaskbarHwnd == IntPtr.Zero) return result;

            double scale = (anchor.Dpi == 0 ? 96 : anchor.Dpi) / 96.0;
            int width = Math.Max(1, (int)Math.Round(requestedWidthDip * scale));
            int height = Math.Max(1, (int)Math.Round(requestedHeightDip * scale));
            int gap = Math.Max(0, (int)Math.Round(gapDip * scale));
            var work = anchor.WorkArea;
            var taskbar = anchor.TaskbarBounds;

            width = Math.Min(width, Math.Max(1, work.Width));
            height = Math.Min(height, Math.Max(1, work.Height));

            int x;
            int y;
            switch (anchor.Edge)
            {
                case TaskbarEdge.Top:
                    x = anchor.X + anchor.Width - width;
                    y = taskbar.Bottom + gap;
                    break;
                case TaskbarEdge.Left:
                    x = taskbar.Right + gap;
                    y = anchor.Y + anchor.Height - height;
                    break;
                case TaskbarEdge.Right:
                    x = taskbar.Left - gap - width;
                    y = anchor.Y + anchor.Height - height;
                    break;
                default:
                    x = anchor.X + anchor.Width - width;
                    y = taskbar.Top - gap - height;
                    break;
            }

            result.X = Math.Clamp(x, work.Left, Math.Max(work.Left, work.Right - width));
            result.Y = Math.Clamp(y, work.Top, Math.Max(work.Top, work.Bottom - height));
            result.Width = width;
            result.Height = height;
            result.IsValid = true;
            return result;
        }

        private static TaskbarEdge DetermineEdge(NativeMethods.RECT taskbar, NativeMethods.RECT monitor)
        {
            if (taskbar.Width >= taskbar.Height)
            {
                int center = taskbar.Top + taskbar.Height / 2;
                return center < monitor.Top + monitor.Height / 2 ? TaskbarEdge.Top : TaskbarEdge.Bottom;
            }

            int horizontalCenter = taskbar.Left + taskbar.Width / 2;
            return horizontalCenter < monitor.Left + monitor.Width / 2 ? TaskbarEdge.Left : TaskbarEdge.Right;
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
