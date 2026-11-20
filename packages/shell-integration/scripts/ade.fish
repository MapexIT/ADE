# ADE shell integration for fish. Loaded with --init-command after the user's config.
function __ade_escape
    string replace -a '\\' '\\\\' -- $argv | string replace -a ';' '\\x3b' | string join '\\x0a'
end

function __ade_prompt --on-event fish_prompt
    printf '\e]7;file://%s%s\a' (hostname) $PWD
    printf '\e]133;A\a'
end

function __ade_preexec --on-event fish_preexec
    printf '\e]633;E;%s\a\e]133;C\a' (__ade_escape $argv)
end

function __ade_postexec --on-event fish_postexec
    printf '\e]133;D;%s\a' $status
end

set -gx ADE_SHELL_INTEGRATION 1
