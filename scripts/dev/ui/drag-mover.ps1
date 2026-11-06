# Moves the mouse for drag-file.ps1, whose own thread is inside DoDragDrop.
# Releases the left button once at the target, which is the drop.
#
# Before each step it checks that the cursor is still where the last step put it:
# a cursor moved by anything else (a hand, another program) means the drop would
# land somewhere it did not choose. It then stops at once without releasing,
# prints where the cursor was, and exits 3: drag-file.ps1 cancels the drag and
# releases the button itself. Any other failure exits 1, also without releasing.
param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY)
$ErrorActionPreference = "Stop"
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class MoverUser32 {
  [StructLayout(LayoutKind.Sequential)] public struct POINT { public int X; public int Y; }
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern bool GetCursorPos(out POINT p);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
}
"@
[void][MoverUser32]::SetProcessDpiAwarenessContext([IntPtr]-4)  # physical pixels, as drag-file.ps1

$script:expected = $null
$script:step = 0
function Check {
	$at = New-Object MoverUser32+POINT
	[void][MoverUser32]::GetCursorPos([ref]$at)
	if ($at.X -ne $script:expected.X -or $at.Y -ne $script:expected.Y) {
		[Console]::WriteLine("step $($script:step): cursor at ($($at.X),$($at.Y)), expected ($($script:expected.X),$($script:expected.Y))")
		exit 3
	}
}
function Step([int]$x, [int]$y) {
	Check
	[void][MoverUser32]::SetCursorPos($x, $y)
	[MoverUser32]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
	$script:expected = @{ X = $x; Y = $y }
	$script:step++
}

try {
	Start-Sleep -Milliseconds 400
	# The press happened at the start point: the cursor must still be there.
	$script:expected = @{ X = $FromX; Y = $FromY }
	$steps = 30
	for ($i = 1; $i -le $steps; $i++) {
		Step ([int]($FromX + ($ToX - $FromX) * $i / $steps)) ([int]($FromY + ($ToY - $FromY) * $i / $steps))
		Start-Sleep -Milliseconds 30
	}
	for ($i = 0; $i -lt 30; $i++) {  # hover, so dragover keeps arriving
		Step ($ToX + ($i % 2) * 3) $ToY
		Start-Sleep -Milliseconds 50
	}
	Step $ToX $ToY
	Start-Sleep -Milliseconds 50
	Check
} catch {
	[Console]::WriteLine("mover failed: $_")
	exit 1
}
[MoverUser32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # left up: the drop
exit 0
