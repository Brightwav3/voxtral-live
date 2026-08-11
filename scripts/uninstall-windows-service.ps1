[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'Voxtral Daemon',
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$RemoveLogs
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$controlCli = Join-Path $resolvedRoot 'src\control-cli.mjs'
$task = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($task -and $PSCmdlet.ShouldProcess($TaskName, 'Stop and unregister scheduled task')) {
    if (Test-Path -LiteralPath $controlCli -PathType Leaf) {
        try {
            $nodePath = (Get-Command node.exe -ErrorAction Stop).Source
            & $nodePath $controlCli stop 2>$null | Out-Null
        } catch {
            Write-Verbose 'The daemon did not accept a graceful stop; stopping the scheduled task.'
        }
    }
    Stop-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

$logDirectory = Join-Path $env:LOCALAPPDATA 'Voxtral\logs'
if ($RemoveLogs -and (Test-Path -LiteralPath $logDirectory) `
    -and $PSCmdlet.ShouldProcess($logDirectory, 'Remove Voxtral logs')) {
    Remove-Item -LiteralPath $logDirectory -Recurse -Force
}

[pscustomobject]@{
    TaskName = $TaskName
    Removed = [bool]$task
    LogsPreserved = -not $RemoveLogs
}
