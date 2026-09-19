# Moves the mouse for drag-file.ps1, whose own thread is inside DoDragDrop.
# Always releases the left button at the end, which is the drop.
param([int]$FromX, [int]$FromY, [int]$ToX, [int]$ToY)
Add-Type @"
using System; using System.Runtime.InteropServices;
public static class MoverUser32 {
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y);
  [DllImport("user32.dll")] public static extern void mouse_event(uint f, int dx, int dy, uint d, UIntPtr e);
}
"@
[void][MoverUser32]::SetProcessDpiAwarenessContext([IntPtr]-4)
try {
	Start-Sleep -Milliseconds 400
	$steps = 30
	for ($i = 1; $i -le $steps; $i++) {
		[void][MoverUser32]::SetCursorPos([int]($FromX + ($ToX - $FromX) * $i / $steps), [int]($FromY + ($ToY - $FromY) * $i / $steps))
		[MoverUser32]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
		Start-Sleep -Milliseconds 30
	}
	for ($i = 0; $i -lt 30; $i++) {  # hover, so dragover keeps arriving
		[void][MoverUser32]::SetCursorPos($ToX + ($i % 2) * 3, $ToY)
		[MoverUser32]::mouse_event(0x0001, 0, 0, 0, [UIntPtr]::Zero)
		Start-Sleep -Milliseconds 50
	}
} finally {
	[MoverUser32]::mouse_event(0x0004, 0, 0, 0, [UIntPtr]::Zero)  # left up: the drop
}
