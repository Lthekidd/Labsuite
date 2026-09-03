using System;
using System.Collections.Generic;
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

    [ComImport]
    [Guid("5BC64874-384D-4946-8098-220F49F31E00")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IAudioEndpointVolume
    {
        [PreserveSig] int RegisterControlChangeNotify(IntPtr client);
        [PreserveSig] int UnregisterControlChangeNotify(IntPtr client);
        [PreserveSig] int GetChannelCount(out uint channelCount);
        [PreserveSig] int SetMasterVolumeLevel(float levelDb, [In] ref Guid eventContext);
        [PreserveSig] int SetMasterVolumeLevelScalar(float level, [In] ref Guid eventContext);
        [PreserveSig] int GetMasterVolumeLevel(out float levelDb);
        [PreserveSig] int GetMasterVolumeLevelScalar(out float level);
        [PreserveSig] int SetChannelVolumeLevel(uint channelNumber, float levelDb, [In] ref Guid eventContext);
        [PreserveSig] int SetChannelVolumeLevelScalar(uint channelNumber, float level, [In] ref Guid eventContext);
        [PreserveSig] int GetChannelVolumeLevel(uint channelNumber, out float levelDb);
        [PreserveSig] int GetChannelVolumeLevelScalar(uint channelNumber, out float level);
        [PreserveSig] int SetMute([MarshalAs(UnmanagedType.Bool)] bool isMuted, [In] ref Guid eventContext);
        [PreserveSig] int GetMute([MarshalAs(UnmanagedType.Bool)] out bool isMuted);
        [PreserveSig] int GetVolumeStepInfo(out uint step, out uint stepCount);
        [PreserveSig] int VolumeStepUp([In] ref Guid eventContext);
        [PreserveSig] int VolumeStepDown([In] ref Guid eventContext);
        [PreserveSig] int QueryHardwareSupport(out uint hardwareSupportMask);
        [PreserveSig] int GetVolumeRange(out float volumeMinDb, out float volumeMaxDb, out float volumeIncrementDb);
    }

    public static class AppVolume
    {
        private static readonly object AudioGate = new object();

        public static float AdjustMediaVolume(string activeAppHint, float delta)
        {
            lock (AudioGate)
            {
                float adjustedLevel = -1.0f;
                bool adjusted = false;

                if (!string.IsNullOrWhiteSpace(activeAppHint))
                {
                    adjusted = VisitMatchingVolumes(activeAppHint, volume =>
                    {
                        if (volume.GetMasterVolume(out float current) < 0) return false;
                        float next = Math.Clamp(current + delta, 0.0f, 1.0f);
                        Guid context = Guid.Empty;
                        if (volume.SetMasterVolume(next, ref context) < 0) return false;
                        adjustedLevel = next;
                        return true;
                    });
                }

                if (adjusted)
                {
                    return adjustedLevel;
                }

                // Fallback to master volume
                bool fallbackSuccess = WithMasterEndpointVolume(master =>
                {
                    if (master.GetMasterVolumeLevelScalar(out float current) < 0) return false;
                    float next = Math.Clamp(current + delta, 0.0f, 1.0f);
                    Guid context = Guid.Empty;
                    if (master.SetMasterVolumeLevelScalar(next, ref context) < 0) return false;
                    adjustedLevel = next;
                    return true;
                });

                return fallbackSuccess ? adjustedLevel : -1.0f;
            }
        }

        public static float GetMediaVolume(string activeAppHint)
        {
            lock (AudioGate)
            {
                float result = 1.0f;
                bool found = false;

                if (!string.IsNullOrWhiteSpace(activeAppHint))
                {
                    found = VisitMatchingVolumes(activeAppHint, volume =>
                    {
                        if (volume.GetMasterVolume(out float level) < 0) return false;
                        result = level;
                        return true;
                    }, stopAfterSuccess: true);
                }

                if (found)
                {
                    return result;
                }

                float masterLevel = 1.0f;
                bool fallbackSuccess = WithMasterEndpointVolume(master =>
                {
                    if (master.GetMasterVolumeLevelScalar(out float level) < 0) return false;
                    masterLevel = level;
                    return true;
                });

                return fallbackSuccess ? masterLevel : 1.0f;
            }
        }

        public static bool SetMediaVolume(string activeAppHint, float level)
        {
            lock (AudioGate)
            {
                float clamped = Math.Clamp(level, 0.0f, 1.0f);
                bool applied = false;

                if (!string.IsNullOrWhiteSpace(activeAppHint))
                {
                    applied = VisitMatchingVolumes(activeAppHint, volume =>
                    {
                        Guid context = Guid.Empty;
                        return volume.SetMasterVolume(clamped, ref context) >= 0;
                    });
                }

                if (applied)
                {
                    return true;
                }

                return WithMasterEndpointVolume(master =>
                {
                    Guid context = Guid.Empty;
                    return master.SetMasterVolumeLevelScalar(clamped, ref context) >= 0;
                });
            }
        }

        public static bool GetMediaMute(string activeAppHint)
        {
            lock (AudioGate)
            {
                bool muted = false;
                bool found = false;

                if (!string.IsNullOrWhiteSpace(activeAppHint))
                {
                    found = VisitMatchingVolumes(activeAppHint, volume => volume.GetMute(out muted) >= 0, stopAfterSuccess: true);
                }

                if (found)
                {
                    return muted;
                }

                bool fallbackSuccess = WithMasterEndpointVolume(master => master.GetMute(out muted) >= 0);
                return fallbackSuccess ? muted : false;
            }
        }

        public static bool SetMediaMute(string activeAppHint, bool muted)
        {
            lock (AudioGate)
            {
                bool applied = false;

                if (!string.IsNullOrWhiteSpace(activeAppHint))
                {
                    applied = VisitMatchingVolumes(activeAppHint, volume =>
                    {
                        Guid context = Guid.Empty;
                        return volume.SetMute(muted, ref context) >= 0;
                    });
                }

                if (applied)
                {
                    return true;
                }

                return WithMasterEndpointVolume(master =>
                {
                    Guid context = Guid.Empty;
                    return master.SetMute(muted, ref context) >= 0;
                });
            }
        }

        private static bool WithMasterEndpointVolume(Func<IAudioEndpointVolume, bool> action)
        {
            IMMDeviceEnumerator? deviceEnumerator = null;
            IMMDevice? device = null;
            object? endpointObject = null;
            try
            {
                deviceEnumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                if (deviceEnumerator.GetDefaultAudioEndpoint(0, 0, out device) < 0 || device == null)
                    return false;

                Guid endpointId = typeof(IAudioEndpointVolume).GUID;
                if (device.Activate(ref endpointId, 1, IntPtr.Zero, out endpointObject) < 0
                    || endpointObject is not IAudioEndpointVolume masterVolume)
                    return false;

                return action(masterVolume);
            }
            catch (COMException) { return false; }
            catch (InvalidCastException) { return false; }
            finally
            {
                ReleaseComObject(endpointObject);
                ReleaseComObject(device);
                ReleaseComObject(deviceEnumerator);
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
            var candidates = new List<(IAudioSessionControl session, ISimpleAudioVolume volume, int state)>();

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
                    if (sessionEnumerator.GetSession(i, out IAudioSessionControl session) < 0 || session == null)
                        continue;

                    if (session is not IAudioSessionControl2 session2
                        || session is not ISimpleAudioVolume volume
                        || session2.GetProcessId(out uint processId) < 0)
                    {
                        ReleaseComObject(session);
                        continue;
                    }

                    string processName = string.Empty;
                    try { processName = Process.GetProcessById((int)processId).ProcessName; } catch { }
                    if (!IsMediaProcess(processName, activeAppHint))
                    {
                        ReleaseComObject(session);
                        continue;
                    }

                    int state = 0;
                    session.GetState(out state);
                    candidates.Add((session, volume, state));
                }

                bool hasActive = candidates.Exists(c => c.state == 1);
                var targets = hasActive ? candidates.FindAll(c => c.state == 1) : candidates;

                foreach (var candidate in targets)
                {
                    if (visitor(candidate.volume))
                    {
                        anySuccess = true;
                        if (stopAfterSuccess) break;
                    }
                }
            }
            catch (COMException) { }
            catch (InvalidCastException) { }
            finally
            {
                foreach (var candidate in candidates)
                {
                    ReleaseComObject(candidate.session);
                }
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
            string name = processName.ToLowerInvariant().Replace(".exe", "").Trim();

            if (!string.IsNullOrWhiteSpace(activeAppHint))
            {
                string hint = activeAppHint.Trim().ToLowerInvariant().Replace(".exe", "");
                if (hint.Contains("spotify") && name.Contains("spotify")) return true;
                if ((hint.Contains("edge") || hint.Contains("msedge")) && name.Contains("msedge")) return true;
                if ((hint.Contains("firefox") || hint.Contains("308046b0af4a39cb") || hint.Contains("mozilla")) && name.Contains("firefox")) return true;
                if (hint.Contains("brave") && name.Contains("brave")) return true;
                if (hint.Contains("opera") && name.Contains("opera")) return true;
                if (hint.Contains("vlc") && name.Contains("vlc")) return true;
                if (hint.Contains("chrome") && name.Contains("chrome")) return true;
                if ((hint.Contains("applemusic") || hint.Contains("apple music") || hint.Contains("apple.music"))
                    && (name.Contains("applemusic") || name.Contains("apple music"))) return true;
                if (hint.Contains("youtube") && !HasBrowserIdentity(hint) && IsBrowserProcess(name)) return true;
                if ((hint.Contains("youtube") || hint.Contains("ytmusic") || hint.Contains("ytmdesktop") || hint.Contains("labsuite-music"))
                    && (name.Contains("ytm") || name.Contains("youtube") || name.Contains("labsuite-music") || IsBrowserProcess(name)))
                    return true;
                return name.Contains(hint) || hint.Contains(name);
            }

            return name.Contains("spotify") || name.Contains("chrome") || name.Contains("msedge")
                || name.Contains("firefox") || name.Contains("brave") || name.Contains("opera")
                || name.Contains("vlc") || name.Contains("wmplayer")
                || name.Contains("applemusic") || name.Contains("apple music");
        }

        private static bool IsBrowserProcess(string processName)
        {
            string name = processName.ToLowerInvariant();
            return name.Contains("chrome") || name.Contains("msedge")
                || name.Contains("firefox") || name.Contains("brave")
                || name.Contains("opera");
        }

        private static bool HasBrowserIdentity(string hint)
        {
            string h = hint.ToLowerInvariant();
            return h.Contains("chrome") || h.Contains("edge")
                || h.Contains("firefox") || h.Contains("brave")
                || h.Contains("opera") || h.Contains("308046b0af4a39cb")
                || h.Contains("mozilla");
        }

        private static void ReleaseComObject(object? value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); } catch { }
        }
    }
}
