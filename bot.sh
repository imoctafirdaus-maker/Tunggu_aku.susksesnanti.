#!/data/data/com.termux/files/usr/bin/bash
cd ~/octa-analyzer
PID_FILE="scanner/bot.pid"
LOG_FILE="scanner/bot.log"

case "$1" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "🟢 Bot sudah berjalan (PID: $(cat "$PID_FILE"))."
      exit 0
    fi
    nohup bash -c '
      cd ~/octa-analyzer
      LAST_SCAN=0
      PREV_STATE="off"
      while true; do
        STATE=$(curl -s --max-time 6 "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app/emaSignals/_botControl/autoTrade.json" || echo "null")
        NOW=$(date +%s)
        if [ "$STATE" = "true" ]; then
          # Jika baru saja diubah dari OFF ke ON, langsung scan tanpa menunggu 5 menit!
          if [ "$PREV_STATE" != "true" ] || [ $((NOW - LAST_SCAN)) -ge 300 ]; then
            echo "=== [$(date "+%Y-%m-%d %H:%M:%S")] Mulai Scan (Sakelar ON) ===" >> scanner/bot.log
            node scanner/scan.js >> scanner/bot.log 2>&1
            LAST_SCAN=$(date +%s)
          fi
          PREV_STATE="true"
        else
          if [ "$PREV_STATE" = "true" ]; then
            echo "=== [$(date "+%Y-%m-%d %H:%M:%S")] Mode Standby (Sakelar OFF) ===" >> scanner/bot.log
          fi
          PREV_STATE="false"
        fi
        sleep 5
      done
    ' >/dev/null 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅ Bot otomatis aktif di latar belakang (PID: $!)."
    echo "   Siap merespons sakelar ON/OFF dari PWA dalam 5 detik."
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      pkill -P "$PID" 2>/dev/null
      kill "$PID" 2>/dev/null
      rm -f "$PID_FILE"
      echo "🛑 Bot otomatis dihentikan."
    else
      echo "ℹ️ Tidak ada proses bot yang sedang berjalan."
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "🟢 Status: AKTIF (PID: $(cat "$PID_FILE"))"
    else
      echo "🔴 Status: MATI"
    fi
    echo "--- 10 Baris Log Terakhir ---"
    tail -n 10 "$LOG_FILE" 2>/dev/null
    ;;
  *)
    echo "Gunakan: ./bot.sh {start|stop|status}"
    ;;
esac
