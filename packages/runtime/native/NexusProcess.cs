using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// A per-app job provides work-conserving CPU shares for the whole process tree.
// It deliberately sets no job memory cap and no kill-on-job-close flag.
internal static class NexusProcess {
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct Startup { public int cb; public string reserved, desktop, title; public int x,y,xSize,ySize,xChars,yChars,fill,flags; public short show,reserved2; public IntPtr reservedPtr,input,output,error; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr process,thread; public int pid,tid; }
    [StructLayout(LayoutKind.Sequential)] struct Cpu { public uint flags, value; }
    [StructLayout(LayoutKind.Sequential)] struct Security { public int length; public IntPtr descriptor; [MarshalAs(UnmanagedType.Bool)] public bool inherit; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref Cpu value, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr data, uint size, out uint returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool result);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern bool CreateProcess(string app, StringBuilder command, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref Startup startup, out ProcessInfo info);
    [DllImport("kernel32.dll")] static extern IntPtr GetStdHandle(int n);
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)] static extern IntPtr CreateFile(string name,uint access,uint share,ref Security security,uint disposition,uint flags,IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetExitCodeProcess(IntPtr handle, out uint code);
    [DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetProcessInformation(IntPtr process,int kind,ref uint priority,uint size);
    static string Quote(string value) {
        var result = new StringBuilder("\""); int slashes = 0;
        foreach (char ch in value) {
            if (ch == '\\') { slashes++; continue; }
            result.Append('\\', ch == '"' ? slashes * 2 + 1 : slashes); result.Append(ch); slashes = 0;
        }
        result.Append('\\', slashes * 2); return result.Append('"').ToString();
    }
    static void MemoryPriority(IntPtr job, uint priority) {
        // Membership is rechecked on an opened process handle, preventing PID reuse races.
        int size = 8 + IntPtr.Size * 65536;
        IntPtr data = Marshal.AllocHGlobal(size);
        try {
            uint returned;
            if (!QueryInformationJobObject(job, 3, data, (uint)size, out returned)) return;
            int count = Math.Min(65536, Marshal.ReadInt32(data, 4));
            for (int i=0; i<count; i++) {
                uint pid = unchecked((uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64());
                IntPtr process = OpenProcess(0x0200 | 0x1000, false, pid);
                if (process == IntPtr.Zero) continue;
                try { bool member; if (IsProcessInJob(process, job, out member) && member) SetProcessInformation(process, 0, ref priority, 4); }
                finally { CloseHandle(process); }
            }
        } finally { Marshal.FreeHGlobal(data); }
    }
    static int Main(string[] args) {
        if (args.Length < 2) return 2;
        uint weight;
        if (!uint.TryParse(args[0], out weight) || weight < 1 || weight > 9) return 2;
        IntPtr job = CreateJobObject(IntPtr.Zero, null);
        var cpu = new Cpu { flags = 3, value = weight }; // ENABLE | WEIGHT_BASED, never HARD_CAP
        if (job == IntPtr.Zero || !SetInformationJobObject(job, 15, ref cpu, 8)) {
            Console.Error.WriteLine("Nexus: CPU sharing is unavailable; Windows default scheduling will be used.");
        }
        var security = new Security { length = Marshal.SizeOf(typeof(Security)), inherit = true };
        IntPtr input = CreateFile("NUL", 0x80000000, 3, ref security, 3, 0, IntPtr.Zero);
        var startup = new Startup { cb = Marshal.SizeOf(typeof(Startup)), flags = 0x100, input = input, output = GetStdHandle(-11), error = GetStdHandle(-12) };
        var command = new StringBuilder();
        for (int i=1; i<args.Length; i++) { if (i>1) command.Append(' '); command.Append(Quote(args[i])); }
        ProcessInfo child;
        if (!CreateProcess(args[1], command, IntPtr.Zero, IntPtr.Zero, true, 0x08000004, IntPtr.Zero, Environment.CurrentDirectory, ref startup, out child)) {
            Console.Error.WriteLine("Nexus: application launch failed: " + new Win32Exception(Marshal.GetLastWin32Error()).Message);
            if (job != IntPtr.Zero) CloseHandle(job); CloseHandle(input); return 1;
        }
        bool assigned = job != IntPtr.Zero && AssignProcessToJobObject(job, child.process);
        if (!assigned) Console.Error.WriteLine("Nexus: process-tree sharing is unavailable; Windows default scheduling will be used.");
        if (ResumeThread(child.thread) == 0xffffffff) {
            TerminateProcess(child.process, 1); CloseHandle(child.thread); CloseHandle(child.process); CloseHandle(input);
            Console.Error.WriteLine("Nexus: could not resume the application process."); return 1;
        }
        CloseHandle(child.thread); CloseHandle(input);
        // stdin is a private control pipe; it is never inherited by the application.
        var control = new Thread(() => {
            try {
                string line;
                while ((line = Console.ReadLine()) != null) {
                    if (assigned && (line == "memory:2" || line == "memory:5")) MemoryPriority(job, line == "memory:2" ? 2u : 5u);
                }
            } catch (System.IO.IOException) { }
        });
        control.IsBackground = true; control.Start();
        WaitForSingleObject(child.process, 0xffffffff);
        uint code; GetExitCodeProcess(child.process, out code); CloseHandle(child.process);
        // Process exit closes the job handle. No helper failure terminates the app tree.
        return unchecked((int)code);
    }
}
