// Fake seller catalogs. Station codes follow the style of the official TRV11 2.0.1 examples
// (e.g. RAJIV_CHOWK, KASHMERE_GATE). Lines are trimmed; fares are illustrative slabs.

export interface Line {
  routeId: string;
  name: string;
  stations: string[]; // codes, in order
}

export interface SellerData {
  key: string; // URL path segment, e.g. "dmrc"
  providerId: string;
  name: string;
  lines: Line[];
  fareSlabs: number[]; // index = number of hops (capped)
  roundTripFactor: number; // RJT price = round(SJT * factor)
}

export const SELLERS: Record<string, SellerData> = {
  dmrc: {
    key: "dmrc",
    providerId: "P1",
    name: "Delhi Metro Rail Corporation (MOCK)",
    lines: [
      {
        routeId: "242",
        name: "Yellow Line",
        stations: [
          "SAMAYPUR_BADLI", "JAHANGIRPURI", "AZADPUR", "VISHWA_VIDYALAYA", "KASHMERE_GATE", "CHANDNI_CHOWK",
          "NEW_DELHI", "RAJIV_CHOWK", "CENTRAL_SECRETARIAT", "DILLI_HAAT_INA", "AIIMS", "HAUZ_KHAS", "SAKET",
          "QUTAB_MINAR", "SIKANDERPUR", "MG_ROAD", "HUDA_CITY_CENTRE",
        ],
      },
      {
        routeId: "243",
        name: "Blue Line",
        stations: [
          "DWARKA_SECTOR_21", "DWARKA", "JANAKPURI_WEST", "RAJOURI_GARDEN", "KAROL_BAGH", "RAJIV_CHOWK",
          "MANDI_HOUSE", "YAMUNA_BANK", "MAYUR_VIHAR_1", "NOIDA_SECTOR_18", "NOIDA_CITY_CENTRE",
        ],
      },
    ],
    fareSlabs: [11, 11, 21, 21, 32, 32, 43, 43, 54, 54, 64],
    roundTripFactor: 1.85,
  },
  nmrc: {
    key: "nmrc",
    providerId: "P1",
    name: "Noida Metro Rail Corporation (MOCK)",
    lines: [
      {
        routeId: "AQ1",
        name: "Aqua Line",
        stations: [
          "NOIDA_SECTOR_51", "NOIDA_SECTOR_50", "NOIDA_SECTOR_76", "NOIDA_SECTOR_101", "NOIDA_SECTOR_81",
          "NSEZ", "NOIDA_SECTOR_83", "NOIDA_SECTOR_137", "NOIDA_SECTOR_142", "PARI_CHOWK", "DEPOT_STATION",
        ],
      },
    ],
    fareSlabs: [10, 10, 15, 15, 20, 20, 25, 30, 35, 40, 50],
    roundTripFactor: 2,
  },
};

const ACRONYMS = new Set(["MG", "AIIMS", "HUDA", "INA", "NSEZ"]);

export function stationName(code: string): string {
  return code
    .split("_")
    .map((w) => (/^\d+$/.test(w) || ACRONYMS.has(w) ? w : w[0] + w.slice(1).toLowerCase()))
    .join(" ")
    .replace("Dilli Haat INA", "Dilli Haat - INA");
}

export function allStations(s: SellerData): Set<string> {
  return new Set(s.lines.flatMap((l) => l.stations));
}

/** Shortest path (by stops) across lines; interchanges happen where lines share a station code. */
export function findPath(s: SellerData, from: string, to: string): string[] | null {
  const adj = new Map<string, Set<string>>();
  for (const l of s.lines) {
    l.stations.forEach((st, i) => {
      if (!adj.has(st)) adj.set(st, new Set());
      if (i > 0) adj.get(st)!.add(l.stations[i - 1]);
      if (i < l.stations.length - 1) adj.get(st)!.add(l.stations[i + 1]);
    });
  }
  if (!adj.has(from) || !adj.has(to)) return null;
  const prev = new Map<string, string | null>([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift()!;
    if (cur === to) break;
    for (const n of adj.get(cur)!) {
      if (!prev.has(n)) {
        prev.set(n, cur);
        queue.push(n);
      }
    }
  }
  if (!prev.has(to)) return null;
  const path: string[] = [];
  for (let c: string | null = to; c; c = prev.get(c) ?? null) path.unshift(c);
  return path;
}

export function sjtFare(s: SellerData, hops: number): number {
  return s.fareSlabs[Math.min(hops, s.fareSlabs.length - 1)];
}

/** Which stations on the path are interchanges (served by more than one line). */
export function isInterchange(s: SellerData, code: string): boolean {
  return s.lines.filter((l) => l.stations.includes(code)).length > 1;
}
