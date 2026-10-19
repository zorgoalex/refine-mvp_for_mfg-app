# shellcheck shell=bash
# Literal .env reader for ops scripts (source this file, do not execute it).
#
# `set -a; source .env` runs every value through the shell: under `set -u` an
# unquoted `$` in an unrelated secret (a password with `$t`) aborts the script
# with "t: unbound variable", and `$$`/`$(...)` would expand or execute. This
# helper parses KEY=VALUE lines without any expansion instead. Supported: blank
# and `#` lines, optional `export `, spaces around `=`, single/double quotes
# around the whole value (optionally followed by ` # comment`), CRLF, ` #`
# inline comments on unquoted values. When a key repeats, the last value wins
# (as with `source`). No `${VAR}` references; a malformed line (e.g. an
# unterminated quote) fails the whole load before anything is exported.

# Export every KEY=VALUE of FILE into the environment (drop-in for
# `set -a; source FILE; set +a`).
load_env_file() {
  local file="$1" line lineno=0 rc i
  local -a keys=() values=()
  # An unreadable file must fail: callers use `load_env_file … || fail`, which
  # disables errexit here, and inherited variables would otherwise be used.
  if [[ ! -f "$file" || ! -r "$file" ]]; then
    printf 'ERROR: env file is not a readable file: %s\n' "$file" >&2
    return 1
  fi
  while IFS= read -r line || [[ -n "$line" ]]; do
    lineno=$((lineno + 1))
    rc=0; _env_file_next "$file" "$lineno" "$line" || rc=$?
    [[ "$rc" == "2" ]] && return 1
    if [[ "$rc" == "0" ]]; then
      keys+=("$_env_file_key")
      values+=("$_env_file_val")
    fi
  done < "$file" || return 1
  for i in "${!keys[@]}"; do
    export "${keys[$i]}=${values[$i]}" || return 1
  done
  return 0
}

# Parse one line into _env_file_key/_env_file_val. Returns 1 for blank/comment
# lines (skip) and 2 for a malformed line (callers abort; the value is never
# printed). Quoted values may be followed by ` # comment`; inside double quotes
# only \" and \\ are unescaped.
_env_file_parse_line() {
  local line="${1%$'\r'}" value
  [[ "$line" =~ ^[[:space:]]*(#.*)?$ ]] && return 1
  [[ "$line" =~ ^[[:space:]]*(export[[:space:]]+)?([A-Za-z_][A-Za-z0-9_]*)[[:space:]]*=(.*)$ ]] || return 2
  _env_file_key="${BASH_REMATCH[2]}"
  value="${BASH_REMATCH[3]}"
  # `KEY= # comment` is empty (as in bash); `KEY=#literal` keeps its `#`.
  if [[ "$value" =~ ^[[:space:]]+# ]]; then
    _env_file_val=""
    return 0
  fi
  value="${value#"${value%%[![:space:]]*}"}"
  if [[ "$value" == \'* ]]; then
    [[ "$value" =~ ^\'([^\']*)\'[[:space:]]*(#.*)?$ ]] || return 2
    value="${BASH_REMATCH[1]}"
  elif [[ "$value" == \"* ]]; then
    [[ "$value" =~ ^\"(([^\"\\]|\\.)*)\"[[:space:]]*(#.*)?$ ]] || return 2
    value="${BASH_REMATCH[1]}"
    value="${value//\\\"/\"}"
    value="${value//\\\\/\\}"
  else
    value="${value%%[[:space:]]#*}"
    value="${value%"${value##*[![:space:]]}"}"
  fi
  _env_file_val="$value"
}

_env_file_next() {
  local file="$1" lineno="$2" line="$3" rc=0
  _env_file_parse_line "$line" || rc=$?
  if [[ "$rc" == "2" ]]; then
    printf 'ERROR: malformed line %s in %s (value not shown)\n' "$lineno" "$file" >&2
  fi
  return "$rc"
}
