// Cloudflare Pages Function: GET /api/tile/{z}/{y}/{x}
// 브이월드 배경지도(white) 타일 프록시 — 브이월드 API 키(env.VWORLD_API_KEY)를 브라우저에 노출하지 않습니다.
// 서울 주변 타일만 허용하고, 엣지·브라우저에 30일간 캐시합니다.

const BBOX = { west: 126.7, east: 127.3, south: 37.38, north: 37.75 }; // 서울 + 여유
const MIN_Z = 9, MAX_Z = 18;
const TTL = 60 * 60 * 24 * 30;

const lon2x = (lon, z) => Math.floor(((lon + 180) / 360) * 2 ** z);
const lat2y = (lat, z) => {
  const r = (lat * Math.PI) / 180;
  return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * 2 ** z);
};

function inSeoul(z, x, y) {
  const pad = 1;
  return x >= lon2x(BBOX.west, z) - pad && x <= lon2x(BBOX.east, z) + pad &&
         y >= lat2y(BBOX.north, z) - pad && y <= lat2y(BBOX.south, z) + pad;
}

export async function onRequestGet({ request, params, env, waitUntil }) {
  const site = request.headers.get("Sec-Fetch-Site");
  if (site && site !== "same-origin" && site !== "none") return new Response("Forbidden", { status: 403 });

  const z = Number(params.z), y = Number(params.y), x = Number(String(params.x).replace(/\.png$/, ""));
  if (![z, y, x].every(Number.isInteger) || z < MIN_Z || z > MAX_Z || !inSeoul(z, x, y)) {
    return new Response("Not Found", { status: 404 });
  }
  if (!env.VWORLD_API_KEY) return new Response("Tile key missing", { status: 500 });

  const cacheKey = new Request(new URL(`/api/tile/${z}/${y}/${x}`, request.url).toString());
  const cache = caches.default;
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const upstream = await fetch(`https://api.vworld.kr/req/wmts/1.0.0/${env.VWORLD_API_KEY}/white/${z}/${y}/${x}.png`);
  const type = upstream.headers.get("Content-Type") || "";
  if (!upstream.ok || !type.startsWith("image/")) return new Response("Tile unavailable", { status: 502 });

  const res = new Response(upstream.body, {
    headers: {
      "Content-Type": type,
      "Cache-Control": `public, max-age=${TTL}, immutable`,
      "X-Content-Type-Options": "nosniff",
    },
  });
  waitUntil(cache.put(cacheKey, res.clone()));
  return res;
}
