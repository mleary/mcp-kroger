#!/usr/bin/env bash
# Claude Code status line - mirrors zsh PROMPT style

input=$(cat)

cwd=$(echo "$input" | jq -r '.cwd // empty')
model=$(echo "$input" | jq -r '.model.display_name // empty')
transcript_path=$(echo "$input" | jq -r '.transcript_path // empty')
used_pct=$(echo "$input" | jq -r '.context_window.used_percentage // empty')
used_tokens=$(echo "$input" | jq -r '.context_window.total_input_tokens // empty')
total_tokens=$(echo "$input" | jq -r '.context_window.context_window_size // empty')

# Format a token count as e.g. 10k or 1.2M
fmt_tokens() {
  local n="$1"
  if [[ -z "$n" || "$n" == "null" ]]; then
    echo ""
  elif (( n >= 1000000 )); then
    awk -v n="$n" 'BEGIN { printf "%.1fM", n/1000000 }'
  elif (( n >= 1000 )); then
    awk -v n="$n" 'BEGIN { printf "%.0fk", n/1000 }'
  else
    echo "$n"
  fi
}

# ANSI colors
magenta='\033[0;35m'
yellow='\033[0;33m'
green='\033[0;32m'
red='\033[0;31m'
reset='\033[0m'

# Shorten cwd: replace $HOME with ~
home_dir="$HOME"
short_cwd="${cwd/#$home_dir/~}"

# Git branch (skip optional locks)
branch_info=$(git -C "$cwd" rev-parse --abbrev-ref HEAD 2>/dev/null)

# Build context indicator
if [[ -n "$branch_info" ]]; then
  if [[ "$branch_info" == "HEAD" ]]; then
    display_text="HEAD (detached)"
  else
    display_text="$branch_info"
  fi
  context_indicator=" 🌿$(printf "${yellow}(${display_text})${reset}")"
else
  context_indicator=""
fi

# Context window info
ctx_info=""
if [[ -n "$used_tokens" && -n "$total_tokens" ]]; then
  used_str=$(fmt_tokens "$used_tokens")
  total_str=$(fmt_tokens "$total_tokens")
  pct_str=""
  if [[ -n "$used_pct" ]]; then
    pct_str=" $(printf '%.0f' "$used_pct")%"
  fi
  ctx_info=" [ctx: ${used_str}/${total_str}${pct_str}]"
elif [[ -n "$used_pct" ]]; then
  ctx_info=" [ctx: $(printf '%.0f' "$used_pct")%]"
fi

# Model info
model_info=""
if [[ -n "$model" ]]; then
  model_info=" [$model]"
fi

# Prompt cache: real TTL, time left, hit ratio, last miss cause.
# Reads Claude Code's own prompt_cache object (needs CC v2.1.251+). On a Claude
# subscription the main conversation usually gets a 1h TTL, not 5m. The minutes
# only update when the status line redraws, so they freeze while you're idle.
cache_info=""
IFS='|' read -r pc_warm pc_exp pc_ttl pc_hit pc_miss <<<"$(echo "$input" | jq -r '
  .prompt_cache // {} |
  [ (if .warm == null then "" else (.warm|tostring) end), (.expires_at // "" | tostring), (.ttl // ""),
    (if .hit_ratio then (.hit_ratio*100|round|tostring) else "" end),
    ((.last_miss_cause.causes // []) | join(",")) ] | join("|")')"

if [[ "$pc_warm" == "true" && -n "$pc_exp" ]]; then
  remaining=$(( ${pc_exp%.*} - $(date +%s) ))
  if (( remaining > 0 )); then
    mins=$(( remaining / 60 ))
    # yellow in the last ~10% of the TTL
    if [[ "$pc_ttl" == "1h" ]]; then warn=360; else warn=30; fi
    if (( remaining > warn )); then cache_color="$green"; else cache_color="$yellow"; fi
    cache_info=" $(printf "${cache_color}⏳%dm${reset}" "$mins")"
  else
    cache_info=" $(printf "${red}❄ cold${reset}")"
  fi
elif [[ "$pc_warm" == "false" ]]; then
  cache_info=" $(printf "${red}❄ cold${reset}")"
fi
[[ -n "$pc_hit" ]]  && cache_info+=" ${pc_hit}%"
[[ -n "$pc_miss" ]] && cache_info+=" $(printf "${yellow}⚠ %s${reset}" "$pc_miss")"

printf "${magenta}%s${reset}%s%s%s%b\n" "$short_cwd" "$context_indicator" "$model_info" "$ctx_info" "$cache_info"
