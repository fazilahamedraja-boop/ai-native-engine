param(
  [Parameter(Mandatory = $true)][int]$ProcessId,
  [Parameter(Mandatory = $true)][string]$Output
)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @"
using System;
using System.Runtime.InteropServices;

public static class Phase18WindowCapture {
    [StructLayout(LayoutKind.Sequential)]
    public struct RECT {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [DllImport("user32.dll")]
    public static extern bool GetClientRect(IntPtr hWnd, out RECT lpRect);

    [DllImport("user32.dll")]
    public static extern bool PrintWindow(IntPtr hwnd, IntPtr hdcBlt, uint nFlags);

    [DllImport("user32.dll")]
    public static extern bool ClientToScreen(IntPtr hWnd, ref POINT lpPoint);

    [DllImport("user32.dll")]
    public static extern bool SetForegroundWindow(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    public static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder text, int count);

    [DllImport("user32.dll")]
    public static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDpiAwarenessContext(IntPtr value);

    [DllImport("user32.dll")]
    public static extern bool SetProcessDPIAware();

    public delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [StructLayout(LayoutKind.Sequential)]
    public struct POINT {
        public int X;
        public int Y;
    }
}
"@

# This PowerShell host may be DPI-unaware; without this, GetClientRect returns
# virtualized 1024x576 for a 1280x720 game window on a 125% display.
[void][Phase18WindowCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))
if (-not [Phase18WindowCapture]::SetProcessDpiAwarenessContext([IntPtr](-4))) {
    [void][Phase18WindowCapture]::SetProcessDPIAware()
}

$process = Get-Process -Id $ProcessId -ErrorAction Stop
$handle = [IntPtr]$process.MainWindowHandle
$deadline = (Get-Date).AddSeconds(5)
while ($handle -eq [IntPtr]::Zero -and (Get-Date) -lt $deadline) {
    Start-Sleep -Milliseconds 200
    $process.Refresh()
    $handle = [IntPtr]$process.MainWindowHandle
}
if ($handle -eq [IntPtr]::Zero) {
    # Node's spawned process can report MainWindowHandle == 0 even though the
    # Godot window exists. Enumerate top-level windows and select the visible
    # game window by title, preferring this process ID.
    $candidates = New-Object System.Collections.ArrayList
    $callback = [Phase18WindowCapture+EnumWindowsProc]{
        param([IntPtr]$window, [IntPtr]$state)
        $owner = [uint32]0
        [void][Phase18WindowCapture]::GetWindowThreadProcessId($window, [ref]$owner)
        $title = New-Object System.Text.StringBuilder 256
        [void][Phase18WindowCapture]::GetWindowText($window, $title, 256)
        if ([Phase18WindowCapture]::IsWindowVisible($window) -and $title.ToString() -match 'deflect') {
            [void]$candidates.Add([pscustomobject]@{
                Handle = $window
                ProcessId = $owner
                Title = $title.ToString()
            })
        }
        return $true
    }
    [void][Phase18WindowCapture]::EnumWindows($callback, [IntPtr]::Zero)
    $selected = $candidates | Where-Object { $_.ProcessId -eq $ProcessId } | Select-Object -First 1
    if (-not $selected) { $selected = $candidates | Select-Object -First 1 }
    if (-not $selected) {
        throw "process $ProcessId has no visible deflect game window"
    }
    $handle = [IntPtr]$selected.Handle
}

$rect = New-Object Phase18WindowCapture+RECT
if (-not [Phase18WindowCapture]::GetClientRect($handle, [ref]$rect)) {
    throw "GetClientRect failed"
}
$width = $rect.Right - $rect.Left
$height = $rect.Bottom - $rect.Top
if ($width -le 0 -or $height -le 0) {
    throw "invalid client size ${width}x${height}"
}

$bitmap = New-Object System.Drawing.Bitmap($width, $height)
$graphics = [System.Drawing.Graphics]::FromImage($bitmap)
try {
    $hdc = $graphics.GetHdc()
    try {
        # PW_CLIENTONLY = 1: capture only the render viewport, not the title bar.
        $captured = [Phase18WindowCapture]::PrintWindow($handle, $hdc, 1)
    } finally {
        $graphics.ReleaseHdc($hdc)
    }

    if (-not $captured) {
        # Some drivers do not implement PrintWindow. Fall back to the visible
        # client area after bringing the window forward.
        [void][Phase18WindowCapture]::SetForegroundWindow($handle)
        Start-Sleep -Milliseconds 250
        $origin = New-Object Phase18WindowCapture+POINT
        $origin.X = 0
        $origin.Y = 0
        if (-not [Phase18WindowCapture]::ClientToScreen($handle, [ref]$origin)) {
            throw "ClientToScreen failed"
        }
        $graphics.CopyFromScreen($origin.X, $origin.Y, 0, 0, (New-Object System.Drawing.Size($width, $height)))
    }

    $directory = Split-Path -Parent $Output
    if ($directory -and -not (Test-Path -LiteralPath $directory)) {
        New-Item -ItemType Directory -Force -Path $directory | Out-Null
    }
    $bitmap.Save($Output, [System.Drawing.Imaging.ImageFormat]::Png)
} finally {
    $graphics.Dispose()
    $bitmap.Dispose()
}

$info = Get-Item -LiteralPath $Output
Write-Output ("CAPTURED {0}x{1} {2} {3}" -f $width, $height, $info.Length, $Output)
