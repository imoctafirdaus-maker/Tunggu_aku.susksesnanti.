#!/data/data/com.termux/files/usr/bin/bash
DIR="$HOME/octa-analyzer/swc"
PID_FILE="$DIR/swc.pid"
LOG_FILE="$DIR/swc.log"

case "$1" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "🟢 SWC Backend sudah aktif (PID: $(cat "$PID_FILE"))."
      exit 0
    fi
    nohup node "$DIR/server.js" > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "✅ SWC Backend aktif di latar belakang (PID: $! | Port: 8765)."
    ;;
  stop)
    if [ -f "$PID_FILE" ]; then
      PID=$(cat "$PID_FILE")
      kill "$PID" 2>/dev/null || true
      rm -f "$PID_FILE"
      echo "🛑 SWC Backend dihentikan."
    else
      echo "ℹ️ SWC Backend tidak sedang berjalan."
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "🟢 Status SWC: AKTIF (PID: $(cat "$PID_FILE"))"
    else
      echo "🔴 Status SWC: MATI"
    fi
    tail -n 10 "$LOG_FILE" 2>/dev/null || true
    ;;
  *)
    echo "Gunakan: ./swc.sh {start|stop|status}"
    ;;
esac
