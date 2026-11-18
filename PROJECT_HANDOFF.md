# OCTA-ANALYZER — ARSITEKTUR & ATURAN PENGEMBANGAN
- Lokasi Scanner: ~/octa-analyzer/scanner/ (scan.js, autoTrader.js, dualAiGatekeeper.js)
- Backup Asli: ~/octa-backup-original/scanner/
- ATURAN MUTLAK: DILARANG menyentuh kode/modul pengaturan router Wi-Fi.
- Alur Utama: Termux (scan.js) -> Groq (Tahap 1) -> Gemini (Tahap 2) -> Termux (autoTrader.js) -> Binance Futures Testnet (Cross 50x, Risk 1%).
- Larangan Teknis: Jangan instal LiteLLM Python di Termux (OOM Killed / Rust exit 101); gunakan Node.js murni.
