"""서울 전체 전월세 데이터를 서울 열린데이터광장 API로 내려받아
자치구 × 건물 유형별 '전세환산 보증금' 중위값을 집계하고 public/top10.json 으로 저장합니다.

전세환산 보증금 = 보증금 + 월세 × 12 / 전환율(5%)

사용법 (seoul_rent_api 폴더에서):
    python3 scripts/build_top10.py
API 키는 환경변수 SEOUL_API_KEY → .dev.vars → ../.env 순서로 찾습니다. 키는 출력하지 않습니다.
"""
import json
import os
import re
import statistics
import sys
import time
import urllib.request
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SERVICE = "tbLnOpendataRentV"
PAGE = 1000
RATE = 0.05                        # 전월세 전환율 5%
MIN_N = 30                         # 순위에 넣을 최소 거래 건수
TYPES = ["아파트", "연립다세대", "오피스텔", "단독다가구", "공공임대"]

# functions/api/rent.js 와 동일한 공공임대 판별 규칙
PUBLIC_ANY = re.compile(r"행복주택|행복아파트|임대|장기전세|휴먼시아|도시개발공사|청년주택|공공주택")
PUBLIC_APT = re.compile(r"LH|엘에이치|SH|에스에이치")


def usage(r):
    name = r.get("BLDG_NM") or ""
    if PUBLIC_ANY.search(name) or (r.get("BLDG_USG") == "아파트" and PUBLIC_APT.search(name)):
        return "공공임대"
    return r.get("BLDG_USG")


def load_key():
    if os.environ.get("SEOUL_API_KEY"):
        return os.environ["SEOUL_API_KEY"].strip()
    for path, pat in [(ROOT / ".dev.vars", r"^SEOUL_API_KEY=(.+)$"), (ROOT.parent / ".env", r"^\s*SEOUL_API_KEY\s*=\s*[\"']?([^\"'\s]+)")]:
        if path.exists():
            for line in path.read_text().splitlines():
                m = re.match(pat, line)
                if m:
                    return m.group(1).strip()
    sys.exit("SEOUL_API_KEY를 찾을 수 없습니다.")


def fetch(key, year, start, end, tries=4):
    url = f"http://openapi.seoul.go.kr:8088/{key}/json/{SERVICE}/{start}/{end}/{year}"
    for i in range(tries):
        try:
            with urllib.request.urlopen(url, timeout=60) as res:
                data = json.load(res)
            body = data.get(SERVICE)
            if body is None:
                code = data.get("RESULT", {}).get("CODE")
                if code == "INFO-200":
                    return 0, []
                raise RuntimeError(f"API 오류 {code}")
            return body["list_total_count"], body.get("row", [])
        except Exception as e:  # 키가 포함된 URL은 출력하지 않음
            if i == tries - 1:
                raise RuntimeError(f"{year} {start}-{end} 실패: {type(e).__name__}") from None
            time.sleep(2 * (i + 1))


def main():
    key = load_key()
    years = [datetime.now().year - 1, datetime.now().year]
    rows = []
    for y in years:
        total, first = fetch(key, y, 1, PAGE)
        rows += first
        starts = list(range(PAGE + 1, total + 1, PAGE))
        print(f"{y}년 접수분 {total:,}건 · {len(starts) + 1}회 호출", flush=True)
        done = 0
        with ThreadPoolExecutor(max_workers=8) as ex:
            for _, part in ex.map(lambda s: fetch(key, y, s, s + PAGE - 1), starts):
                rows += part
                done += 1
                if done % 100 == 0:
                    print(f"  {done}/{len(starts)}", flush=True)

    # 최근 12개월(계약일 기준, 마지막 달은 집계 중이라 제외)
    months = sorted({r["CTRT_DAY"][:6] for r in rows if len(r.get("CTRT_DAY") or "") == 8})
    end = months[-2]
    ey, em = int(end[:4]), int(end[4:])
    start_idx = ey * 12 + em - 1 - 11
    start = f"{start_idx // 12}{start_idx % 12 + 1:02d}"

    groups = defaultdict(lambda: {"v": [], "m2": []})
    for r in rows:
        d = (r.get("CTRT_DAY") or "")[:6]
        if not (start <= d <= end):
            continue
        try:
            dep = float(r["GRFE"] or 0)
            rent = float(r["RTFE"] or 0)
            area = float(r["RENT_AREA"] or 0)
        except ValueError:
            continue
        conv = dep + rent * 12 / RATE
        g = groups[(r["CGG_NM"], usage(r))]
        g["v"].append(conv)
        if area > 0:
            g["m2"].append(conv / area)

    result = {}
    for t in TYPES:
        items = []
        for (gu, typ), g in groups.items():
            if typ != t or len(g["v"]) < MIN_N:
                continue
            items.append({
                "gu": gu,
                "n": len(g["v"]),
                "median": round(statistics.median(g["v"])),
                "perm2": round(statistics.median(g["m2"]), 1) if g["m2"] else None,
            })
        result[t] = items  # 정렬은 화면에서 (총액/㎡당 전환)

    out = {
        "generated": datetime.now(timezone.utc).strftime("%Y-%m-%d"),
        "period": [f"{start[:4]}-{start[4:]}", f"{end[:4]}-{end[4:]}"],
        "rate": RATE,
        "min_n": MIN_N,
        "rows": sum(len(g["v"]) for g in groups.values()),
        "types": result,
    }
    path = ROOT / "public" / "top10.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")))
    print(f"저장: {path} · 기간 {out['period'][0]}~{out['period'][1]} · {out['rows']:,}건")


if __name__ == "__main__":
    main()
