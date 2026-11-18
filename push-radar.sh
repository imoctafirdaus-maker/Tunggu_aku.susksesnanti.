#!/data/data/com.termux/files/usr/bin/bash
set -e
cd ~/octa-analyzer

# Pastikan tag skrip swc-ui.js tetap terjaga di index.html sebelum push
if [ -f index.html ] && ! grep -q "swc-ui.js" index.html; then
  sed -i 's|</body>|<script src="swc/swc-ui.js"></script>\n</body>|i' index.html
  echo "[INFO] Tag swc-ui.js otomatis dipulihkan di index.html."
fi

# Hanya tambahkan file di luar folder swc/
git add -- ':!swc/*' ':!swc.sh' ':!push-radar.sh'
MSG="${1:-Update crypto radar}"
git commit -m "$MSG" && git push origin main
echo "[OK] Crypto radar berhasil di-push tanpa menyentuh router Wi-Fi (swc/)."
