# seoul_rent_api — 서울 전월세 가격 분석

서울 열린데이터광장 **「서울시 부동산 전월세가 정보」(tbLnOpendataRentV)** API에서 데이터를 실시간으로 불러와,
자치구·법정동별 **2022–2026년** 전세·월세 가격 변화를 분석하는 웹앱입니다. Cloudflare Workers로 배포합니다.

- 배포 주소: https://seoul-rent-api.hisun730.workers.dev
- 디자인: 밝은 배경 + 오렌지 포인트 컬러, 단순한 단일 페이지

## 기능

1. 자치구 → 법정동을 선택하면 해당 동의 **2022·2023·2024·2025·2026년 데이터를 모두** API로 요청합니다 (연도별 병렬 호출, 1,000건 단위 페이지 자동 처리).
2. 핵심 지표: 총 거래 건수, 전세 보증금 중위값, ㎡당 전세 보증금, 월세 중위값 (최근 12개월 vs 직전 12개월).
3. 차트: 월별 전세 보증금 중위값(보증금/㎡당 전환), 월별 전세·월세 거래 건수, 월별 월세 중위값.
4. 연도별 요약표, 최근 거래 내역(건물명 검색), 건물 용도 필터(아파트/연립다세대/오피스텔/단독다가구), CSV 다운로드.
5. `?gu=11680&dong=10300` 형태의 링크로 특정 동을 바로 열 수 있습니다.

## 구조

```
seoul_rent_api/
├── src/index.js          # Cloudflare Worker: /api/rent 프록시 (API 키 보관)
├── public/               # 정적 프론트엔드
│   ├── index.html
│   ├── style.css
│   ├── app.js            # 데이터 로드·분석·차트(Chart.js)
│   ├── districts.json    # 자치구 25개 / 법정동 403개 코드 목록
│   └── _headers          # CSP 등 보안 헤더
├── wrangler.toml
└── package.json
```

```
브라우저 ──/api/rent?gu=&dong=&year=──▶ Cloudflare Worker ──(SEOUL_API_KEY)──▶ openapi.seoul.go.kr
```

## API 키 보안

- API 키는 **저장소에 포함되지 않습니다.** `.env`, `.dev.vars`는 `.gitignore`로 제외됩니다.
- 배포 환경에서는 **Cloudflare Secret**(`SEOUL_API_KEY`)으로만 저장되며, Worker 내부에서만 사용됩니다. 브라우저는 키를 볼 수 없습니다.
- Worker는 입력값을 화이트리스트로 검증합니다(5자리 숫자 코드, 2022–2026년). 따라서 임의의 서울시 API 호출에 악용될 수 없습니다.
- 다른 사이트에서 오는 요청(`Sec-Fetch-Site: cross-site`)은 차단합니다. GET 요청만 허용합니다.
- 오류 메시지에 업스트림 URL(키 포함)을 노출하지 않습니다.
- 결과는 엣지 캐시에 6시간 저장해 API 호출량을 줄입니다.
- CSP, X-Frame-Options 등 보안 헤더를 적용합니다.

## 실행 / 배포

```bash
npm install
# 로컬: .dev.vars 파일에 키 저장 (커밋 금지)
echo "SEOUL_API_KEY=발급받은키" > .dev.vars
npm run dev

# 배포
npx wrangler login
npx wrangler secret put SEOUL_API_KEY   # 프롬프트에 키 입력
npm run deploy
```

## 데이터 유의사항

- 서울시 API는 현재 **접수연도(RCPT_YR) 2024–2026년**만 제공합니다. 2022·2023년을 요청하면 “해당하는 데이터가 없습니다”가 반환됩니다. 앱은 다섯 해를 모두 요청하고, 실제로 받은 데이터를 분석합니다. 계약일 기준으로는 2023년 하반기 계약 일부(2024년 신고분)부터 포함되며, 이 해는 표에서 `부분`으로 표시됩니다.
- 이 데이터셋은 행정동이 아니라 **법정동** 단위로 제공되므로 법정동으로 선택합니다.
- 가격은 중위값입니다. 월 거래가 3건 미만인 달은 그래프에서 생략합니다. 금액 단위는 만원입니다.
