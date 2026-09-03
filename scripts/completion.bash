# completion.bash — ths CLI bash/zsh 补全
#
# 安装（任选其一）:
#   1. 临时:  source scripts/completion.bash
#   2. 永久:  echo "source $(pwd)/scripts/completion.bash" >> ~/.bashrc
#   3. zsh:   echo "source $(pwd)/scripts/completion.bash" >> ~/.zshrc
#
# 为 `ths` 和 `node cli.js` 提供: 命令、周期、选股条件、回测策略、watchlist 子命令补全。

_ths_commands="search quote quotes kline trend turnover analyze compare scan watchlist backtest position market fundflow watch help"
_ths_periods="day week month quarter 60min 120min"
_ths_criteria="ma-bull ma-cross-up macd-golden macd-bull rsi-oversold rsi-overbought kdj-golden volume-break atr-range pattern score-gt"
_ths_strategies="ma-cross rsi macd buy-hold"
_ths_watch_actions="add remove list prices clear"
_ths_flags="--json --csv --compact --refresh --no-log --help"

_ths_comp() {
  local cur prev words cword
  if [[ -n "$BASH_VERSION" ]]; then
    cur="${COMP_WORDS[COMP_CWORD]}"
    prev="${COMP_WORDS[COMP_CWORD-1]}"
    words=("${COMP_WORDS[@]}")
    cword=$COMP_CWORD
  else  # zsh 兼容（bashcompinit）
    cur="${words[CURRENT-1]}"
    prev="${words[CURRENT-2]}"
  fi

  # 已输入的命令词（排除 --xxx）
  local cmd=""
  local w
  for w in "${words[@]:1:$cword}"; do
    [[ "$w" == -* ]] && continue
    cmd="$w"
    break
  done

  # 二级子命令 / 参数值补全
  case "$cmd" in
    watchlist)
      case "$prev" in
        add|remove) COMPREPLY=( $(compgen -W "" -- "$cur") ); return 0 ;;
        *) COMPREPLY=( $(compgen -W "$_ths_watch_actions" -- "$cur") ); return 0 ;;
      esac ;;
    watch)
      if [[ "$cur" == -* ]]; then
        COMPREPLY=( $(compgen -W "--interval --once --pool --codes --chase --drop --vol --until --quiet --json" -- "$cur") ); return 0
      fi ;;
    scan)
      case "$prev" in
        --criterion) COMPREPLY=( $(compgen -W "$_ths_criteria" -- "$cur") ); return 0 ;;
        --period)    COMPREPLY=( $(compgen -W "$_ths_periods" -- "$cur") ); return 0 ;;
        --pool)      COMPREPLY=( $(compgen -W "watchlist" -- "$cur") ); return 0 ;;
      esac ;;
    kline|analyze|trend|backtest)
      case "$prev" in
        --period)   COMPREPLY=( $(compgen -W "$_ths_periods" -- "$cur") ); return 0 ;;
        --strategy) COMPREPLY=( $(compgen -W "$_ths_strategies" -- "$cur") ); return 0 ;;
        --adjust)   COMPREPLY=( $(compgen -W "forward backward none" -- "$cur") ); return 0 ;;
      esac ;;
    quote|quotes|compare|position|fundflow)
      case "$prev" in
        --pool) COMPREPLY=( $(compgen -W "watchlist" -- "$cur") ); return 0 ;;
      esac ;;
    "")
      # 未输入命令: 补命令名
      COMPREPLY=( $(compgen -W "$_ths_commands" -- "$cur") )
      return 0 ;;
  esac

  # 通用: 命令后补 flag，flag 值后补对应值
  if [[ "$cur" == -* ]]; then
    COMPREPLY=( $(compgen -W "$_ths_flags" -- "$cur") )
  else
    COMPREPLY=( $(compgen -W "$_ths_commands" -- "$cur") )
  fi
  return 0
}

if [[ -n "$BASH_VERSION" ]]; then
  complete -F _ths_comp ths
  complete -F _ths_comp node cli.js
elif [[ -n "$ZSH_VERSION" ]]; then
  autoload -U +X bashcompinit && bashcompinit
  complete -F _ths_comp ths
fi
