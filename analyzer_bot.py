
import math
import time
import statistics
from datetime import datetime
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# ================= KONFIGURASI UTAMA =================
FIREBASE_BASE = "https://cryptosignalradar-default-rtdb.asia-southeast1.firebasedatabase.app"
CTRL_URL = f"{FIREBASE_BASE}/emaSignals/_botControl.json"
SIGNALS_URL = f"{FIREBASE_BASE}/emaSignals"

REST_ENDPOINTS = [
    "https://data-api.binance.vision",
    "https://api.binance.com",
    "https://api-gcp.binance.com",
    "https://api1.binance.com",
    "https://api2.binance.com",
    "https://api3.binance.com",
]

MIN_EXEC_PROB = 75
SCAN_INTERVAL_SEC = 30
TOP_LIQUID_LIMIT = 30
COST_PCT = 0.0012

GROUPS = {
    "ema": "trend", "sma": "trend", "macd": "trend", "adx": "trend",
    "rsi": "momentum", "stochrsi": "momentum", "cci": "momentum",
    "bb": "band", "atr": "band", "obv": "volume"
}
GROUP_W = {"trend": 0.35, "momentum": 0.25, "band": 0.20, "volume": 0.20}

SESSION = requests.Session()


def clamp(n, a, b):
    return max(a, min(b, n))


def mean(arr):
    valid = [x for x in arr if x is not None and not math.isnan(x)]
    return statistics.fmean(valid) if valid else float("nan")


def is_finite(x):
    return x is not None and isinstance(x, (int, float)) and math.isfinite(x)


def api_fetch(path, timeout=10):
    last_err = None
    for base in REST_ENDPOINTS:
        try:
            r = SESSION.get(base + path, timeout=timeout)
            if r.status_code == 200:
                return r.json()
            last_err = Exception(f"HTTP {r.status_code}")
        except Exception as e:
            last_err = e
    raise last_err or Exception("Semua endpoint Binance gagal")


# ================= INDIKATOR TEKNIKAL (SETARA TA.JS) =================
class TA:
    @staticmethod
    def ema_series(a, p):
        n = len(a)
        out = [float("nan")] * n
        if n < p:
            return out
        v = mean(a[:p])
        out[p - 1] = v
        k = 2.0 / (p + 1)
        for i in range(p, n):
            v = a[i] * k + v * (1.0 - k)
            out[i] = v
        return out

    @classmethod
    def ema(cls, a, p):
        s = cls.ema_series(a, p)
        return s[-1] if s else float("nan")

    @staticmethod
    def sma(a, p):
        return mean(a[-p:]) if len(a) >= p else float("nan")

    @staticmethod
    def sma_series(a, p):
        out = []
        for i in range(len(a)):
            if i < p - 1:
                out.append(float("nan"))
            else:
                w = a[i - p + 1 : i + 1]
                out.append(mean(w) if all(is_finite(x) for x in w) else float("nan"))
        return out

    @staticmethod
    def rsi_series(a, p=14):
        n = len(a)
        out = [float("nan")] * n
        if n < p + 1:
            return out
        g, l = 0.0, 0.0
        for i in range(1, p + 1):
            d = a[i] - a[i - 1]
            g += max(d, 0.0)
            l += max(-d, 0.0)
        g /= p
        l /= p
        out[p] = (50.0 if g == 0 else 100.0) if l == 0 else 100.0 - 100.0 / (1.0 + g / l)
        for i in range(p + 1, n):
            d = a[i] - a[i - 1]
            g = (g * (p - 1) + max(d, 0.0)) / p
            l = (l * (p - 1) + max(-d, 0.0)) / p
            out[i] = (50.0 if g == 0 else 100.0) if l == 0 else 100.0 - 100.0 / (1.0 + g / l)
        return out

    @classmethod
    def rsi(cls, a, p=14):
        s = cls.rsi_series(a, p)
        return s[-1] if s else float("nan")

    @classmethod
    def stoch_rsi(cls, a, rp=14, sp=14, kp=3, dp=3):
        rs = cls.rsi_series(a, rp)
        raw = []
        for i in range(len(rs)):
            if i < sp - 1:
                raw.append(float("nan"))
                continue
            w = rs[i - sp + 1 : i + 1]
            if not all(is_finite(x) for x in w):
                raw.append(float("nan"))
                continue
            hi, lo = max(w), min(w)
            raw.append(50.0 if hi == lo else (rs[i] - lo) / (hi - lo) * 100.0)
        k = cls.sma_series(raw, kp)
        d = cls.sma_series(k, dp)
        return {"k": k[-1], "d": d[-1]}

    @classmethod
    def macd(cls, a):
        if len(a) < 35:
            return {"line": float("nan"), "signal": float("nan"), "histogram": float("nan")}
        e12 = cls.ema_series(a, 12)
        e26 = cls.ema_series(a, 26)
        m = [e12[i] - e26[i] for i in range(25, len(a))]
        sg = cls.ema_series(m, 9)
        line, signal = m[-1], sg[-1]
        return {"line": line, "signal": signal, "histogram": line - signal}

    @staticmethod
    def bb(a, p=20, k=2):
        if len(a) < p:
            return {"upper": float("nan"), "middle": float("nan"), "lower": float("nan")}
        s = a[-p:]
        m = mean(s)
        sd = math.sqrt(mean([(x - m) ** 2 for x in s]))
        return {"upper": m + k * sd, "middle": m, "lower": m - k * sd}

    @staticmethod
    def atr_series(h, l, c, p=14):
        n = len(c)
        out = [float("nan")] * n
        if n < p + 1:
            return out
        tr = [0.0] * n
        for j in range(1, n):
            tr[j] = max(h[j] - l[j], abs(h[j] - c[j - 1]), abs(l[j] - c[j - 1]))
        v = mean(tr[1 : p + 1])
        out[p] = v
        for i in range(p + 1, n):
            v = (v * (p - 1) + tr[i]) / p
            out[i] = v
        return out

    @staticmethod
    def adx(h, l, c, p=14):
        n = len(c)
        if n < 2 * p + 2:
            return {"adx": float("nan"), "plusDI": float("nan"), "minusDI": float("nan")}
        tr, pd, md = [], [], []
        for i in range(1, n):
            up, dn = h[i] - h[i - 1], l[i - 1] - l[i]
            pd.append(up if (up > dn and up > 0) else 0.0)
            md.append(dn if (dn > up and dn > 0) else 0.0)
            tr.append(max(h[i] - l[i], abs(h[i] - c[i - 1]), abs(l[i] - c[i - 1])))
        sT, sP, sM = sum(tr[:p]), sum(pd[:p]), sum(md[:p])
        dxs = []
        pdi, mdi = 0.0, 0.0

        def calc():
            nonlocal pdi, mdi
            pdi = (100.0 * sP / sT) if sT else 0.0
            mdi = (100.0 * sM / sT) if sT else 0.0
            dxs.append((100.0 * abs(pdi - mdi) / (pdi + mdi)) if (pdi + mdi) else 0.0)

        calc()
        for i in range(p, len(tr)):
            sT = sT - sT / p + tr[i]
            sP = sP - sP / p + pd[i]
            sM = sM - sM / p + md[i]
            calc()
        if len(dxs) < p:
            return {"adx": float("nan"), "plusDI": pdi, "minusDI": mdi}
        a = mean(dxs[:p])
        for j in range(p, len(dxs)):
            a = (a * (p - 1) + dxs[j]) / p
        return {"adx": a, "plusDI": pdi, "minusDI": mdi}

    @staticmethod
    def cci(h, l, c, p=20):
        n = len(c)
        if n < p:
            return float("nan")
        tp = [(h[i] + l[i] + c[i]) / 3.0 for i in range(n - p, n)]
        m = mean(tp)
        md = mean([abs(x - m) for x in tp])
        return 0.0 if md == 0 else (tp[-1] - m) / (0.015 * md)

    @staticmethod
    def obv_series(cs):
        out = [0.0] * len(cs)
        for i in range(1, len(cs)):
            d = cs[i]["close"] - cs[i - 1]["close"]
            out[i] = out[i - 1] + (cs[i]["volume"] if d > 0 else (-cs[i]["volume"] if d < 0 else 0.0))
        return out


# ================= 1. EARLY VOLUME RADAR =================
def analyze_radar(cs, price, q24):
    n = len(cs)
    if n < 36:
        return None
    c = [x["close"] for x in cs]
    h = [x["high"] for x in cs]
    l = [x["low"] for x in cs]
    qv = [x["qv"] for x in cs]

    recent = []
    for i in range(n - 12, n):
        b = mean(qv[i - 20 : i])
        recent.append({"rv": (qv[i] / b) if b > 0 else float("nan"), "open": cs[i]["open"], "time": cs[i]["time"]})

    rvol = recent[-1]["rv"]
    bp = mean(qv[n - 23 : n - 3])
    persist = sum(1 for i in (n - 3, n - 2, n - 1) if bp > 0 and qv[i] >= 1.5 * bp)
    q3 = mean(qv[n - 6 : n - 3])
    accel = (mean(qv[n - 3 :]) / q3) if q3 > 0 else float("nan")

    atr = TA.atr_series(h, l, c, 14)[-1]
    ema21 = TA.ema(c, 21)
    rsi = TA.rsi(c)
    mac = TA.macd(c)
    m3 = ((c[-1] - c[-4]) / atr) if (is_finite(atr) and atr > 0) else 0.0

    bu, be = 0, 0
    if m3 > 0.5: bu += 1
    elif m3 < -0.5: be += 1
    if c[-1] > ema21: bu += 1
    elif c[-1] < ema21: be += 1
    if rsi >= 55: bu += 1
    elif rsi <= 45: be += 1
    if mac["histogram"] > 0: bu += 1
    elif mac["histogram"] < 0: be += 1

    direction = "bull" if (bu >= 3 and be <= 1) else ("bear" if (be >= 3 and bu <= 1) else "mixed")
    cand = [r for r in recent if is_finite(r["rv"]) and r["rv"] >= 2.0]
    active = len(cand) > 0 and (rvol >= 1.5 or persist >= 2)
    status = ("EB" if direction == "bull" else ("EE" if direction == "bear" else "VS")) if active else "NO"
    score = (rvol * 15.0 + persist * 10.0 + (20.0 if direction != "mixed" else 0.0)) if is_finite(rvol) else 0.0

    return {"status": status, "score": round(score, 1), "rvol": round(rvol, 2) if is_finite(rvol) else 0.0, "accel": accel}


# ================= 2. MULTI-INDICATOR + BACKTEST =================
def evaluate_indicators(cs):
    n = len(cs)
    c = [x["close"] for x in cs]
    h = [x["high"] for x in cs]
    l = [x["low"] for x in cs]
    p = c[-1]
    atr_s = TA.atr_series(h, l, c, 14)
    atr_now = atr_s[-1]
    ctx = {"atr": atr_now}
    items = []

    def add(key, d):
        items.append({"key": key, "group": GROUPS[key], "dir": d})

    rsi = TA.rsi(c)
    add("rsi", "na" if not is_finite(rsi) else ("neutral" if (rsi > 70 or rsi < 30) else ("bull" if rsi >= 55 else ("bear" if rsi <= 45 else "neutral"))))

    m = TA.macd(c)
    if not is_finite(m["histogram"]) or not is_finite(atr_now):
        add("macd", "na")
    else:
        th = 0.02 * atr_now
        add("macd", "bull" if (m["histogram"] > th and m["line"] > m["signal"]) else ("bear" if (m["histogram"] < -th and m["line"] < m["signal"]) else "neutral"))

    e9, e21 = TA.ema(c, 9), TA.ema(c, 21)
    ctx["ema21"] = e21
    add("ema", "na" if (not is_finite(e9) or not is_finite(e21)) else ("bull" if (e9 > e21 and p > e21) else ("bear" if (e9 < e21 and p < e21) else "neutral")))

    s20, s50 = TA.sma(c, 20), TA.sma(c, 50)
    add("sma", "na" if (not is_finite(s20) or not is_finite(s50)) else ("bull" if (s20 > s50 and p > s50) else ("bear" if (s20 < s50 and p < s50) else "neutral")))

    b = TA.bb(c)
    if not is_finite(b["upper"]) or b["upper"] <= b["lower"]:
        add("bb", "na")
    else:
        pct = (p - b["lower"]) / (b["upper"] - b["lower"])
        add("bb", "neutral" if (pct > 1 or pct < 0) else ("bull" if pct >= 0.55 else ("bear" if pct <= 0.45 else "neutral")))

    sr = TA.stoch_rsi(c)
    add("stochrsi", "na" if (not is_finite(sr["k"]) or not is_finite(sr["d"])) else ("bull" if (sr["k"] > sr["d"] and sr["k"] < 80) else ("bear" if (sr["k"] < sr["d"] and sr["k"] > 20) else "neutral")))

    a = TA.adx(h, l, c)
    ctx["adx"] = a["adx"]
    add("adx", "na" if not is_finite(a["adx"]) else ("bull" if (a["adx"] >= 20 and a["plusDI"] > a["minusDI"]) else ("bear" if (a["adx"] >= 20 and a["minusDI"] > a["plusDI"]) else "neutral")))

    cci = TA.cci(h, l, c)
    add("cci", "na" if not is_finite(cci) else ("bull" if (100 < cci <= 200) else ("bear" if (-200 <= cci < -100) else "neutral")))

    obv = TA.obv_series(cs)
    if n < 26:
        add("obv", "na")
    else:
        oe = TA.ema_series(obv, 20)[-1]
        add("obv", "na" if not is_finite(oe) else ("bull" if (obv[-1] > oe and obv[-1] > obv[-6]) else ("bear" if (obv[-1] < oe and obv[-1] < obv[-6]) else "neutral")))

    atr_vals = [x for x in atr_s[-20:] if is_finite(x)]
    if not is_finite(atr_now) or len(atr_vals) < 10 or n < 5:
        add("atr", "na")
    else:
        exp = atr_now > mean(atr_vals) * 1.05
        chg = c[-1] - c[-4]
        ctx["atrExp"] = exp
        add("atr", ("bull" if chg > 0 else "bear") if (exp and abs(chg) > 0.5 * atr_now) else "neutral")

    return items, ctx


def compute_multi_signal(all_cs):
    cs = all_cs[-300:]
    if len(cs) < 60:
        return None
    items, ctx = evaluate_indicators(cs)
    valid = [x for x in items if x["dir"] != "na"]
    nv = len(valid)
    if nv < 7:
        return None

    g = sum(1 for x in valid if x["dir"] == "bull")
    r = sum(1 for x in valid if x["dir"] == "bear")
    min_votes = math.ceil(0.6 * nv)
    min_margin = math.ceil(0.3 * nv)

    status = "NEUTRAL"
    if g >= min_votes and (g - r) >= min_margin:
        status = "BUY"
    elif r >= min_votes and (r - g) >= min_margin:
        status = "SELL"
    if status == "NEUTRAL":
        return None

    s = 1 if status == "BUY" else -1
    opp = "bear" if s == 1 else "bull"
    by_key = {x["key"]: x for x in items}
    if by_key["ema"]["dir"] == opp and by_key["sma"]["dir"] == opp:
        return None
    if by_key["adx"]["dir"] == opp and is_finite(ctx.get("adx")) and ctx["adx"] >= 25:
        return None

    sc_map = {"bull": 1.0, "bear": -1.0, "neutral": 0.0}
    num, den = 0.0, 0.0
    for gr, w in GROUP_W.items():
        mm = [x for x in valid if x["group"] == gr]
        if mm:
            num += w * s * mean([sc_map[x["dir"]] for x in mm])
            den += w
    dom = clamp(num / den, -1.0, 1.0) if den else 0.0
    adx_f = clamp((ctx["adx"] - 15.0) / 25.0, 0.0, 1.0) if is_finite(ctx.get("adx")) else 0.0
    vol_f = 1.0 if ctx.get("atrExp") else 0.4
    strength = round(100.0 * clamp(0.65 * max(0.0, dom) + 0.2 * adx_f + 0.15 * vol_f, 0.0, 1.0))

    p, atr, ema21 = cs[-1]["close"], ctx["atr"], ctx.get("ema21")
    far = p - s * 0.5 * atr
    if is_finite(ema21) and ((s == 1 and far < ema21 < p) or (s == -1 and p < ema21 < far)):
        far = ema21
    if abs(p - far) < 0.1 * atr:
        far = p - s * 0.1 * atr
    low, high = min(p, far), max(p, far)
    mid = (low + high) / 2.0
    if s == 1:
        sw = min(x["low"] for x in cs[-10:]) - 0.25 * atr
        sl = max(mid - 2.5 * atr, min(sw if sw < low else mid - 1.5 * atr, mid - 1.0 * atr))
    else:
        sw = max(x["high"] for x in cs[-10:]) + 0.25 * atr
        sl = min(mid + 2.5 * atr, max(sw if sw > high else mid + 1.5 * atr, mid + 1.0 * atr))
    risk = abs(mid - sl)
    return {"status": status, "strength": strength, "entry": mid, "sl": sl, "tp1": mid + s * 2 * risk, "risk": risk}


def run_multi_backtest(cs):
    n = len(cs)
    start = 100
    if n < start + 29:
        return 0.0, 0
    trades = []
    i = start
    while i < n - 1:
        sig = compute_multi_signal(cs[: i + 1])
        if not sig or sig["risk"] <= 0:
            i += 1
            continue
        d = 1 if sig["status"] == "BUY" else -1
        entry, risk = cs[i + 1]["open"], sig["risk"]
        sl, tp1 = entry - d * risk, entry + d * 2 * risk
        last = min(i + 24, n - 1)
        out, end_k = "TIMEOUT", last
        for k in range(i + 1, last + 1):
            c = cs[k]
            if (d == 1 and c["low"] <= sl) or (d == -1 and c["high"] >= sl):
                out, end_k = "SL", k
                break
            if (d == 1 and c["high"] >= tp1) or (d == -1 and c["low"] <= tp1):
                out, end_k = "TP1", k
                break
        trades.append(out)
        i = end_k + 1
    if not trades:
        return 0.0, 0
    wr = 100.0 * sum(1 for t in trades if t == "TP1") / len(trades)
    return wr, len(trades)


# ================= 3. EMA EXPERT STRATEGY MTF =================
def fetch_klines(symbol, interval, limit=500):
    raw = api_fetch(f"/api/v3/klines?symbol={symbol}&interval={interval}&limit={limit}")
    now = int(time.time() * 1000)
    return [
        {
            "time": int(d[0]), "open": float(d[1]), "high": float(d[2]),
            "low": float(d[3]), "close": float(d[4]), "volume": float(d[5]),
            "closeTime": int(d[6]), "qv": float(d[7])
        }
        for d in raw if int(d[6]) < now
    ]


def enrich_ema_tf(cs):
    c = [x["close"] for x in cs]
    h = [x["high"] for x in cs]
    l = [x["low"] for x in cs]
    v = [x["volume"] for x in cs]
    e8 = TA.ema_series(c, 8)
    e21 = TA.ema_series(c, 21)
    e125 = TA.ema_series(c, 125)
    atr = TA.atr_series(h, l, c, 14)
    vol_avg = TA.sma_series(v, 20)
    out = []
    for i, candle in enumerate(cs):
        rv = (candle["volume"] / vol_avg[i]) if (is_finite(vol_avg[i]) and vol_avg[i] > 0) else 1.0
        out.append({**candle, "e8": e8[i], "e21": e21[i], "e125": e125[i], "atr": atr[i], "rvol": rv})
    return out


def run_ema_expert_mtf(symbol, tr_tf="1h", pu_tf="15m", en_tf="5m"):
    dt = enrich_ema_tf(fetch_klines(symbol, tr_tf, 300))
    dp = enrich_ema_tf(fetch_klines(symbol, pu_tf, 300))
    de = enrich_ema_tf(fetch_klines(symbol, en_tf, 300))

    t_idx, p_idx = 0, 0
    state = "WAITING"
    trades, active_trade, last_signal = [], None, None

    for i, centry in enumerate(de):
        prev_entry = de[i - 1] if i > 0 else centry
        while t_idx < len(dt) - 1 and dt[t_idx + 1]["time"] <= centry["time"]:
            t_idx += 1
        while p_idx < len(dp) - 1 and dp[p_idx + 1]["time"] <= centry["time"]:
            p_idx += 1

        ctrend, cpull = dt[t_idx], dp[p_idx]
        if not is_finite(ctrend["e125"]) or not is_finite(cpull["e21"]) or not is_finite(centry["atr"]):
            continue

        if active_trade:
            hit_sl = (centry["low"] <= active_trade["sl"]) if active_trade["dir"] == "BUY" else (centry["high"] >= active_trade["sl"])
            hit_tp = (centry["high"] >= active_trade["tp"]) if active_trade["dir"] == "BUY" else (centry["low"] <= active_trade["tp"])
            if hit_sl or hit_tp:
                active_trade["out"] = "TP" if hit_tp else "SL"
                trades.append(active_trade)
                active_trade = None
                state = "WAITING"
            if active_trade:
                continue

        prev_t = dt[t_idx - 1] if t_idx > 0 else ctrend
        prev2_t = dt[t_idx - 2] if t_idx > 1 else prev_t
        struct_bull = ctrend["high"] >= prev_t["high"] and ctrend["low"] >= prev2_t["low"]
        struct_bear = ctrend["low"] <= prev_t["low"] and ctrend["high"] <= prev2_t["high"]

        trend_bull = ctrend["close"] > ctrend["e125"] and ctrend["e8"] > ctrend["e21"] and ctrend["e21"] > prev_t["e21"] and struct_bull
        trend_bear = ctrend["close"] < ctrend["e125"] and ctrend["e8"] < ctrend["e21"] and ctrend["e21"] < prev_t["e21"] and struct_bear
        dyn_rr = int(clamp(round(2 + max(0.0, centry["rvol"] - 1.15) * 1.5), 2, 5))

        if state == "WAITING" or state.startswith("TREND"):
            state = "TREND_DETECTED_BULL" if trend_bull else ("TREND_DETECTED_BEAR" if trend_bear else "WAITING")
            tol = cpull["atr"] * 0.2
            if state == "TREND_DETECTED_BULL" and (cpull["low"] <= cpull["e8"] + tol or cpull["low"] <= cpull["e21"] + tol):
                state = "PULLBACK_DETECTED_BULL"
            elif state == "TREND_DETECTED_BEAR" and (cpull["high"] >= cpull["e8"] - tol or cpull["high"] >= cpull["e21"] - tol):
                state = "PULLBACK_DETECTED_BEAR"
        elif state == "PULLBACK_DETECTED_BULL":
            if not trend_bull or centry["close"] < cpull["e21"] - cpull["atr"]:
                state = "WAITING"
            elif centry["close"] > centry["open"] and centry["close"] > prev_entry["high"]:
                sl = min(centry["low"], prev_entry["low"]) - centry["atr"] * 0.5
                risk = centry["close"] - sl
                active_trade = {
                    "dir": "BUY", "entry": centry["close"], "sl": sl, "tp": centry["close"] + risk * dyn_rr,
                    "rrRatio": dyn_rr, "rvol": centry["rvol"], "time": centry["time"], "idx": i,
                    "trEma": ctrend["e125"], "puEma8": cpull["e8"], "puEma21": cpull["e21"]
                }
                last_signal = active_trade.copy()
                state = "WAITING"
        elif state == "PULLBACK_DETECTED_BEAR":
            if not trend_bear or centry["close"] > cpull["e21"] + cpull["atr"]:
                state = "WAITING"
            elif centry["close"] < centry["open"] and centry["close"] < prev_entry["low"]:
                sl = max(centry["high"], prev_entry["high"]) + centry["atr"] * 0.5
                risk = sl - centry["close"]
                active_trade = {
                    "dir": "SELL", "entry": centry["close"], "sl": sl, "tp": centry["close"] - risk * dyn_rr,
                    "rrRatio": dyn_rr, "rvol": centry["rvol"], "time": centry["time"], "idx": i,
                    "trEma": ctrend["e125"], "puEma8": cpull["e8"], "puEma21": cpull["e21"]
                }
                last_signal = active_trade.copy()
                state = "WAITING"

    wr = (sum(1 for t in trades if t["out"] == "TP") / len(trades) * 100.0) if trades else 0.0
    if last_signal and (len(de) - last_signal["idx"] <= 5):
        rvol_bonus = clamp((last_signal["rvol"] - 1.0) * 12.0, 0.0, 15.0)
        prob = int(round(clamp(wr * 0.85 + rvol_bonus + 10.0, 0.0, 99.0)))
        return {
            "symbol": symbol,
            "timestamp": int(time.time() * 1000),
            "updatedAt": int(time.time() * 1000),
            "strategy": "EMA_EXPERT_MTF",
            "trendTf": tr_tf, "pullbackTf": pu_tf, "entryTf": en_tf,
            "trendEma125": last_signal["trEma"],
            "pullbackEma8": last_signal["puEma8"],
            "pullbackEma21": last_signal["puEma21"],
            "signal": last_signal["dir"],
            "entryPrice": last_signal["entry"],
            "stopLoss": last_signal["sl"],
            "takeProfit": last_signal["tp"],
            "riskReward": f"1:{last_signal['rrRatio']}",
            "rvol": round(last_signal["rvol"], 2),
            "winrate": round(wr, 1),
            "probability": prob,
            "minExecProb": MIN_EXEC_PROB,
            "eligibleFor50x": prob >= MIN_EXEC_PROB,
            "status": f"{last_signal['dir']}_CONFIRMED"
        }
    return None


# ================= SINKRONISASI FIREBASE & SIKLUS UTAMA =================
def get_bot_control():
    try:
        r = SESSION.get(CTRL_URL, timeout=6)
        if r.status_code == 200 and isinstance(r.json(), dict):
            d = r.json()
            return bool(d.get("autoTrade", True)), int(d.get("minProb", MIN_EXEC_PROB))
    except Exception:
        pass
    return True, MIN_EXEC_PROB


def push_signal_firebase(payload):
    sym = payload["symbol"]
    try:
        SESSION.put(f"{SIGNALS_URL}/{sym}.json", json=payload, timeout=8)
    except Exception as e:
        print(f"[Firebase Err] {sym}: {e}")


def get_top_liquid_symbols(limit=TOP_LIQUID_LIMIT):
    ex = api_fetch("/api/v3/exchangeInfo")
    ticks = api_fetch("/api/v3/ticker/24hr")
    valid = {
        s["symbol"] for s in ex["symbols"]
        if s["status"] == "TRADING" and s["isSpotTradingAllowed"] and s["quoteAsset"] == "USDT" and s["baseAsset"] != "USDT"
    }
    bad_suffix = ("UPUSDT", "DOWNUSDT", "BULLUSDT", "BEARUSDT", "2LUSDT", "3LUSDT", "5LUSDT", "2SUSDT", "3SUSDT", "5SUSDT")
    stables = {"USDCUSDT", "FDUSDUSDT", "TUSDUSDT", "USDPUSDT", "DAIUSDT", "BUSDUSDT", "USDEUSDT", "USTUSDT"}
    filtered = [
        t for t in ticks
        if t["symbol"] in valid and not t["symbol"].endswith(bad_suffix) and t["symbol"] not in stables and float(t["lastPrice"]) > 0
    ]
    filtered.sort(key=lambda x: float(x["quoteVolume"]), reverse=True)
    return [(t["symbol"], float(t["lastPrice"]), float(t["quoteVolume"])) for t in filtered[:limit]]


def scan_coin(item, min_prob):
    sym, price, q24 = item
    try:
        cs_5m = fetch_klines(sym, "5m", 250)
        radar = analyze_radar(cs_5m, price, q24)
        multi = compute_multi_signal(cs_5m)
        multi_wr, multi_n = run_multi_backtest(cs_5m) if multi else (0.0, 0)
        ema_sig = run_ema_expert_mtf(sym, "1h", "15m", "5m")

        # Prioritaskan EMA Expert MTF jika memenuhi ambang probabilitas >= 75%
        if ema_sig and ema_sig["probability"] >= min_prob:
            push_signal_firebase(ema_sig)
            return f"⚡ [EMA MTF >= {min_prob}%] {sym} {ema_sig['signal']} | Prob: {ema_sig['probability']}% | R:R {ema_sig['riskReward']}"

        # Cadangan: Sinyal Multi-Indikator tervalidasi backtest >= 75%
        if multi and multi_n >= 20 and multi_wr >= min_prob and multi["strength"] >= min_prob:
            payload = {
                "symbol": sym,
                "timestamp": int(time.time() * 1000),
                "updatedAt": int(time.time() * 1000),
                "strategy": "MULTI_INDICATOR_5M",
                "signal": multi["status"],
                "entryPrice": multi["entry"],
                "stopLoss": multi["sl"],
                "takeProfit": multi["tp1"],
                "riskReward": "1:2",
                "winrate": round(multi_wr, 1),
                "probability": int(round(max(multi_wr, multi["strength"]))),
                "minExecProb": min_prob,
                "eligibleFor50x": True,
                "status": f"{multi['status']}_CONFIRMED"
            }
            push_signal_firebase(payload)
            return f"🎯 [MULTI-IND >= {min_prob}%] {sym} {multi['status']} | WR: {multi_wr:.1f}% | Skor: {multi['strength']}"

        if radar and radar["status"] in ("EB", "EE"):
            return f"👀 [RADAR {radar['status']}] {sym} | RVOL: {radar['rvol']}x | Skor: {radar['score']}"
    except Exception:
        pass
    return None


def main():
    print("=== PYTHON QUANTITATIVE ANALYZER & MTF ENGINE AKTIF ===")
    while True:
        now_str = datetime.now().strftime("%H:%M:%S")
        auto_on, min_prob = get_bot_control()
        if not auto_on:
            print(f"[{now_str}] ⏸ Master Bot STANDBY (OFF) dari Firebase. Menunggu...")
            time.sleep(10)
            continue

        try:
            coins = get_top_liquid_symbols(TOP_LIQUID_LIMIT)
            print(f"[{now_str}] 🔍 Memindai {len(coins)} koin likuid (Ambang Eksekusi >= {min_prob}%)...")
            with ThreadPoolExecutor(max_workers=5) as pool:
                futures = [pool.submit(scan_coin, c, min_prob) for c in coins]
                for fut in as_completed(futures):
                    res = fut.result()
                    if res:
                        print("  ->", res)
        except Exception as e:
            print(f"[{now_str}] ⚠️ Siklus error: {e}")

        time.sleep(SCAN_INTERVAL_SEC)


if __name__ == "__main__":
    main()
