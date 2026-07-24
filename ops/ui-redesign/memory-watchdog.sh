#!/usr/bin/env bash
set -euo pipefail

readonly PROJECT_NAME="${UI_REDESIGN_COMPOSE_PROJECT:-erp_ui_redesign}"
readonly MIN_AVAILABLE_MIB="${UI_REDESIGN_MIN_AVAILABLE_MIB:-1536}"
readonly CHECK_INTERVAL_SECONDS="${UI_REDESIGN_WATCHDOG_INTERVAL_SECONDS:-5}"
readonly BREACH_LIMIT="${UI_REDESIGN_WATCHDOG_BREACH_LIMIT:-3}"
readonly STOP_TIMEOUT_SECONDS="${UI_REDESIGN_STOP_TIMEOUT_SECONDS:-10}"
readonly MAX_CHECKS="${UI_REDESIGN_WATCHDOG_MAX_CHECKS:-0}"
readonly WAIT_FOR_START_SECONDS="${UI_REDESIGN_WATCHDOG_WAIT_FOR_START_SECONDS:-60}"

log() {
  printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$*"
}

available_memory_mib() {
  awk '/^MemAvailable:/ { print int($2 / 1024); exit }' /proc/meminfo
}

running_container_ids() {
  docker ps -q --filter "label=com.docker.compose.project=${PROJECT_NAME}"
}

breaches=0
checks=0
waited_seconds=0

log "watching project=${PROJECT_NAME} min_available=${MIN_AVAILABLE_MIB}MiB"

while true; do
  mapfile -t container_ids < <(running_container_ids)
  if ((${#container_ids[@]} > 0)); then
    break
  fi
  if ((waited_seconds >= WAIT_FOR_START_SECONDS)); then
    log "no project containers started within ${WAIT_FOR_START_SECONDS}s; watchdog exiting"
    exit 0
  fi
  sleep 1
  waited_seconds=$((waited_seconds + 1))
done

while true; do
  mapfile -t container_ids < <(running_container_ids)
  if ((${#container_ids[@]} == 0)); then
    log "no running project containers; watchdog exiting"
    exit 0
  fi

  available_mib="$(available_memory_mib)"
  if ((available_mib < MIN_AVAILABLE_MIB)); then
    breaches=$((breaches + 1))
    log "low memory: available=${available_mib}MiB breach=${breaches}/${BREACH_LIMIT}"
  else
    breaches=0
  fi

  if ((breaches >= BREACH_LIMIT)); then
    log "stopping isolated project after sustained low memory"
    docker stop --time "${STOP_TIMEOUT_SECONDS}" "${container_ids[@]}"
    exit 2
  fi

  checks=$((checks + 1))
  if ((MAX_CHECKS > 0 && checks >= MAX_CHECKS)); then
    log "max checks reached; watchdog exiting"
    exit 0
  fi

  sleep "${CHECK_INTERVAL_SECONDS}"
done
