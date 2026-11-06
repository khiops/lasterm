// What keeps drag-file.ps1 honest about the user's mouse, loaded by it with Add-Type.
// Windows PowerShell compiles it with the .NET Framework's C# 5 compiler: no string
// interpolation, no `?.`, no expression-bodied members.
//
// - A low-level mouse hook (WH_MOUSE_LL) on a thread of its own, which does nothing
//   but pump messages: Windows calls the hook on that thread, so the hook is served
//   at once even while the harness's UI thread sits in DoDragDrop or in a call to a
//   drop target that does not return. A hook served late slows every mouse event of
//   the session, and Windows silently removes a hook that times out too often.
//   An event without LLMHF_INJECTED comes from a device: the user's hand. The
//   harness's press and the mover's release are injected; the mover's moves
//   (SetCursorPos, and a mouse_event move of zero) raise no low-level event at
//   all, which is why the mover also checks the cursor before each step.
// - The reason a running drag must stop: a physical event, the mover reporting the
//   cursor off its path, the mover failing, or the drag running out of time. The
//   harness's QueryContinueDrag handler cancels once a reason is set. DoDragDrop
//   asks that handler only when input arrives, not on a timer (measured: one call
//   in 2 s of an idle drag), so a reason set without input is followed by a
//   one-pixel move there and back, the kind of move the mover makes.
// - A watchdog: past the soft deadline the drag is cancelled; past the hard one,
//   DoDragDrop has still not returned (a drop target that never answers holds
//   it), so the watchdog releases the button, puts the cursor back and ends the
//   process with ExitTimedOut. Whatever happens, the harness does not hang.
// - The decisions themselves (QuietVerdict, MoverReason, Decide, IsPhysical, ...),
//   pure, which drag-guard.spec.ts runs.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;

public sealed class DragVerdict
{
	public DragVerdict(int exitCode, string message) { ExitCode = exitCode; Message = message; }
	public int ExitCode { get; private set; }
	public string Message { get; private set; }
}

public static class DragGuard
{
	// ── Exit codes and reasons ──────────────────────────────────────────────

	public const int ExitDone = 0;
	public const int ExitFailed = 1;
	/// The user's mouse was in the way: the result is discarded, retry later.
	public const int ExitInterfered = 3;
	/// The drag never finished: the result is discarded, retry later.
	public const int ExitTimedOut = 4;

	public const int ReasonNone = 0;
	public const int ReasonPhysical = 1;
	public const int ReasonDrift = 2;
	public const int ReasonTimeout = 3;
	public const int ReasonMoverFailed = 4;
	public const int ReasonBusy = 5;

	/// The mover's exit code when it found the cursor off its path.
	public const int MoverDrifted = 3;
	/// The mover has not exited, or was never started.
	public const int MoverRunning = int.MinValue;

	// ── Pure decisions ───────────────────────────────────────────────────────

	public const uint LLMHF_INJECTED = 0x01;

	/// A low-level mouse event came from a device, not from SendInput or mouse_event.
	public static bool IsPhysical(uint flags) { return (flags & LLMHF_INJECTED) == 0; }

	static readonly string[] KindNames = { "move", "left down", "left up", "right button", "middle button", "wheel", "x button", "other" };

	public static int KindOf(int message)
	{
		switch (message)
		{
			case 0x0200: return 0;                       // WM_MOUSEMOVE
			case 0x0201: return 1;                       // WM_LBUTTONDOWN
			case 0x0202: return 2;                       // WM_LBUTTONUP
			case 0x0204: case 0x0205: return 3;          // WM_RBUTTONDOWN, UP
			case 0x0207: case 0x0208: return 4;          // WM_MBUTTONDOWN, UP
			case 0x020A: case 0x020E: return 5;          // WM_MOUSEWHEEL, WM_MOUSEHWHEEL
			case 0x020B: case 0x020C: return 6;          // WM_XBUTTONDOWN, UP
			default: return 7;
		}
	}

	/// "3 (move 2, left down 1)", or "none".
	public static string DescribeCounts(int[] counts)
	{
		int total = 0;
		var parts = new List<string>();
		for (int kind = 0; kind < counts.Length && kind < KindNames.Length; kind++)
		{
			if (counts[kind] == 0) continue;
			total += counts[kind];
			parts.Add(KindNames[kind] + " " + counts[kind]);
		}
		return total == 0 ? "none" : total + " (" + string.Join(", ", parts) + ")";
	}

	/// "go" once no physical event has come for quietMs (counted from when the hook
	/// started watching, since nothing before it was seen), "busy" past boundMs of
	/// waiting, else "wait". lastPhysicalMs is -1 when none came.
	public static string QuietVerdict(long nowMs, long watchingSinceMs, long lastPhysicalMs, long waitStartedMs, long quietMs, long boundMs)
	{
		long restingSince = Math.Max(watchingSinceMs, lastPhysicalMs);
		if (nowMs - restingSince >= quietMs) return "go";
		if (nowMs - waitStartedMs >= boundMs) return "busy";
		return "wait";
	}

	/// What the mover's exit code says about the drag.
	public static int MoverReason(int exitCode)
	{
		if (exitCode == MoverRunning || exitCode == 0) return ReasonNone;
		return exitCode == MoverDrifted ? ReasonDrift : ReasonMoverFailed;
	}

	/// The harness's result once the drag is over. A physical event or a drift found
	/// only after the drop still discards it: the drop may have landed elsewhere.
	public static DragVerdict Decide(int reason, long physicalEvents, int moverExit, string moverOutput, string effect)
	{
		if (reason == ReasonNone && physicalEvents > 0) reason = ReasonPhysical;
		if (reason == ReasonNone) reason = MoverReason(moverExit);
		string said = string.IsNullOrEmpty(moverOutput) ? "" : moverOutput.Trim();
		switch (reason)
		{
			case ReasonPhysical:
				return new DragVerdict(ExitInterfered, "interfered: physical mouse input during the drag; result discarded");
			case ReasonDrift:
				return new DragVerdict(ExitInterfered, "interfered: the cursor left the mover's path" + (said == "" ? "" : " (" + said + ")") + "; result discarded");
			case ReasonTimeout:
				return new DragVerdict(ExitTimedOut, "drag timed out; result discarded");
			case ReasonBusy:
				return new DragVerdict(ExitInterfered, "busy: physical mouse in use; nothing was dragged");
			case ReasonMoverFailed:
				return new DragVerdict(ExitFailed, "the mouse mover failed (exit " + moverExit + ")" + (said == "" ? "" : ": " + said));
			default:
				return new DragVerdict(ExitDone, "drop effect: " + effect);
		}
	}

	// ── Native ───────────────────────────────────────────────────────────────

	const int WH_MOUSE_LL = 14;
	const uint WM_QUIT = 0x0012;
	const uint MOUSEEVENTF_MOVE = 0x0001;
	const uint MOUSEEVENTF_LEFTDOWN = 0x0002;
	const uint MOUSEEVENTF_LEFTUP = 0x0004;
	const int VK_LBUTTON = 0x01;

	[StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
	[StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData; public uint flags; public uint time; public IntPtr dwExtraInfo; }
	[StructLayout(LayoutKind.Sequential)] struct MSG { public IntPtr hwnd; public uint message; public IntPtr wParam; public IntPtr lParam; public uint time; public POINT pt; }
	delegate IntPtr HookProc(int code, IntPtr wParam, IntPtr lParam);

	[DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetWindowsHookEx(int id, HookProc proc, IntPtr module, uint threadId);
	[DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
	[DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern int GetMessage(out MSG msg, IntPtr hwnd, uint min, uint max);
	[DllImport("user32.dll")] static extern bool PostThreadMessage(uint threadId, uint msg, IntPtr wParam, IntPtr lParam);
	[DllImport("user32.dll")] static extern bool SetCursorPos(int x, int y);
	[DllImport("user32.dll")] static extern bool GetCursorPos(out POINT p);
	[DllImport("user32.dll")] static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
	[DllImport("user32.dll")] static extern short GetAsyncKeyState(int vk);
	[DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
	[DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
	[DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
	[DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
	[DllImport("kernel32.dll")] static extern bool TerminateProcess(IntPtr process, uint code);

	// ── The hook ─────────────────────────────────────────────────────────────

	static readonly Stopwatch Clock = Stopwatch.StartNew();
	static readonly object Gate = new object();
	static HookProc proc;            // held here, or the collector frees what Windows calls
	static IntPtr hook = IntPtr.Zero;
	static uint hookThreadId;
	static Thread hookThread;
	static long watchingSinceMs = -1;
	static long lastPhysicalMs = -1;
	static bool recording;
	static int[] injectedCounts = new int[8];
	static int[] physicalCounts = new int[8];
	static long physicalDuringDrag;
	static int reason = ReasonNone;
	// The harness pressed the left button and no injected release has come since.
	static bool pressedByUs;

	public static long NowMs { get { return Clock.ElapsedMilliseconds; } }
	public static bool SawPhysical { get { lock (Gate) { return lastPhysicalMs >= 0; } } }
	public static int Reason { get { return Thread.VolatileRead(ref reason); } }

	/// Start watching the mouse, before anything is pressed.
	public static void Watch()
	{
		string error = null;
		var ready = new ManualResetEvent(false);
		hookThread = new Thread(() =>
		{
			hookThreadId = GetCurrentThreadId();
			proc = OnMouse;
			hook = SetWindowsHookEx(WH_MOUSE_LL, proc, GetModuleHandle(null), 0);
			if (hook == IntPtr.Zero) error = "SetWindowsHookEx(WH_MOUSE_LL) failed: error " + Marshal.GetLastWin32Error();
			lock (Gate) { watchingSinceMs = NowMs; }
			ready.Set();
			if (hook == IntPtr.Zero) return;
			MSG msg;
			while (GetMessage(out msg, IntPtr.Zero, 0, 0) > 0) { }
			UnhookWindowsHookEx(hook);
		});
		hookThread.IsBackground = true;
		hookThread.Start();
		ready.WaitOne();
		if (error != null) throw new InvalidOperationException(error);
	}

	public static void Unwatch()
	{
		if (hookThread == null) return;
		PostThreadMessage(hookThreadId, WM_QUIT, IntPtr.Zero, IntPtr.Zero);
		hookThread.Join(1000);
		hookThread = null;
	}

	static IntPtr OnMouse(int code, IntPtr wParam, IntPtr lParam)
	{
		if (code >= 0)
		{
			var info = (MSLLHOOKSTRUCT)Marshal.PtrToStructure(lParam, typeof(MSLLHOOKSTRUCT));
			bool physical = IsPhysical(info.flags);
			int kind = KindOf(wParam.ToInt32());
			bool stop = false;
			lock (Gate)
			{
				if (physical) lastPhysicalMs = NowMs;
				else if (kind == 2) pressedByUs = false;   // the mover's release, the drop
				if (recording)
				{
					if (physical) { physicalCounts[kind]++; physicalDuringDrag++; stop = true; }
					else injectedCounts[kind]++;
				}
			}
			// The event itself wakes DoDragDrop, which then asks QueryContinueDrag.
			if (stop) StopFor(ReasonPhysical);
		}
		return CallNextHookEx(hook, code, wParam, lParam);
	}

	/// "go", "wait" or "busy", for a wait that started at waitStartedMs.
	public static string Quiet(long waitStartedMs, long quietMs, long boundMs)
	{
		lock (Gate) { return QuietVerdict(NowMs, watchingSinceMs, lastPhysicalMs, waitStartedMs, quietMs, boundMs); }
	}

	/// From the press on, every event counts, and a physical one stops the drag.
	public static void BeginDrag()
	{
		lock (Gate)
		{
			injectedCounts = new int[8];
			physicalCounts = new int[8];
			physicalDuringDrag = 0;
			recording = true;
		}
		Interlocked.Exchange(ref reason, ReasonNone);
		finished.Reset();
	}

	public static void EndDrag() { lock (Gate) { recording = false; } }

	public static long PhysicalDuringDrag { get { lock (Gate) { return physicalDuringDrag; } } }

	/// What the hook saw during the drag, injected and physical.
	public static string Summary()
	{
		lock (Gate)
		{
			return "mouse events during the drag (WH_MOUSE_LL): injected " + DescribeCounts(injectedCounts) + "; physical " + DescribeCounts(physicalCounts);
		}
	}

	/// Set the reason the drag stops, unless one is set already; true if this one won.
	public static bool StopFor(int why)
	{
		return Interlocked.CompareExchange(ref reason, why, ReasonNone) == ReasonNone;
	}

	/// A one-pixel injected move there and back, so that DoDragDrop asks
	/// QueryContinueDrag now rather than at the next input.
	public static void Nudge()
	{
		POINT at;
		if (!GetCursorPos(out at)) return;
		SetCursorPos(at.X + 1, at.Y);
		mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
		SetCursorPos(at.X, at.Y);
		mouse_event(MOUSEEVENTF_MOVE, 0, 0, 0, UIntPtr.Zero);
	}

	/// Per-monitor DPI awareness: cursor positions in physical pixels, as the mover's.
	public static void UsePhysicalPixels() { SetProcessDpiAwarenessContext(new IntPtr(-4)); }

	public static POINT Cursor()
	{
		POINT at;
		GetCursorPos(out at);
		return at;
	}

	public static bool LeftDown() { return (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0; }

	/// Press the left button where the cursor is: the start of the drag.
	public static void PressLeft()
	{
		lock (Gate) { pressedByUs = true; }
		mouse_event(MOUSEEVENTF_LEFTDOWN, 0, 0, 0, UIntPtr.Zero);
	}

	/// Release the button the harness pressed, if it is still down: never a
	/// button the user holds and the harness did not press.
	public static void ReleaseLeftIfDown()
	{
		bool ours;
		lock (Gate) { ours = pressedByUs; pressedByUs = false; }
		if (ours && LeftDown()) mouse_event(MOUSEEVENTF_LEFTUP, 0, 0, 0, UIntPtr.Zero);
	}

	// ── The mover ────────────────────────────────────────────────────────────

	static Process mover;
	static int moverExit = MoverRunning;
	static string moverOutput = "";
	static Thread moverWatch;

	public static int MoverExit { get { return Thread.VolatileRead(ref moverExit); } }
	public static string MoverOutput { get { return moverOutput; } }

	/// Run drag-mover.ps1, hidden, its output kept; its exit stops the drag when it
	/// drifted or failed.
	public static void StartMover(string exe, string arguments)
	{
		var start = new ProcessStartInfo(exe, arguments);
		start.UseShellExecute = false;
		start.CreateNoWindow = true;
		start.RedirectStandardOutput = true;
		start.RedirectStandardError = true;
		Thread.VolatileWrite(ref moverExit, MoverRunning);
		moverOutput = "";
		mover = Process.Start(start);
		var process = mover;
		moverWatch = new Thread(() =>
		{
			var errors = process.StandardError.ReadToEndAsync();
			string output = process.StandardOutput.ReadToEnd();
			process.WaitForExit();
			moverOutput = (output + errors.Result).Trim();
			int code = process.ExitCode;
			Thread.VolatileWrite(ref moverExit, code);
			int why = MoverReason(code);
			if (why != ReasonNone && StopFor(why)) Nudge();
		});
		moverWatch.IsBackground = true;
		moverWatch.Start();
	}

	/// Wait for the mover to exit and its output to be read; false if it is still running.
	public static bool WaitMover(int ms)
	{
		return moverWatch == null || moverWatch.Join(ms);
	}

	public static void KillMover()
	{
		try { if (mover != null && !mover.HasExited) mover.Kill(); } catch (Exception) { }
		WaitMover(2000);
	}

	// ── The watchdog ─────────────────────────────────────────────────────────

	static readonly ManualResetEvent finished = new ManualResetEvent(false);

	/// Past softMs, stop the drag for its time; past hardMs, end the process with
	/// ExitTimedOut, the button released and the cursor back at restoreX, restoreY.
	public static void Arm(int softMs, int hardMs, int restoreX, int restoreY)
	{
		var watchdog = new Thread(() =>
		{
			if (finished.WaitOne(softMs)) return;
			if (StopFor(ReasonTimeout)) Nudge();
			if (finished.WaitOne(Math.Max(0, hardMs - softMs))) return;
			// DoDragDrop has not returned: a drop target that does not answer holds it.
			try { if (mover != null && !mover.HasExited) mover.Kill(); } catch (Exception) { }
			ReleaseLeftIfDown();
			SetCursorPos(restoreX, restoreY);
			Console.Out.WriteLine("drag timed out: DoDragDrop did not return; result discarded");
			Console.Out.WriteLine(Summary());
			Console.Out.Flush();
			TerminateProcess(GetCurrentProcess(), ExitTimedOut);
		});
		watchdog.IsBackground = true;
		watchdog.Start();
	}

	public static void Disarm() { finished.Set(); }
}
