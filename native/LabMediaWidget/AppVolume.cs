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
        int Activate(ref Guid iid, int classContext, IntPtr activationParameters,
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

    // Flattening the inherited native interface keeps COM vtable order explicit
    // without reading or invoking unmanaged function pointers by hand.
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
        private static readonly object AudioGate = new object();

        public static float AdjustMediaVolume(string activeAppHint, float delta)
        {
            lock (AudioGate)
            {
                float adjustedLevel = -1.0f;
                bool adjusted = VisitMatchingVolumes(activeAppHint, volume =>
                {
                    if (volume.GetMasterVolume(out float current) < 0) return false;
                    float next = Math.Clamp(current + delta, 0.0f, 1.0f);
                    Guid context = Guid.Empty;
                    if (volume.SetMasterVolume(next, ref context) < 0) return false;
                    adjustedLevel = next;
                    return true;
                });
                return adjusted ? adjustedLevel : -1.0f;
            }
        }

        public static float GetMediaVolume(string activeAppHint)
        {
            lock (AudioGate)
            {
                float result = 1.0f;
                VisitMatchingVolumes(activeAppHint, volume =>
                {
                    if (volume.GetMasterVolume(out float level) < 0) return false;
                    result = level;
                    return true;
                }, stopAfterSuccess: true);
                return result;
            }
        }

        public static bool SetMediaVolume(string activeAppHint, float level)
        {
            lock (AudioGate)
            {
                float clamped = Math.Clamp(level, 0.0f, 1.0f);
                return VisitMatchingVolumes(activeAppHint, volume =>
                {
                    Guid context = Guid.Empty;
                    return volume.SetMasterVolume(clamped, ref context) >= 0;
                });
            }
        }

        public static bool GetMediaMute(string activeAppHint)
        {
            lock (AudioGate)
            {
                bool muted = false;
                VisitMatchingVolumes(activeAppHint, volume => volume.GetMute(out muted) >= 0, stopAfterSuccess: true);
                return muted;
            }
        }

        public static bool SetMediaMute(string activeAppHint, bool muted)
        {
            lock (AudioGate)
            {
                return VisitMatchingVolumes(activeAppHint, volume =>
                {
                    Guid context = Guid.Empty;
                    return volume.SetMute(muted, ref context) >= 0;
                });
            }
        }

        private static bool VisitMatchingVolumes(
            string activeAppHint,
            Func<ISimpleAudioVolume, bool> visitor,
            bool stopAfterSuccess = false)
        {
            IMMDeviceEnumerator? deviceEnumerator = null;
            IMMDevice? device = null;
            object? managerObject = null;
            IAudioSessionEnumerator? sessionEnumerator = null;
            bool anySuccess = false;

            try
            {
                deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                if (deviceEnumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0 || device == null)
                    return false;

                Guid managerId = typeof(IAudioSessionManager2).GUID;
                if (device.Activate(ref managerId, 1, IntPtr.Zero, out managerObject) < 0
                    || managerObject is not IAudioSessionManager2 manager
                    || manager.GetSessionEnumerator(out sessionEnumerator) < 0
                    || sessionEnumerator == null
                    || sessionEnumerator.GetCount(out int sessionCount) < 0)
                    return false;

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

                        string processName = string.Empty;
                        try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }
                        if (!IsMediaProcess(processName, activeAppHint)) continue;

                        if (visitor(volume))
                        {
                            anySuccess = true;
                            if (stopAfterSuccess) break;
                        }
                    }
                    finally
                    {
                        ReleaseComObject(session);
                    }
                }
            }
            catch (COMException) { }
            catch (InvalidCastException) { }
            finally
            {
                ReleaseComObject(sessionEnumerator);
                ReleaseComObject(managerObject);
                ReleaseComObject(device);
                ReleaseComObject(deviceEnumerator);
            }

            return anySuccess;
        }

        private static bool IsMediaProcess(string processName, string activeAppHint)
        {
            if (string.IsNullOrWhiteSpace(processName)) return false;
            string name = processName.ToLowerInvariant();

            if (!string.IsNullOrWhiteSpace(activeAppHint))
            {
                string hint = activeAppHint.Trim().ToLowerInvariant();
                if (hint.Contains("spotify") && name.Contains("spotify")) return true;
                if ((hint.Contains("edge") || hint.Contains("msedge")) && name.Contains("msedge")) return true;
                if (hint.Contains("firefox") && name.Contains("firefox")) return true;
                if (hint.Contains("brave") && name.Contains("brave")) return true;
                if (hint.Contains("opera") && name.Contains("opera")) return true;
                if (hint.Contains("vlc") && name.Contains("vlc")) return true;
                if (hint.Contains("chrome") && name.Contains("chrome")) return true;
                if (hint.Contains("youtube") && !HasBrowserIdentity(hint) && IsBrowserProcess(name)) return true;
                return name.Contains(hint) || hint.Contains(name);
            }

            return name.Contains("spotify") || name.Contains("chrome") || name.Contains("msedge")
                || name.Contains("firefox") || name.Contains("brave") || name.Contains("opera")
                || name.Contains("vlc") || name.Contains("wmplayer");
        }

        private static bool IsBrowserProcess(string processName)
        {
            return processName.Contains("chrome") || processName.Contains("msedge")
                || processName.Contains("firefox") || processName.Contains("brave")
                || processName.Contains("opera");
        }

        private static bool HasBrowserIdentity(string hint)
        {
            return hint.Contains("chrome") || hint.Contains("edge")
                || hint.Contains("firefox") || hint.Contains("brave")
                || hint.Contains("opera");
        }

        private static void ReleaseComObject(object? value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); } catch { }
        }
    }
}
