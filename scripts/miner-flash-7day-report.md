Loaded pre-flash snapshots: 10080, live snapshots: 10080

# Miner Flash 7-Day Report

**Flash event:** Main flashed from stock to Braiins on 2026-05-02 ~01:00 UTC.
**Pre-flash window:** 7.00 days ending 2026-05-02T01:00:00.000Z (Main on STOCK, 7028 samples)
**Post-flash window:** 7.00 days from flash (Main on BRAIINS, 9341 samples)

## 4-column comparison

| Metric | Main pre-flash (STOCK) | Main post-flash (BRAIINS) | Main2 same week (BRAIINS, control) | Main Δ pre→post |
|---|---|---|---|---|
| Avg hashrate | 121.65 TH/s | 115.88 TH/s | 118.94 TH/s | -5.77 TH/s (-4.7%) ✗ |
| Avg power | 3355 W | 3061 W | 3235 W | -294 W (-8.8%) ✓ |
| Avg efficiency | 27.59 J/TH | 26.44 J/TH | 27.32 J/TH | -1.16 J/TH (-4.2%) ✓ |
| Avg max chip temp | 75.39°C | 69.63°C | 68.21°C | -5.76°C (-7.6%) ✓ |
| Reject rate | 0.096% | 0.043% | 0.253% | — |
| Uptime % | 100.00% | 99.45% | 100.00% | — |

## Predicted-gain check (Apr 29 baseline forecast)
- Predicted ~6°C cooler post-flash: actual delta = 5.76°C → ✓ MET
- Predicted ~5% efficiency improvement: actual = -4.2% → ◐ partial

## Heatsink concern check
- Main historical max chip temp on stock: ~86°C (vs Main2's ~80°C, +6°C gap)
- Main avg max chip on Braiins (post-flash): 69.63°C
- Main2 avg max chip on Braiins (same week): 68.21°C
- Main vs Main2 same-firmware gap: +1.42°C
- Verdict: ✓ Closed — same firmware = same temps. The pre-flash gap was a stock-firmware tuning artifact, not a hardware/airflow problem.

## Was the flash worth it?

**WORTH IT.** efficiency improved by 1.16 J/TH (4.2%), power draw fell by 294 W (8.8%), hashrate dropped by 5.77 TH/s, max chip temp dropped 5.8°C.

At a typical UK electricity rate of £0.27/kWh, that's 7.06 kWh/day saved → £1.91/day → £696/year on Main alone.
