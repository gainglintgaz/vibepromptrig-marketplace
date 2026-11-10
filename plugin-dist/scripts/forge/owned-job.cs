// Attended synthetic Windows milestone. A Job is ownership, not a sandbox.
// The controller keeps the sole, unnamed, non-inheritable Job handle.
// No PID-based termination, recovery-by-name, installation or activation.
using System;
using System.Collections;
using System.Collections.Generic;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

internal static class OwnedJob {
    const uint SYNCHRONIZE = 0x100000, QUERY = 0x1000;
    const uint WAIT_OBJECT_0 = 0, WAIT_TIMEOUT = 258;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 8192, RecursionLimit = 8 };
    static readonly Regex Nonce = new Regex("^[a-f0-9]{32}$", RegexOptions.CultureInvariant);
    [StructLayout(LayoutKind.Sequential)] struct BasicLimit {
        public long PerProcess, PerJob; public uint Flags;
        public UIntPtr MinWorkingSet, MaxWorkingSet; public uint ActiveLimit;
        public UIntPtr Affinity; public uint Priority, Scheduling;
    }
    [StructLayout(LayoutKind.Sequential)] struct IoCounters { public ulong A,B,C,D,E,F; }
    [StructLayout(LayoutKind.Sequential)] struct ExtendedLimit {
        public BasicLimit Basic; public IoCounters Io;
        public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] struct StartupInfo {
        public int Size; public string Reserved, Desktop, Title;
        public uint X,Y,XSize,YSize,XChars,YChars,Fill,Flags;
        public short Show, Reserved2; public IntPtr ReservedPtr, StdIn, StdOut, StdErr;
    }
    [StructLayout(LayoutKind.Sequential)] struct StartupInfoEx { public StartupInfo Basic; public IntPtr Attributes; }
    [StructLayout(LayoutKind.Sequential)] struct ProcessInfo { public IntPtr Process, Thread; public uint Pid,Tid; }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateJobObject(IntPtr attrs, string name);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimit limits, uint size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr buffer, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool IsProcessInJob(IntPtr process, IntPtr job, out bool member);
    // No post-creation AssignProcessToJobObject gap.
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateJobObject(IntPtr job, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetHandleInformation(IntPtr handle, out uint flags);
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern bool CreateProcess(string app, StringBuilder cmd, IntPtr pa, IntPtr ta, bool inherit, uint flags, IntPtr env, string cwd, ref StartupInfoEx si, out ProcessInfo pi);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError=true)] static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError=true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);

    [DllImport("kernel32.dll", SetLastError=true)] static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value, IntPtr size, IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll")] static extern void DeleteProcThreadAttributeList(IntPtr list);

    // Windows 10+: Job assignment is part of creation, eliminating the unowned
    // suspended-process crash window. Unsupported native API refuses; no fallback.
    static bool CreateInJob(IntPtr job, string executable, StringBuilder cmd, string cwd, out ProcessInfo pi, out int error) {
        IntPtr size=IntPtr.Zero, list=IntPtr.Zero, value=IntPtr.Zero; bool initialized=false;
        pi=new ProcessInfo(); error=0;
        InitializeProcThreadAttributeList(IntPtr.Zero,1,0,ref size);
        if(size.ToInt64()<=0 || size.ToInt64()>65536) throw new InvalidOperationException("attribute size unavailable");
        try {
            list=Marshal.AllocHGlobal(size); value=Marshal.AllocHGlobal(IntPtr.Size);
            Check(InitializeProcThreadAttributeList(list,1,0,ref size)); initialized=true;
            Marshal.WriteIntPtr(value,job);
            if(!UpdateProcThreadAttribute(list,0,new IntPtr(0x2000d),value,new IntPtr(IntPtr.Size),IntPtr.Zero,IntPtr.Zero)) { error=Marshal.GetLastWin32Error(); return false; }
            var si=new StartupInfoEx(); si.Basic.Size=Marshal.SizeOf(typeof(StartupInfoEx)); si.Attributes=list;
            bool created=CreateProcess(executable,cmd,IntPtr.Zero,IntPtr.Zero,false,4|0x08000000|0x00080000,IntPtr.Zero,cwd,ref si,out pi);
            if(!created) error=Marshal.GetLastWin32Error(); return created;
        } finally {
            if(initialized) DeleteProcThreadAttributeList(list);
            if(value!=IntPtr.Zero) Marshal.FreeHGlobal(value);
            if(list!=IntPtr.Zero) Marshal.FreeHGlobal(list);
        }
    }
    [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)] static extern IntPtr CreateFile(string path, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool WriteFile(IntPtr file, byte[] bytes, uint count, out uint written, IntPtr overlapped);
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool FlushFileBuffers(IntPtr file);
    [StructLayout(LayoutKind.Sequential)] struct FileDisposition { public byte DeleteFile; }
    [DllImport("kernel32.dll", SetLastError=true)] static extern bool SetFileInformationByHandle(IntPtr file, int kind, ref FileDisposition info, uint size);
    static string LeasePath(Dictionary<string,object> r) {
        if(!r.ContainsKey("leasePath")) return null;
        string path=Str(r,"leasePath"), root=Path.GetPathRoot(path);
        if(root.Length!=3 || root[1]!=':' || Path.GetFileName(path)!=".fence-inflight" || !String.Equals(Path.GetFullPath(path),path,StringComparison.OrdinalIgnoreCase)) throw new ArgumentException("lease path");
        var parent=new DirectoryInfo(Path.GetDirectoryName(path));
        while(parent!=null) {
            if(!parent.Exists || (parent.Attributes&FileAttributes.ReparsePoint)!=0 || parent.Name.EndsWith(".") || parent.Name.EndsWith(" ")) throw new ArgumentException("lease parent");
            parent=parent.Parent;
        }
        return path;
    }
    static IntPtr CreateLease(string path, string leaseId) {
        // CREATE_NEW, exclusive sharing, and DELETE access. Never delete on crash.
        IntPtr file=CreateFile(path,0xc0010000,0,IntPtr.Zero,1,0x80,IntPtr.Zero);
        if(file==new IntPtr(-1)) throw new Win32Exception(Marshal.GetLastWin32Error());
        try {
            byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(new {schema="native-gate-unit/1",leaseId=leaseId})); uint written;
            Check(WriteFile(file,bytes,(uint)bytes.Length,out written,IntPtr.Zero));
            if(written!=bytes.Length) throw new IOException("incomplete gate record");
            Check(FlushFileBuffers(file)); return file;
        } catch { CloseHandle(file); throw; } // retain even an incomplete record for reconciliation
    }
    static void CompleteLease(IntPtr file) {
        // Remove only this still-exclusively-held native instance, after the unit
        // is reported drained. No close-then-unlink-by-path race with a successor.
        var disposition=new FileDisposition(); disposition.DeleteFile=1;
        Check(SetFileInformationByHandle(file,4,ref disposition,1));
    }
    static void Check(bool ok) { if (!ok) throw new Win32Exception(Marshal.GetLastWin32Error()); }
    static void Emit(object value) { Console.Out.WriteLine(Json.Serialize(value)); Console.Out.Flush(); }
    static Dictionary<string,object> Read() {
        // Bound input while reading, rather than after an unbounded ReadLine allocation.
        var b = new StringBuilder(); int c;
        while ((c = Console.In.Read()) != -1 && c != '\n') {
            if (b.Length >= 8192) throw new ArgumentException("request too large");
            if (c != '\r') b.Append((char)c);
        }
        if (c == -1 && b.Length == 0) return null;
        var value = Json.DeserializeObject(b.ToString()) as Dictionary<string,object>;
        if (value == null) throw new ArgumentException("object required");
        return value;
    }
    static string Str(Dictionary<string,object> r, string key) {
        object v; if (!r.TryGetValue(key,out v) || !(v is string)) throw new ArgumentException(key);
        return (string)v;
    }
    static int Integer(Dictionary<string,object> r, string key, int min, int max) {
        object v; if (!r.TryGetValue(key,out v) || !(v is int) || (int)v < min || (int)v > max) throw new ArgumentException(key);
        return (int)v;
    }
    static void Fields(Dictionary<string,object> r, params string[] keys) {
        var allowed = new HashSet<string>(keys);
        foreach (var key in r.Keys) if (!allowed.Contains(key)) throw new ArgumentException("unknown field");
    }
    static string Token(Dictionary<string,object> r) {
        var token = Str(r,"token"); if (!Nonce.IsMatch(token)) throw new ArgumentException("token");
        return token;
    }
    static string GateName(Dictionary<string,object> r) {
        var name = Str(r,"gate");
        if (!name.StartsWith(@"Local\VPR-S8-",StringComparison.Ordinal) || !Nonce.IsMatch(name.Substring(13))) throw new ArgumentException("gate");
        return name;
    }
    // Documented Windows argv quoting; always quote even paths without spaces.
    static string Quote(string arg) {
        if (arg.IndexOf('\0') >= 0) throw new ArgumentException("nul argument");
        var b = new StringBuilder("\""); int slashes = 0;
        foreach (char c in arg) {
            if (c == '\\') { slashes++; continue; }
            if (c == '"') b.Append('\\',slashes*2+1);
            else b.Append('\\',slashes);
            slashes=0; b.Append(c);
        }
        b.Append('\\',slashes*2); return b.Append('"').ToString();
    }
    static bool Acquire(Mutex gate, int waitMs) {
        try {
            Emit(new {state="gate-waiting"}); // Mutex handle exists before the fixture may crash its owner.
            if (gate.WaitOne(waitMs)) return true;
            Emit(new {state="gate-busy"}); return false;
        } catch (AbandonedMutexException) {
            // WaitOne granted ownership, but abandoned state is not admission authority.
            gate.ReleaseMutex(); Emit(new {state="gate-abandoned"}); return false;
        }
    }
    static void Gate(Dictionary<string,object> r, string token) {
        Fields(r,"version","op","token","gate","waitMs");
        using (var gate = new Mutex(false,GateName(r))) {
            if (!Acquire(gate,Integer(r,"waitMs",0,10000))) return;
            bool held=true;
            try {
                Emit(new {state="gate-acquired"});
                for (;;) {
                    var command=Read(); if (command==null) return;
                    Fields(command,"op","token");
                    if (Str(command,"token")!=token || Str(command,"op")!="release") { Emit(new {state="refused"}); continue; }
                    gate.ReleaseMutex(); held=false; Emit(new {state="gate-released"}); return;
                }
            } finally { if(held) gate.ReleaseMutex(); }
        }
    }
    // Already-running controller: no helper launch is needed to release a gate
    // after pause. All mutex ownership remains on this single native thread.
    static void GateServer(Dictionary<string,object> r, string token) {
        Fields(r,"version","op","token","gate","leasePath");
        string leasePath=LeasePath(r), leaseId=null; IntPtr lease=IntPtr.Zero;
        using(var gate=new Mutex(false,GateName(r))) {
            bool held=false, poisoned=false;
            try {
                Emit(new {state="gate-ready"});
                for(;;) {
                    var command=Read(); if(command==null) return;
                    string op=Str(command,"op");
                    if(Str(command,"token")!=token) { Emit(new {state="refused",reason="token"}); continue; }
                    if(op=="acquire") {
                        Fields(command,"op","token","waitMs","leaseId");
                        if(poisoned) { Emit(new {state="refused",reason="reconciliation required"}); continue; }
                        if(held) { Emit(new {state="refused",reason="already held"}); continue; }
                        string requestedLease=null;
                        if(leasePath!=null) { requestedLease=Str(command,"leaseId"); if(!Nonce.IsMatch(requestedLease)) throw new ArgumentException("leaseId"); }
                        try {
                            int waitMs=Integer(command,"waitMs",0,10000); Emit(new {state="gate-waiting"});
                            held=gate.WaitOne(waitMs);
                            if(held && leasePath!=null) {
                                try { lease=CreateLease(leasePath,requestedLease); leaseId=requestedLease; }
                                catch { poisoned=true;gate.ReleaseMutex();held=false;Emit(new {state="gate-reconciliation-required"});continue; }
                            }
                            // Durable marker exists before Node receives permission to run.
                            Emit(new {state=held?"gate-acquired":"gate-busy",leaseId=leaseId});
                        } catch(AbandonedMutexException) {
                            gate.ReleaseMutex(); poisoned=true; Emit(new {state="gate-abandoned"});
                        }
                    } else if(op=="release") {
                        Fields(command,"op","token","leaseId");
                        if(!held) { Emit(new {state="refused",reason="not held"}); continue; }
                        if(leasePath!=null && Str(command,"leaseId")!=leaseId) {Emit(new {state="refused",reason="leaseId"});continue;}
                        if(lease!=IntPtr.Zero) {CompleteLease(lease);CloseHandle(lease);lease=IntPtr.Zero;leaseId=null;}
                        gate.ReleaseMutex();held=false;Emit(new {state="gate-released"});
                    } else Emit(new {state="refused",reason="operation"});
                }
            } finally {
                // EOF/error/crash is not evidence that the admitted JavaScript unit
                // drained. Closing this handle leaves its marker blocking all peers.
                if(lease!=IntPtr.Zero)CloseHandle(lease);
                if(held)gate.ReleaseMutex();
            }
        }
    }
    static List<object> Members(IntPtr job) {
        const int capacity=64; int size=8+capacity*IntPtr.Size;
        IntPtr buffer=Marshal.AllocHGlobal(size);
        try {
            for(int attempt=0;attempt<4;attempt++) {
                if(!QueryInformationJobObject(job,3,buffer,(uint)size,IntPtr.Zero)) {
                    int error=Marshal.GetLastWin32Error();
                    if(error==234)continue;
                    throw new Win32Exception(error);
                }
                int assigned=Marshal.ReadInt32(buffer), count=Marshal.ReadInt32(buffer,4);
                if(count<0 || count>capacity || count!=assigned)continue;
                var result=new List<object>(); bool changed=false;
                for(int i=0;i<count;i++) {
                    long raw=Marshal.ReadIntPtr(buffer,8+i*IntPtr.Size).ToInt64();
                    if(raw<=0 || raw>uint.MaxValue)throw new InvalidOperationException("invalid member");
                    uint pid=(uint)raw; IntPtr process=OpenProcess(QUERY,false,pid);
                    if(process==IntPtr.Zero) {
                        int error=Marshal.GetLastWin32Error();
                        if(error==87) { changed=true;break; } // PID exited after enumeration.
                        throw new Win32Exception(error);
                    }
                    try {
                        bool member; Check(IsProcessInJob(process,job,out member));
                        long creation,exit,kernel,user;
                        Check(GetProcessTimes(process,out creation,out exit,out kernel,out user));
                        if(!member || exit!=0) { changed=true;break; }
                        result.Add(new {pid=pid,startedTicks=creation.ToString(System.Globalization.CultureInfo.InvariantCulture)});
                    } finally { CloseHandle(process); }
                }
                if(!changed)return result;
            }
            throw new InvalidOperationException("population changing");
        } finally { Marshal.FreeHGlobal(buffer); }
    }
    static int Active(IntPtr job) {
        IntPtr buffer=Marshal.AllocHGlobal(48);
        try { Check(QueryInformationJobObject(job,1,buffer,48,IntPtr.Zero)); return Marshal.ReadInt32(buffer,40); }
        finally { Marshal.FreeHGlobal(buffer); }
    }
    static void Watch(Dictionary<string,object> r) {
        Fields(r,"version","op","token","members","waitMs");
        int wait=Integer(r,"waitMs",1,10000); object value;
        if (!r.TryGetValue("members",out value) || !(value is object[])) throw new ArgumentException("members");
        var members=(object[])value;
        if (members.Length<1 || members.Length>32) throw new ArgumentException("members");
        var handles=new List<IntPtr>(); var ids=new HashSet<int>();
        try {
            foreach (object item in members) {
                var member=item as Dictionary<string,object>; if(member==null) throw new ArgumentException("member");
                Fields(member,"pid","startedTicks"); int pid=Integer(member,"pid",1,int.MaxValue);
                if(!ids.Add(pid)) throw new ArgumentException("duplicate member");
                IntPtr h=OpenProcess(SYNCHRONIZE|QUERY,false,(uint)pid);
                if(h==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                handles.Add(h); long created,exit,kernel,user;
                Check(GetProcessTimes(h,out created,out exit,out kernel,out user));
                if(created.ToString(System.Globalization.CultureInfo.InvariantCulture)!=Str(member,"startedTicks")) throw new InvalidOperationException("identity mismatch");
            }
            Emit(new {state="observing",count=handles.Count});
            var clock=Stopwatch.StartNew();
            foreach (IntPtr h in handles) {
                uint left=(uint)Math.Max(0,wait-clock.ElapsedMilliseconds);
                if(WaitForSingleObject(h,left)!=WAIT_OBJECT_0) { Emit(new {state="unknown",reason="exit unconfirmed"}); return; }
            }
            Emit(new {state="exited",count=handles.Count});
        } finally { foreach (IntPtr h in handles) CloseHandle(h); }
    }
    static void Run(Dictionary<string,object> r, string token) {
        Fields(r,"version","op","token","gate","executable","args","cwd","assignFailure","holdBeforeResume");
        string executable=Str(r,"executable"), cwd=Str(r,"cwd");
        if(!Path.IsPathRooted(executable) || !File.Exists(executable) || !Path.IsPathRooted(cwd) || !Directory.Exists(cwd)) throw new ArgumentException("absolute existing paths required");
        object argsValue, faultValue;
        if(!r.TryGetValue("args",out argsValue) || !(argsValue is object[])) throw new ArgumentException("args");
        if(!r.TryGetValue("assignFailure",out faultValue) || !(faultValue is bool)) throw new ArgumentException("assignFailure");
        object hold; bool holdBeforeResume=r.TryGetValue("holdBeforeResume",out hold) && hold is bool && (bool)hold;
        if(r.ContainsKey("holdBeforeResume") && !(hold is bool)) throw new ArgumentException("holdBeforeResume");
        var args=(object[])argsValue; if(args.Length>64) throw new ArgumentException("args");
        var cmd=new StringBuilder(Quote(executable));
        foreach(object arg in args) { if(!(arg is string)) throw new ArgumentException("argument"); cmd.Append(' ').Append(Quote((string)arg)); }
        if(cmd.Length>16000) throw new ArgumentException("command too long");
        IntPtr job=IntPtr.Zero; ProcessInfo pi=new ProcessInfo(); bool resumed=false;
        using(var gate=new Mutex(false,GateName(r))) {
            if(!Acquire(gate,5000)) return;
            try {
                job=CreateJobObject(IntPtr.Zero,null); if(job==IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
                var limits=new ExtendedLimit(); limits.Basic.Flags=0x2000|8; limits.Basic.ActiveLimit=32;
                Check(SetInformationJobObject(job,9,ref limits,(uint)Marshal.SizeOf(typeof(ExtendedLimit))));
                uint handleFlags; Check(GetHandleInformation(job,out handleFlags));
                if((handleFlags&1)!=0) throw new InvalidOperationException("inherited job handle");
                int creationError;
                if(!CreateInJob((bool)faultValue?IntPtr.Zero:job,executable,cmd,cwd,out pi,out creationError)) {
                    bool terminated=pi.Process==IntPtr.Zero;
                    if(!terminated) { Check(TerminateProcess(pi.Process,1)); terminated=WaitForSingleObject(pi.Process,5000)==WAIT_OBJECT_0; }
                    Emit(new {state="assignment-refused",nativeError=creationError,rootTerminated=terminated,rootCreated=pi.Process!=IntPtr.Zero}); return;
                }
                if(holdBeforeResume) {
                    Emit(new {state="assigned-suspended",members=Members(job)});
                    var resume=Read();
                    if(resume==null) return;
                    Fields(resume,"op","token");
                    if(Str(resume,"op")!="resume" || Str(resume,"token")!=token) throw new InvalidOperationException("resume refused");
                }
                if(ResumeThread(pi.Thread)==uint.MaxValue) throw new Win32Exception(Marshal.GetLastWin32Error());
                long created,exited,kernel,user; Check(GetProcessTimes(pi.Process,out created,out exited,out kernel,out user));
                resumed=true; Emit(new {state="ready",jobHandleInheritable=false,root=new {pid=pi.Pid,startedTicks=created.ToString(System.Globalization.CultureInfo.InvariantCulture)}});
            } finally {
                gate.ReleaseMutex();
                // Cleanup here only for failed admission; successful runs retain the job.
                if(!resumed) {
                    if(pi.Process!=IntPtr.Zero) { TerminateProcess(pi.Process,1); WaitForSingleObject(pi.Process,5000); }
                    if(pi.Thread!=IntPtr.Zero) CloseHandle(pi.Thread);
                    if(pi.Process!=IntPtr.Zero) CloseHandle(pi.Process);
                    if(job!=IntPtr.Zero) CloseHandle(job);
                }
            }
        }
        if(!resumed) return;
        CloseHandle(pi.Thread); CloseHandle(pi.Process);
        try {
            for(;;) {
                var command=Read(); if(command==null) return;
                Fields(command,"op","token");
                if(Str(command,"token")!=token) { Emit(new {state="refused"}); continue; }
                string op=Str(command,"op");
                if(op=="status") {
                    // A failed read must not release the kill-on-close ownership handle.
                    try { Emit(new {state="status",members=Members(job)}); }
                    catch(Win32Exception) { Emit(new {state="unknown",reason="membership unavailable"}); }
                    catch(InvalidOperationException) { Emit(new {state="unknown",reason="membership changing"}); }
                    continue;
                }
                if(op!="stop") { Emit(new {state="refused"}); continue; }
                Check(TerminateJobObject(job,1)); var clock=Stopwatch.StartNew(); int active;
                while((active=Active(job))!=0 && clock.ElapsedMilliseconds<5000) Thread.Sleep(10);
                if(active==0) Emit(new {state="stopped",activeProcesses=0});
                else Emit(new {state="unknown",reason="population exit unconfirmed",activeProcesses=active});
                return;
            }
        } finally { CloseHandle(job); }
    }
    static int Main() {
        try {
            var r=Read(); if(r==null) return 0;
            Integer(r,"version",1,1); string token=Token(r),op=Str(r,"op");
            if(op=="gate") Gate(r,token);
            else if(op=="gate-server") GateServer(r,token);
            else if(op=="watch") Watch(r);
            else if(op=="run") Run(r,token);
            else throw new ArgumentException("operation");
            return 0;
        } catch(Exception e) {
            Emit(new {state="unknown",reason=e is Win32Exception?"native operation failed":e.Message});
            return 1;
        }
    }
}
