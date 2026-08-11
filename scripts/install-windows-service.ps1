[CmdletBinding(SupportsShouldProcess)]
param(
    [string]$TaskName = 'Voxtral Daemon',
    [string]$ProjectRoot = (Split-Path -Parent $PSScriptRoot),
    [switch]$StartNow
)

$ErrorActionPreference = 'Stop'
$resolvedRoot = (Resolve-Path -LiteralPath $ProjectRoot).Path
$daemonPath = Join-Path $resolvedRoot 'src\daemon.mjs'
$environmentPath = Join-Path $resolvedRoot '.env'
if (-not (Test-Path -LiteralPath $daemonPath -PathType Leaf)) {
    throw "Daemon entrypoint not found: $daemonPath"
}
if (-not (Test-Path -LiteralPath $environmentPath -PathType Leaf)) {
    throw "Create $environmentPath before installing the daemon task."
}

$nodePath = (Get-Command node.exe -ErrorAction Stop).Source
$identity = [Security.Principal.WindowsIdentity]::GetCurrent().Name
$logDirectory = Join-Path $env:LOCALAPPDATA 'Voxtral\logs'
New-Item -ItemType Directory -Path $logDirectory -Force | Out-Null
$stdoutLog = Join-Path $logDirectory 'daemon.stdout.log'
$stderrLog = Join-Path $logDirectory 'daemon.stderr.log'

$daemonCommand = '""{0}" --env-file=.env "{1}" 1>>"{2}" 2>>"{3}""' -f `
    $nodePath, $daemonPath, $stdoutLog, $stderrLog
$action = New-ScheduledTaskAction `
    -Execute $env:ComSpec `
    -Argument "/d /s /c $daemonCommand" `
    -WorkingDirectory $resolvedRoot
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $identity
$principal = New-ScheduledTaskPrincipal -UserId $identity -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -StartWhenAvailable `
    -MultipleInstances IgnoreNew `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)
$task = New-ScheduledTask -Action $action -Trigger $trigger -Principal $principal -Settings $settings

if ($PSCmdlet.ShouldProcess($TaskName, "Register current-user logon task for $identity")) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $task -Force | Out-Null
    if ($StartNow) {
        Start-ScheduledTask -TaskName $TaskName
    }
}

[pscustomobject]@{
    TaskName = $TaskName
    User = $identity
    ProjectRoot = $resolvedRoot
    LogDirectory = $logDirectory
    StartsAfterLogin = $true
}
