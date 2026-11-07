# Drag a file onto the desktop app the way a user does: a real OLE drag from
# another window, which goes through the window's native drop handling. For a
# drop that only needs the page, `cdp.mjs drop` needs no mouse at all: use it.
#
#   powershell -NoProfile -STA -File scripts\dev\ui\drag-file.ps1 -File <path> -X <cssX> -Y <cssY>
#   powershell -NoProfile -STA -File scripts\dev\ui\drag-file.ps1 -File <path> -SelfTest
#
# -X/-Y are page coordinates in CSS pixels, as getBoundingClientRect() gives
# them; the page's devicePixelRatio is read over CDP unless -Dpr is given.
# -SelfTest drags onto a throwaway WinForms target instead, to show the
# harness works on this machine before a result on the app is trusted, and
# prints which mouse events it saw as injected and which as physical.
#
# The mouse really moves for a few seconds, so the user's own mouse is watched
# (drag-guard.cs): the drag starts only once it has rested for 2 s, and any
# physical mouse event during the drag, or a cursor found off the mover's path,
# cancels it at once, with no drop. The left button is released and the cursor
# put back in every case. Exit codes:
#   0  the drag ran; "drop effect: <effect>" says what the target answered
#   1  the harness could not run, or the self-test target received nothing
#   3  interfered or busy: the user's mouse was in the way; result discarded, retry later
#   4  the drag timed out (-TimeoutSeconds, default 20); result discarded, retry later
param(
	[Parameter(Mandatory)] [string]$File,
	[double]$X, [double]$Y, [double]$Dpr = 0,
	[int]$Port = 9333,
	[switch]$SelfTest,
	[int]$TimeoutSeconds = 20
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
Add-Type -Path (Join-Path $PSScriptRoot 'drag-guard.cs')
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class DragUser32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool ClientToScreen(IntPtr h, ref POINT p);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern IntPtr WindowFromPoint(POINT p);
  [DllImport("user32.dll")] public static extern IntPtr GetAncestor(IntPtr h, uint f);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
}
"@
[void][DragUser32]::SetProcessDpiAwarenessContext([IntPtr]-4)  # physical pixels
$File = (Resolve-Path $File).Path
# The mouse is the user's: put it back where it was once the drag is over.
$userCursor = New-Object DragUser32+POINT
[void][DragUser32]::GetCursorPos([ref]$userCursor)
# Watch the mouse from now on, so that a hand on it is seen before the drag starts.
[DragGuard]::Watch()

if ($SelfTest) {
	$targetForm = New-Object Windows.Forms.Form
	$targetForm.StartPosition = 'Manual'; $targetForm.Location = New-Object Drawing.Point 300, 300
	$targetForm.Size = New-Object Drawing.Size 300, 200; $targetForm.TopMost = $true; $targetForm.AllowDrop = $true
	$targetForm.Text = 'drag self-test target'
	$script:received = $null
	$targetForm.Add_DragEnter({ param($s, $e) $e.Effect = 'Copy' })
	$targetForm.Add_DragDrop({ param($s, $e)
		$script:received = $e.Data.GetData('FileDrop') -join ','
		[Console]::WriteLine("self-test target received: $($script:received)")
	})
	$targetForm.Show()
	$target = New-Object Drawing.Point ($targetForm.Left + 150), ($targetForm.Top + 100)
} else {
	if ($Dpr -le 0) {
		$Dpr = [double](node (Join-Path $PSScriptRoot 'cdp.mjs') --port $Port eval 'devicePixelRatio')
	}
	$window = (Get-Process lasterm-desktop | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1).MainWindowHandle
	$origin = New-Object DragUser32+POINT
	[void][DragUser32]::ClientToScreen($window, [ref]$origin)
	[void][DragUser32]::ShowWindow($window, 9)
	[void][DragUser32]::SetForegroundWindow($window)
	$target = New-Object Drawing.Point ([int]($origin.X + $X * $Dpr)), ([int]($origin.Y + $Y * $Dpr))
	$probe = New-Object DragUser32+POINT; $probe.X = $target.X; $probe.Y = $target.Y
	if ([DragUser32]::GetAncestor([DragUser32]::WindowFromPoint($probe), 2) -ne $window) {
		throw "another window covers the target point ($($target.X),$($target.Y)); bring Lasterm to the front"
	}
}

# The source goes on the target's screen, beside the target, never off-screen:
# a press there would land on whatever window the cursor is clamped to.
$bounds = [Windows.Forms.Screen]::FromPoint($target).WorkingArea
$sourceX = if ($target.X - 400 -ge $bounds.Left) { $target.X - 400 } else { [Math]::Min($target.X + 240, $bounds.Right - 160) }
$sourceY = [Math]::Max($bounds.Top, [Math]::Min($target.Y - 45, $bounds.Bottom - 90))
$source = New-Object Windows.Forms.Form
$source.StartPosition = 'Manual'; $source.Size = New-Object Drawing.Size 160, 90; $source.TopMost = $true
$source.Location = New-Object Drawing.Point $sourceX, $sourceY
$source.Text = 'drag source'
# The verdict, once known: @{ Code; Message }.
$script:verdict = $null
# DoDragDrop asks this whenever input arrives; drag-guard.cs makes sure some
# does once it has a reason to stop. Cancel: the drag ends with no drop.
$source.Add_QueryContinueDrag({ param($s, $e)
	if ([DragGuard]::Reason -ne [DragGuard]::ReasonNone) { $e.Action = 'Cancel' }
})
$source.Add_Shown({
	[Windows.Forms.Application]::DoEvents()
	# Never start under a moving hand: wait until the mouse has rested for 2 s, at most 30 s.
	$waitStarted = [DragGuard]::NowMs
	$said = $false
	while ($true) {
		$quiet = [DragGuard]::Quiet($waitStarted, 2000, 30000)
		if ($quiet -eq 'go') { break }
		if ($quiet -eq 'busy') {
			$busy = [DragGuard]::Decide([DragGuard]::ReasonBusy, 0, [DragGuard]::MoverRunning, '', '')
			$script:verdict = @{ Code = $busy.ExitCode; Message = $busy.Message }
			$source.Close(); return
		}
		if (-not $said -and [DragGuard]::SawPhysical) { [Console]::WriteLine("waiting until the physical mouse rests for 2 s"); $said = $true }
		[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 50
	}
	# From here on, a physical event stops everything, the press included: a hand
	# that moves the cursor off the source would have the press land elsewhere.
	[DragGuard]::BeginDrag()
	$client = $source.PointToScreen((New-Object Drawing.Point 80, 30))
	$start = New-Object Drawing.Point $client.X, $client.Y
	$at = New-Object DragUser32+POINT; $at.X = $start.X; $at.Y = $start.Y
	[void][DragUser32]::SetCursorPos($start.X, $start.Y)
	if ([DragUser32]::GetAncestor([DragUser32]::WindowFromPoint($at), 2) -ne $source.Handle) {
		$script:verdict = @{ Code = 1; Message = "aborted: the drag source is not under the cursor, so no button is pressed" }
		$source.Close(); return
	}
	# Bounded: past the deadline the drag is cancelled, and a drop target that holds
	# DoDragDrop for 3 s more gets the process ended (exit 4).
	[DragGuard]::Arm($TimeoutSeconds * 1000, $TimeoutSeconds * 1000 + 3000, $userCursor.X, $userCursor.Y)
	if ([DragGuard]::Reason -eq [DragGuard]::ReasonNone) {
		[DragGuard]::PressLeft()  # left down on the source
		# The injected press is queued: start the drag only once Windows reports it.
		$deadline = [DateTime]::Now.AddMilliseconds(1500)
		while ((([Windows.Forms.Control]::MouseButtons -band 'Left') -eq 0) -and ([DateTime]::Now -lt $deadline)) {
			[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10
		}
	}
	# This thread sits in DoDragDrop's modal loop, so another process moves the mouse.
	$powershell = (Get-Process -Id $PID).Path
	# Named, with a colon: a screen left of or above the main one has negative
	# coordinates, and a bare -12 would be read as the name of a parameter.
	$moverArgs = "-NoProfile -ExecutionPolicy Bypass -File `"$(Join-Path $PSScriptRoot 'drag-mover.ps1')`" -FromX:$($start.X) -FromY:$($start.Y) -ToX:$($target.X) -ToY:$($target.Y)"
	$data = New-Object Windows.Forms.DataObject
	$files = New-Object Collections.Specialized.StringCollection
	[void]$files.Add($File); $data.SetFileDropList($files)
	$effect = 'None'
	if ([DragGuard]::Reason -eq [DragGuard]::ReasonNone) {
		[DragGuard]::StartMover($powershell, $moverArgs)
		$effect = $source.DoDragDrop($data, [Windows.Forms.DragDropEffects]::Copy)
	}
	# Once DoDragDrop has returned, the mouse no longer changes what was dropped.
	[DragGuard]::EndDrag()
	[DragGuard]::Disarm()
	# A cancelled drag leaves the mover nothing to do; a finished one, only its exit.
	if ([DragGuard]::Reason -ne [DragGuard]::ReasonNone) { [DragGuard]::KillMover() }
	elseif (-not [DragGuard]::WaitMover(3000)) { [DragGuard]::KillMover() }
	$decided = [DragGuard]::Decide([DragGuard]::Reason, [DragGuard]::PhysicalDuringDrag, [DragGuard]::MoverExit, [DragGuard]::MoverOutput, "$effect")
	$script:verdict = @{ Code = $decided.ExitCode; Message = $decided.Message }
	if ($SelfTest) { $targetForm.Close() }
	$source.Close()
})
try {
	[Windows.Forms.Application]::Run($source)
} finally {
	[DragGuard]::Disarm()
	[DragGuard]::KillMover()
	# Let the mover's release land before the cursor goes back.
	Start-Sleep -Milliseconds 300
	[DragGuard]::ReleaseLeftIfDown()
	[void][DragUser32]::SetCursorPos($userCursor.X, $userCursor.Y)
	[DragGuard]::Unwatch()
}
if ($null -eq $script:verdict) { $script:verdict = @{ Code = 1; Message = "the drag never started" } }
[Console]::WriteLine($script:verdict.Message)
if ($SelfTest -or $script:verdict.Code -eq [DragGuard]::ExitInterfered) { [Console]::WriteLine([DragGuard]::Summary()) }
if ($SelfTest -and $script:verdict.Code -eq 0 -and $script:received -ne $File) {
	[Console]::WriteLine("self-test failed: the target received $(if ($script:received) { $script:received } else { 'nothing' }), not $File")
	exit 1
}
exit $script:verdict.Code
