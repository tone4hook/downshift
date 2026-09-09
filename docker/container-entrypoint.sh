#!/bin/sh
set -eu

uid=${LAB_UID:-10001}
gid=${LAB_GID:-10001}
role=${LAB_CONTAINER_ROLE:-unknown}

case "$uid:$gid" in
  *[!0-9:]*|0:*|*:0|*:|:)
    printf 'LAB_UID and LAB_GID must be non-root decimal integers\n' >&2
    exit 2
    ;;
esac

initialize_volume() {
  path=$1
  if [ ! -d "$path" ] || [ -L "$path" ]; then
    printf 'required writable state directory is unavailable: %s\n' "$path" >&2
    exit 2
  fi
  chown -R "$uid:$gid" "$path"
}

case "$role" in
  agent)
    profile=${LAB_AUTH_PROFILE:-}
    case "$profile" in
      ""|*[!a-z0-9-]*|-*)
        printf 'LAB_AUTH_PROFILE must match [a-z0-9][a-z0-9-]{0,31}\n' >&2
        exit 2
        ;;
    esac
    if [ "${#profile}" -gt 32 ]; then
      printf 'LAB_AUTH_PROFILE must match [a-z0-9][a-z0-9-]{0,31}\n' >&2
      exit 2
    fi
    initialize_volume /pi-profile
    initialize_volume /project-state
    if [ "${LAB_AUTH_SETUP:-0}" = "1" ]; then
      mkdir -p /workspace/node_modules
    fi
    initialize_volume /workspace/node_modules
    if [ -d /package-cache ]; then
      initialize_volume /package-cache
    fi
    mkdir -p /project-state/home /project-state/sessions /project-state/settings
    chown "$uid:$gid" /project-state/home /project-state/sessions /project-state/settings
    export HOME=/project-state/home
    ;;
  project-helper)
    initialize_volume /workspace/node_modules
    initialize_volume /package-cache
    export HOME=/tmp
    ;;
  evaluator|mock)
    export HOME=/tmp
    ;;
  *)
    printf 'unknown LAB_CONTAINER_ROLE: %s\n' "$role" >&2
    exit 2
    ;;
esac

export TMPDIR=/tmp
if [ "$(id -u)" = "$uid" ] && [ "$(id -g)" = "$gid" ]; then
  exec "$@"
fi
exec setpriv \
  --reuid "$uid" \
  --regid "$gid" \
  --clear-groups \
  --inh-caps=-all \
  --ambient-caps=-all \
  --bounding-set=-all \
  -- "$@"
