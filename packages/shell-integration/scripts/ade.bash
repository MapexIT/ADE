# ADE shell integration for bash (4.4 or later). Loaded with --init-file, so it sources ~/.bashrc first.
if [ -f "$HOME/.bashrc" ]; then
  . "$HOME/.bashrc"
fi

__ade_escape() {
  local s="$1"
  s="${s//\\/\\\\}"
  s="${s//;/\\x3b}"
  s="${s//$'\n'/\\x0a}"
  printf '%s' "$s"
}

# Runs inside PS0, after the command is read and before it executes.
__ade_preexec() {
  local cmd
  cmd="$(HISTTIMEFORMAT='' builtin history 1 | sed 's/^ *[0-9]\+\*\? *//')"
  printf '\e]633;E;%s\a\e]133;C\a' "$(__ade_escape "$cmd")"
}

__ade_prompt_command() {
  local ec=$?
  printf '\e]133;D;%s\a' "$ec"
  printf '\e]7;file://%s%s\a' "${HOSTNAME:-localhost}" "$PWD"
  return $ec
}

if [[ "$PROMPT_COMMAND" != *__ade_prompt_command* ]]; then
  PROMPT_COMMAND="__ade_prompt_command${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
fi
PS0='$(__ade_preexec)'"${PS0:-}"
PS1='\[\e]133;A\a\]'"$PS1"'\[\e]133;B\a\]'
export ADE_SHELL_INTEGRATION=1
