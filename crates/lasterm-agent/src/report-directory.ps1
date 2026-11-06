# lasterm: report the current directory at every prompt.
# Windows PowerShell 5.1 and PowerShell 7. Keep it at the end of $PROFILE, after
# anything that sets your prompt: it keeps that prompt, and writes OSC 7 before it.
& {
    $inner = $function:prompt
    if ("$inner" -like '*lasterm-report-directory*') { return } # wrapped already
    if (-not $inner) { $inner = {} }
    $esc = [char]27
    $hostName = [System.Net.Dns]::GetHostName()
    $function:global:prompt = {
        # lasterm-report-directory: your prompt, after OSC 7 file://<host>/<path>
        $shown = @(& $inner)
        $location = $executionContext.SessionState.Path.CurrentLocation
        if ($location.Provider.Name -eq 'FileSystem') {
            $path = $location.ProviderPath.Replace([IO.Path]::DirectorySeparatorChar, '/')
            $uri = @(foreach ($part in $path.Split('/')) { [Uri]::EscapeDataString($part) }) -join '/'
            if (-not $uri.StartsWith('/')) { $uri = '/' + $uri }
            $Host.UI.Write("$esc]7;file://$hostName$uri$esc\")
        }
        $shown
    }.GetNewClosure()
}
