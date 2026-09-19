# Drag a file onto the desktop app the way a user does: a real OLE drag, which
# goes through the window's native drop handling. A drag dispatched over CDP
# enters the page directly and would skip exactly what such a test is about.
#
#   powershell -NoProfile -STA -File scripts\dev\ui\drag-file.ps1 -File <path> -X <cssX> -Y <cssY>
#   powershell -NoProfile -STA -File scripts\dev\ui\drag-file.ps1 -File <path> -SelfTest
#
# -X/-Y are page coordinates in CSS pixels, as getBoundingClientRect() gives
# them; the page's devicePixelRatio is read over CDP unless -Dpr is given.
# -SelfTest drags onto a throwaway WinForms target instead, to show the
# harness works on this machine before a result on the app is trusted.
# The mouse really moves for a few seconds, and the left button is always
# released at the end.
param(
	[Parameter(Mandatory)] [string]$File,
	[double]$X, [double]$Y, [double]$Dpr = 0,
	[int]$Port = 9333,
	[switch]$SelfTest
)
$ErrorActionPreference = "Stop"
Add-Type -AssemblyName System.Windows.Forms, System.Drawing
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

if ($SelfTest) {
	$targetForm = New-Object Windows.Forms.Form
	$targetForm.StartPosition = 'Manual'; $targetForm.Location = New-Object Drawing.Point 300, 300
	$targetForm.Size = New-Object Drawing.Size 300, 200; $targetForm.TopMost = $true; $targetForm.AllowDrop = $true
	$targetForm.Text = 'drag self-test target'
	$targetForm.Add_DragEnter({ param($s, $e) $e.Effect = 'Copy' })
	$targetForm.Add_DragDrop({ param($s, $e) [Console]::WriteLine("self-test target received: " + ($e.Data.GetData('FileDrop') -join ',')) })
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
$source.Add_Shown({
	[Windows.Forms.Application]::DoEvents()
	$client = $source.PointToScreen((New-Object Drawing.Point 80, 30))
	$start = New-Object Drawing.Point $client.X, $client.Y
	$at = New-Object DragUser32+POINT; $at.X = $start.X; $at.Y = $start.Y
	[void][DragUser32]::SetCursorPos($start.X, $start.Y)
	if ([DragUser32]::GetAncestor([DragUser32]::WindowFromPoint($at), 2) -ne $source.Handle) {
		[Console]::WriteLine("aborted: the drag source is not under the cursor, so no button is pressed")
		$source.Close(); return
	}
	[DragUser32]::mouse_event(0x0002, 0, 0, 0, [UIntPtr]::Zero)  # left down on the source
	# The injected press is queued: start the drag only once Windows reports it.
	$deadline = [DateTime]::Now.AddMilliseconds(1500)
	while ((([Windows.Forms.Control]::MouseButtons -band 'Left') -eq 0) -and ([DateTime]::Now -lt $deadline)) {
		[Windows.Forms.Application]::DoEvents(); Start-Sleep -Milliseconds 10
	}
	# This thread sits in DoDragDrop's modal loop, so another process moves the mouse.
	Start-Process powershell.exe -WindowStyle Hidden -ArgumentList '-NoProfile', '-ExecutionPolicy', 'Bypass',
		'-File', (Join-Path $PSScriptRoot 'drag-mover.ps1'), $start.X, $start.Y, $target.X, $target.Y
	$data = New-Object Windows.Forms.DataObject
	$files = New-Object Collections.Specialized.StringCollection
	[void]$files.Add($File); $data.SetFileDropList($files)
	$effect = $source.DoDragDrop($data, [Windows.Forms.DragDropEffects]::Copy)
	[Console]::WriteLine("drop effect: $effect")
	if ($SelfTest) { $targetForm.Close() }
	$source.Close()
})
try {
	[Windows.Forms.Application]::Run($source)
} finally {
	# Let the mover's release land before the cursor goes back.
	Start-Sleep -Milliseconds 300
	[void][DragUser32]::SetCursorPos($userCursor.X, $userCursor.Y)
}
