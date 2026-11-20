# ADE shell integration for PowerShell 7 and Windows PowerShell 5.1.
# Dot-sourced into the global scope by ADE after the user's profile.
if ($PROFILE -and (Test-Path $PROFILE)) { . $PROFILE }

$global:__AdeEsc = [char]27
$global:__AdeBel = [char]7
$global:__AdeRunning = $false
$global:__AdeLastHistoryId = -1
$global:__AdeOriginalPrompt = $function:prompt

function global:__AdeOsc([string]$body) { return "$($global:__AdeEsc)]$body$($global:__AdeBel)" }

function global:prompt {
    $ok = $?
    $ec = $global:LASTEXITCODE
    $out = ''
    if ($global:__AdeRunning) {
        $global:__AdeRunning = $false
        $last = Get-History -Count 1
        $code = 0
        if ($last -and $last.Id -ne $global:__AdeLastHistoryId) {
            $global:__AdeLastHistoryId = $last.Id
            if (-not $ok) { if ($ec) { $code = $ec } else { $code = 1 } }
        }
        $out += __AdeOsc "133;D;$code"
    }
    $loc = $ExecutionContext.SessionState.Path.CurrentLocation
    if ($loc.Provider.Name -eq 'FileSystem') {
        $out += __AdeOsc "7;file://localhost/$($loc.ProviderPath -replace '\\', '/')"
    }
    $out += __AdeOsc '133;A'
    $out += & $global:__AdeOriginalPrompt
    $out += __AdeOsc '133;B'
    return $out
}

if (Get-Module -Name PSReadLine) {
    Set-PSReadLineKeyHandler -Chord Enter -ScriptBlock {
        $line = $null
        $cursor = $null
        [Microsoft.PowerShell.PSConsoleReadLine]::GetBufferState([ref]$line, [ref]$cursor)
        $escaped = $line -replace '\\', '\\' -replace ';', '\x3b' -replace "`r", '' -replace "`n", '\x0a'
        [Console]::Write((__AdeOsc "633;E;$escaped"))
        [Microsoft.PowerShell.PSConsoleReadLine]::AcceptLine()
        $global:__AdeRunning = $true
        [Console]::Write((__AdeOsc '133;C'))
    }
}

$env:ADE_SHELL_INTEGRATION = '1'
