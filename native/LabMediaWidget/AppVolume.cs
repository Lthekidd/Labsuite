using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LabMediaWidget
{
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

    // COM interface inheritance is deliberately flattened. This preserves the
    // native vtable order without reading or invoking function pointers by hand.
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
        [DllImport("user32.dll")]
        private static extern void keybd_event(byte virtualKey, byte scanCode, uint flags, UIntPtr extraInfo);

        public static float AdjustMediaVolume(string activeAppHint, float delta)
        {
            IMMDeviceEnumerator? deviceEnumerator = null;
            IMMDevice? device = null;
            object? sessionManagerObject = null;
            IAudioSessionEnumerator? sessionEnumerator = null;

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
                    IAudioSessionControl? session = null;
                    try
                    {
                        if (sessionEnumerator.GetSession(i, out session) < 0 || session == null
                            || session is not IAudioSessionControl2 session2
                            || session is not ISimpleAudioVolume volume
                            || session2.GetProcessId(out uint processId) < 0)
                            continue;

                        string processName = "";
                        try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }
                        if (!IsMediaProcess(processName, activeAppHint))
                            continue;

                        if (volume.GetMasterVolume(out float currentVolume) < 0)
                            continue;

                        float newVolume = Math.Clamp(currentVolume + delta, 0.0f, 1.0f);
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
            catch (COMException)
            {
                return 0.0f;
            }
            catch (InvalidCastException)
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

        public static float GetMediaVolume(string activeAppHint)
        {
            IMMDeviceEnumerator? deviceEnumerator = null;
            IMMDevice? device = null;
            object? sessionManagerObject = null;
            IAudioSessionEnumerator? sessionEnumerator = null;

            try
            {
                deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                if (deviceEnumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0 || device == null)
                    return 1.0f;

                Guid managerId = typeof(IAudioSessionManager2).GUID;
                if (device.Activate(ref managerId, 1, IntPtr.Zero, out sessionManagerObject) < 0
                    || sessionManagerObject is not IAudioSessionManager2 manager)
                    return 1.0f;

                if (manager.GetSessionEnumerator(out sessionEnumerator) < 0 || sessionEnumerator == null
                    || sessionEnumerator.GetCount(out int sessionCount) < 0)
                    return 1.0f;

                for (int i = 0; i < sessionCount; i++)
                {
                    IAudioSessionControl? session = null;
                    try
                    {
                        if (sessionEnumerator.GetSession(i, out session) < 0 || session == null
                            || session is not IAudioSessionControl2 session2
                            || session is not ISimpleAudioVolume volume
                            || session2.GetProcessId(out uint processId) < 0)
                            continue;

                        string processName = "";
                        try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }
                        if (!IsMediaProcess(processName, activeAppHint))
                            continue;

                        if (volume.GetMasterVolume(out float level) >= 0)
                            return level;
                    }
                    finally
                    {
                        ReleaseComObject(session);
                    }
                }

                return 1.0f;
            }
            catch
            {
                return 1.0f;
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

            // When an active session app hint is provided, strictly target ONLY the process
            // corresponding to the active session currently displayed on the taskbar widget.
            if (!string.IsNullOrWhiteSpace(activeAppHint))
            {
                string hint = activeAppHint.Trim().ToLowerInvariant();
                string name = processName.ToLowerInvariant();

                if (hint.Contains("spotify") && name.Contains("spotify")) return true;
                if ((hint.Contains("chrome") || hint.Contains("youtube")) && name.Contains("chrome")) return true;
                if ((hint.Contains("edge") || hint.Contains("msedge")) && name.Contains("msedge")) return true;
                if (hint.Contains("firefox") && name.Contains("firefox")) return true;
                if (hint.Contains("brave") && name.Contains("brave")) return true;
                if (hint.Contains("opera") && name.Contains("opera")) return true;
                if (hint.Contains("vlc") && name.Contains("vlc")) return true;

                if (name.Contains(hint) || hint.Contains(name)) return true;

                return false;
            }

            string fallbackName = processName.ToLowerInvariant();
            return fallbackName.Contains("spotify") ||
                   fallbackName.Contains("chrome") ||
                   fallbackName.Contains("msedge") ||
                   fallbackName.Contains("firefox") ||
                   fallbackName.Contains("brave") ||
                   fallbackName.Contains("opera") ||
                   fallbackName.Contains("vlc") ||
                   fallbackName.Contains("wmplayer");
        }

        private static void ReleaseComObject(object? value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); } catch { }
        }
    }
}
