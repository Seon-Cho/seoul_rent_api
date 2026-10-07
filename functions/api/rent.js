// Cloudflare Pages Function: GET /api/rent?gu=&dong=&year=
// 서울 열린데이터광장 「서울시 부동산 전월세가 정보(tbLnOpendataRentV)」 프록시
// - API 키는 Cloudflare Secret(env.SEOUL_API_KEY)에만 존재하며 브라우저로 절대 전달되지 않습니다.
// - 입력값은 화이트리스트(숫자 5자리 코드, 2022~2026년)로 검증합니다.
// - 응답은 Cloudflare 엣지 캐시에 저장하여 원본 API 호출을 줄입니다.

const SERVICE = "tbLnOpendataRentV";
const PAGE = 1000;               // 서울 API 1회 최대 조회 건수
const MAX_PAGES = 45;            // 서브요청 한도(무료 50) 이내
const YEARS = [2022, 2023, 2024, 2025, 2026];
const CACHE_TTL = 60 * 60 * 6;   // 6시간

const SECURITY_HEADERS = {
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "strict-origin-when-cross-origin",
  "X-Frame-Options": "DENY",
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...SECURITY_HEADERS,
      ...extra,
    },
  });
}

// 행복주택·국민임대·장기전세·LH/SH 단지 등 공공임대 주택은 별도 용도 '공공임대'로 분류합니다.
// 데이터에 공공임대 여부 컬럼이 없으므로 건물명으로 판별합니다.
const PUBLIC_ANY = /행복주택|행복아파트|임대|장기전세|휴먼시아|도시개발공사|청년주택|공공주택/;
const PUBLIC_APT = /LH|엘에이치|SH|에스에이치/; // 아파트에만 적용 (빌딩·빌라 이름 오탐 방지)
function usage(r) {
  const name = r.BLDG_NM || "";
  if (PUBLIC_ANY.test(name) || (r.BLDG_USG === "아파트" && PUBLIC_APT.test(name))) return "공공임대";
  return r.BLDG_USG;
}

// 필요한 필드만 배열로 압축해 전송량을 줄입니다.
const FIELDS = ["CTRT_DAY", "RENT_SE", "RENT_AREA", "GRFE", "RTFE", "BLDG_NM", "BLDG_USG", "FLR", "ARCH_YR", "NEW_UPDT_YN", "RCPT_YR"];
const num = (v) => (v === "" || v == null ? null : Number(v));
function compact(r) {
  return [r.CTRT_DAY, r.RENT_SE, num(r.RENT_AREA), num(r.GRFE), num(r.RTFE), r.BLDG_NM || "", usage(r), num(r.FLR), r.ARCH_YR || "", r.NEW_UPDT_YN || "", r.RCPT_YR];
}

async function fetchPage(key, year, gu, dong, start, end) {
  const url = `http://openapi.seoul.go.kr:8088/${encodeURIComponent(key)}/json/${SERVICE}/${start}/${end}/${year}/${gu}/%20/${dong}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`upstream HTTP ${res.status}`);
  const data = await res.json();
  const body = data[SERVICE];
  if (!body) {
    const code = data?.RESULT?.CODE;
    if (code === "INFO-200") return { total: 0, rows: [] }; // 데이터 없음
    throw new Error(`upstream ${code || "unknown"}`);       // 키는 메시지에 포함하지 않음
  }
  return { total: body.list_total_count, rows: body.row || [] };
}

async function getYear(key, year, gu, dong) {
  const first = await fetchPage(key, year, gu, dong, 1, PAGE);
  const rows = first.rows.slice();
  const pages = Math.min(Math.ceil(first.total / PAGE), MAX_PAGES);
  const rest = [];
  for (let p = 1; p < pages; p++) {
    rest.push(fetchPage(key, year, gu, dong, p * PAGE + 1, (p + 1) * PAGE));
  }
  for (const r of await Promise.all(rest)) rows.push(...r.rows);
  return { year, total: first.total, truncated: first.total > pages * PAGE, fields: FIELDS, rows: rows.map(compact) };
}

export async function onRequestGet({ request, env, waitUntil }) {
  // 다른 사이트에서 이 프록시를 무단 호출하지 못하도록 동일 출처 요청만 허용
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return json({ error: "Forbidden" }, 403);

  const url = new URL(request.url);
  const gu = url.searchParams.get("gu") || "";
  const dong = url.searchParams.get("dong") || "";
  const year = Number(url.searchParams.get("year"));

  if (!/^\d{5}$/.test(gu) || !/^\d{5}$/.test(dong) || !YEARS.includes(year)) {
    return json({ error: "잘못된 요청 파라미터입니다." }, 400);
  }
  if (!env.SEOUL_API_KEY) return json({ error: "서버에 API 키가 설정되지 않았습니다." }, 500);

  // 엣지 캐시 (키가 없는 정규화된 URL을 캐시 키로 사용)
  const cacheKey = new Request(`${url.origin}/api/rent?gu=${gu}&dong=${dong}&year=${year}&v=2`);
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  try {
    const result = await getYear(env.SEOUL_API_KEY, year, gu, dong);
    const res = json(result, 200, { "Cache-Control": `public, max-age=${CACHE_TTL}` });
    waitUntil(cache.put(cacheKey, res.clone()));
    return res;
  } catch (e) {
    console.error("rent fetch failed", e.message);
    return json({ error: "서울시 API 조회에 실패했습니다. 잠시 후 다시 시도해 주세요." }, 502);
  }
}

export function onRequest() {
  return json({ error: "Method Not Allowed" }, 405, { Allow: "GET" });
}
