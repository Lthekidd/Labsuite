using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace LabMediaWidget
{
    [ComImport]
    [Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    public class MMDeviceEnumeratorComObject {}

    [ComImport]
    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDeviceEnumerator
    {
        [PreserveSig] int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr ppDevices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppDevice);
    }

    [ComImport]
    [Guid("D666063F-1587-4E43-81F1-B948E807363F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport]
    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    public interface IAudioSessionManager2
    {
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

    public static class AppVolume
    {
        [DllImport("user32.dll")]
        public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);

        public static float AdjustMediaVolume(string activeAppHint, float delta)
        {
            try
            {
                IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)new MMDeviceEnumeratorComObject();
                IMMDevice? device;
                if (enumerator.GetDefaultAudioEndpoint(0, 0, out device) == 0 && device != null)
                {
                    Guid IID_IAudioSessionManager2 = typeof(IAudioSessionManager2).GUID;
                    object sessionManagerObj;
                    if (device.Activate(ref IID_IAudioSessionManager2, 1, IntPtr.Zero, out sessionManagerObj) == 0 && sessionManagerObj != null)
                    {
                        IAudioSessionManager2 mgr = (IAudioSessionManager2)sessionManagerObj;
                        IntPtr enumPtr;
                        if (mgr.GetSessionEnumerator(out enumPtr) == 0 && enumPtr != IntPtr.Zero)
                        {
                            IntPtr enumVtbl = Marshal.ReadIntPtr(enumPtr);
                            IntPtr getCountPtr = Marshal.ReadIntPtr(enumVtbl, 3 * IntPtr.Size);
                            IntPtr getSessionPtr = Marshal.ReadIntPtr(enumVtbl, 4 * IntPtr.Size);

                            GetCountDelegate getCount = (GetCountDelegate)Marshal.GetDelegateForFunctionPointer(getCountPtr, typeof(GetCountDelegate));
                            GetSessionDelegate getSession = (GetSessionDelegate)Marshal.GetDelegateForFunctionPointer(getSessionPtr, typeof(GetSessionDelegate));

                            int count = 0;
                            getCount(enumPtr, out count);

                            bool adjustedAny = false;
                            for (int i = 0; i < count; i++)
                            {
                                IntPtr ctrlPtr;
                                if (getSession(enumPtr, i, out ctrlPtr) == 0 && ctrlPtr != IntPtr.Zero)
                                {
                                    Guid iidCtrl2 = new Guid("bfb962ee-9719-4635-972d-11a248e55e6a");
                                    IntPtr ctrl2Ptr;
                                    int hrQ2 = Marshal.QueryInterface(ctrlPtr, ref iidCtrl2, out ctrl2Ptr);

                                    Guid iidVol = new Guid("87017A66-5343-4165-894E-577265F76C2A");
                                    IntPtr volPtr;
                                    int hrQVol = Marshal.QueryInterface(ctrlPtr, ref iidVol, out volPtr);

                                    if (hrQVol == 0 && volPtr != IntPtr.Zero)
                                    {
                                        string pName = "";
                                        if (hrQ2 == 0 && ctrl2Ptr != IntPtr.Zero)
                                        {
                                            IntPtr ctrl2Vtbl = Marshal.ReadIntPtr(ctrl2Ptr);
                                            IntPtr getPidPtr = Marshal.ReadIntPtr(ctrl2Vtbl, 14 * IntPtr.Size);
                                            GetProcessIdDelegate getPid = (GetProcessIdDelegate)Marshal.GetDelegateForFunctionPointer(getPidPtr, typeof(GetProcessIdDelegate));
                                            uint pid = 0;
                                            getPid(ctrl2Ptr, out pid);
                                            try { pName = Process.GetProcessById((int)pid).ProcessName; } catch { }
                                        }

                                        bool isMatch = false;
                                        if (!string.IsNullOrEmpty(activeAppHint) && pName.Length > 0)
                                        {
                                            if (pName.IndexOf(activeAppHint, StringComparison.OrdinalIgnoreCase) >= 0 || activeAppHint.IndexOf(pName, StringComparison.OrdinalIgnoreCase) >= 0)
                                            {
                                                isMatch = true;
                                            }
                                        }
                                        if (!isMatch && pName.Length > 0)
                                        {
                                            if (pName.IndexOf("spotify", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("chrome", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("msedge", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("firefox", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("brave", StringComparison.OrdinalIgnoreCase) >= 0 ||
                                                pName.IndexOf("opera", StringComparison.OrdinalIgnoreCase) >= 0)
                                            {
                                                isMatch = true;
                                            }
                                        }

                                        if (isMatch)
                                        {
                                            IntPtr volVtbl = Marshal.ReadIntPtr(volPtr);
                                            IntPtr setVolPtr = Marshal.ReadIntPtr(volVtbl, 3 * IntPtr.Size);
                                            IntPtr getVolPtr = Marshal.ReadIntPtr(volVtbl, 4 * IntPtr.Size);

                                            SetMasterVolumeDelegate setVol = (SetMasterVolumeDelegate)Marshal.GetDelegateForFunctionPointer(setVolPtr, typeof(SetMasterVolumeDelegate));
                                            GetMasterVolumeDelegate getVol = (GetMasterVolumeDelegate)Marshal.GetDelegateForFunctionPointer(getVolPtr, typeof(GetMasterVolumeDelegate));

                                            float currentVol = 0;
                                            getVol(volPtr, out currentVol);
                                            float newVol = Math.Clamp(currentVol + delta, 0.0f, 1.0f);
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
            }
            catch { }

            byte vk = (delta > 0) ? (byte)0xAF : (byte)0xAE;
            keybd_event(vk, 0, 0, UIntPtr.Zero);
            keybd_event(vk, 0, 2, UIntPtr.Zero);
            return 0.0f;
        }
    }
}
