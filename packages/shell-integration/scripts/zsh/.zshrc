# ADE shell integration for zsh. ADE points ZDOTDIR here; restore the user's and load their config first.
ZDOTDIR="${ADE_USER_ZDOTDIR:-$HOME}"
unset ADE_USER_ZDOTDIR
[ -f "$ZDOTDIR/.zshrc" ] && source "$ZDOTDIR/.zshrc"

__ade_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  printf '%s' "$s"
}

__ade_precmd() {
  local ec=$?
  if [[ -n "$__ade_running" ]]; then
    printf '\e]133;D;%s\a' "$ec"
    unset __ade_running
  fi
  printf '\e]7;file://%s%s\a' "${HOST:-localhost}" "$PWD"
  printf '\e]133;A\a'
}

__ade_preexec() {
  __ade_running=1
  printf '\e]633;E;%s\a\e]133;C\a' "$(__ade_escape "$1")"
}

autoload -Uz add-zsh-hook
add-zsh-hook precmd __ade_precmd
add-zsh-hook preexec __ade_preexec
PS1="${PS1}%{"$'\e]133;B\a'"%}"
export ADE_SHELL_INTEGRATION=1
