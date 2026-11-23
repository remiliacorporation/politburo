#!/bin/sh
set +x
set -eu

# Usage: run-with-env.sh <env-file> -- <command> [args...]
# Put this executable first in launchd's ProgramArguments. Keep the env file
# outside the repo, in a directory where only trusted users can replace it.
# Use an owned regular file with mode 0600 or stricter. Values are literal;
# one pair of matching outer quotes is removed. Blank lines and # lines skip.

if [ "$#" -lt 3 ] || [ "$2" != -- ] || [ -z "$3" ]; then
    printf '%s\n' 'usage: run-with-env.sh <env-file> -- <command> [args...]' >&2
    exit 64
fi

config_error() {
    printf '%s: %s\n' "$1" "$2" >&2
    exit 78
}

load_env() {
    env_line_number=0
    while IFS= read -r env_line || [ -n "$env_line" ]; do
        env_line_number=$((env_line_number + 1))
        case $env_line in
            ''|'#'*) continue ;;
            *=*) env_key=${env_line%%=*} ;;
            *) env_key='' ;;
        esac
        case $env_key in
            ''|[0123456789]*|*[!ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz_0123456789]*)
                config_error "$1:$env_line_number" 'not KEY=VALUE' ;;
        esac
        env_value=${env_line#*=}
        case $env_value in
            \"*\"|\'*\') env_value=${env_value#?}; env_value=${env_value%?} ;;
        esac
        set -- "$@" "$env_key=$env_value"
    done

    # Export only after parsing, so keys cannot change the parser's variables.
    if [ "$#" -gt 1 ]; then
        export_env "$@" || config_error "$1" 'cannot export key'
    fi
}

export_env() {
    shift
    command export "$@" 2>/dev/null
}

stat_field() {
    stat -c "$1" "$3" 2>/dev/null || stat -f "$2" "$3" 2>/dev/null
}

case $1 in
    -*) env_stat_path=./$1 ;;
    *) env_stat_path=$1 ;;
esac
[ ! -L "$1" ] || config_error "$1" 'symlinks are not allowed'
[ -e "$1" ] || config_error "$1" 'does not exist'
[ -f "$1" ] || config_error "$1" 'not a regular file'
env_owner=$(stat_field %u %u "$env_stat_path") || config_error "$1" 'cannot check owner'
env_uid=$(id -u) || config_error "$1" 'cannot determine current user ID'
[ "$env_owner" = "$env_uid" ] || config_error "$1" 'not owned by the current user'
env_mode=$(stat_field %a %Lp "$env_stat_path") || config_error "$1" 'cannot check mode'
case $env_mode in
    0|200|400|600) ;;
    *) config_error "$1" 'mode must be 0600 or stricter' ;;
esac
[ -r "$1" ] || config_error "$1" 'not readable'

load_env "$1" < "$1" || config_error "$1" 'cannot read file'
shift 2
exec "$@"
