#!/usr/bin/env bash
DIR="$HOME/octa-analyzer"
PID_FILE="$DIR/bot.pid"
LOG_FILE="$DIR/bot.log"

case "$1" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "⚠️ Bot sudah berjalan (PID: $(cat "$PID_FILE"))."
      exit 0
    fi
    command -v termux-wake-lock >/dev/null && termux-wake-lock
    nohup bash -c '
      while true; do
        echo "=== [$(date "+%Y-%m-%d %H:%M:%S")] Mulai Scan ===" >> "'"$LOG_FILE"'"
        cd "'"$DIR"'" && SCANNER_SOURCE="termux-bot" node scanner/scan.js >> "'"$LOG_FILE"'" 2>&1
        tail -n 300 "'"$LOG_FILE"'" > "'"$LOG_FILE"'.tmp" && mv "'"$LOG_FILE"'.tmp" "'"$LOG_FILE"'"
        sleep 300
      done
    ' >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅ Bot otomatis aktif di latar belakang (PID: $!)."
    echo "   Interval: setiap 5 menit (300 detik)."
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      pkill -P "$PID" 2>/dev/null
      kill "$PID" 2>/dev/null
      pkill -f "scanner/scan.js" 2>/dev/null
      rm -f "$PID_FILE"
      command -v termux-wake-unlock >/dev/null && termux-wake-unlock
      echo "🛑 Bot otomatis dihentikan."
    else
      echo "ℹ️ Bot sedang tidak berjalan."
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "🟢 Status: AKTIF (PID: $(cat "$PID_FILE"))"
      echo "--- 10 Baris Log Terakhir ---"
      tail -n 10 "$LOG_FILE" 2>/dev/null
    else
      echo "🔴 Status: MATI"
    fi
    ;;
  *)
    echo "Gunakan: ./bot.sh start | ./bot.sh status | ./bot.sh stop"
    ;;
esac
