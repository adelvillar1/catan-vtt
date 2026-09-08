/**
 * Board geometry for the base-game island — FULLY DERIVED, no lookup tables.
 *
 * Layout: 19 land hexes in rows r=0..4 with lengths 3-4-5-4-3 (a radius-2
 * hex board). Axial coordinates (q, r), pointy-top orientation.
 *
 * The 19 slots (canonical order: r ascending, then q ascending):
 *   r0: (0,0)  (1,0)  (2,0)
 *   r1: (-1,1) (0,1)  (1,1)  (2,1)
 *   r2: (-2,2) (-1,2) (0,2)  (1,2)  (2,2)   <- center is (0,2)
 *   r3: (-2,3) (-1,3) (0,3)  (1,3)
 *   r4: (-2,4) (-1,4) (0,4)
 *
 * Geometry formulas (verified against parent-computed numbers — 54 vertices,
 * 72 edges, 42 interior / 30 coastal edges, 30 coastal vertices):
 *   hex center:      x = sqrt(3) * (q + r/2),  y = 1.5 * r
 *   hex vertex k:    center + VERTEX_OFFSETS[k] (exact-form 60k-30° points)
 *   vertex key:      coords quantized with Math.round(v*1e6)/1e6, `v:${x},${y}`
 *   edge id:         `e:` + its two vertex keys sorted lexicographically, `|`-joined
 *   hex id:          `${q},${r}`
 *
 * All returned objects are plain JSON-serializable — no Map/Set anywhere.
 */

export interface HexRef {
  id: string;
  q: number;
  r: number;
  /** Neighboring hex ids (share an edge), sorted ascending. 3-6 entries. */
  neighbors: string[];
  /** 6 vertex ids, sorted ascending. */
  vertices: string[];
  /** 6 edge ids, sorted ascending. */
  edges: string[];
}

export interface EdgeRef {
  id: string;
  /** Endpoint vertex id (lexicographically smaller). */
  a: string;
  /** Endpoint vertex id (lexicographically larger). */
  b: string;
  /** Hex ids touching this edge, sorted. 1 = coastal, 2 = interior. */
  hexes: string[];
  /** True when the edge borders only one land hex (island boundary). */
  coastal: boolean;
}

export interface VertexRef {
  id: string;
  /** Hex ids touching this vertex, sorted. 1-3 entries. */
  hexes: string[];
  /** Edge ids incident to this vertex, sorted. 2-3 entries. */
  edges: string[];
  /**
   * Ids of the vertices sharing an EDGE with this one (the distance-rule
   * neighbors), sorted. 2-3 entries — precomputed so rule checks are O(deg)
   * with no edge scan. Wave 2 (applyAction) depends on this index.
   */
  adjacent: string[];
}

export interface IslandTopology {
  /** 19 hexes in canonical slot order (r asc, then q asc). */
  hexes: HexRef[];
  /** 72 edges, sorted by id. */
  edges: EdgeRef[];
  /** 54 vertices, sorted by id. */
  vertices: VertexRef[];
  /** vertex id -> [x, y] (quantized coordinates). */
  vertexCoords: Record<string, [number, number]>;
  /** Vertex ids on the island boundary (touching fewer than 3 hexes). Sorted. */
  coastalVertices: string[];
  /** Edges touching exactly 2 hexes (42). */
  interiorEdgeCount: number;
  /** Edges touching exactly 1 hex (30). */
  coastalEdgeCount: number;
}

/** Axial neighbor directions, pointy-top. */
const DIRS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
  [1, -1],
  [-1, 1],
];

const SQRT3 = Math.sqrt(3);

/**
 * The six unit-circle offsets for angle (60k - 30) degrees, in exact form.
 * Using sqrt-derived constants instead of trig calls keeps the vertices
 * bit-identical across platforms — IEEE-754 guarantees correctly rounded
 * sqrt/multiply/divide, but NOT cos/sin (quality-of-implementation).
 * Sequence matches 60k-30° exactly:
 *   k=0:  30° (√3/2,  1/2)   k=1:  90° ( 0,    1)
 *   k=2: 150° (-√3/2, 1/2)   k=3: 210° (-√3/2, -1/2)
 *   k=4: 270° ( 0,   -1)     k=5: 330° (√3/2, -1/2)
 */
const VERTEX_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [SQRT3 / 2, 1 / 2],
  [0, 1],
  [-SQRT3 / 2, 1 / 2],
  [-SQRT3 / 2, -1 / 2],
  [0, -1],
  [SQRT3 / 2, -1 / 2],
];

/** The 19 land slots in canonical order (r asc, then q asc). */
const SLOTS: ReadonlyArray<readonly [number, number]> = (() => {
  const rows: Array<[number, number, number]> = [
    // [r, qMin, qMax]
    [0, 0, 2],
    [1, -1, 2],
    [2, -2, 2],
    [3, -2, 1],
    [4, -2, 0],
  ];
  const out: Array<readonly [number, number]> = [];
  for (const [r, qMin, qMax] of rows) {
    for (let q = qMin; q <= qMax; q++) out.push([q, r] as const);
  }
  return out;
})();

function hexId(q: number, r: number): string {
  return `${q},${r}`;
}

/** Quantize to 1e-6 so floating-point noise can't split shared vertices. */
function quantize(v: number): number {
  const q = Math.round(v * 1e6) / 1e6;
  return Object.is(q, -0) ? 0 : q;
}

function vertexKey(x: number, y: number): string {
  return `v:${quantize(x)},${quantize(y)}`;
}

function hexCenter(q: number, r: number): [number, number] {
  return [SQRT3 * (q + r / 2), 1.5 * r];
}

/**
 * Build the full island topology. Pure and deterministic — two calls
 * deep-equal. O(1) in practice (fixed 19-hex board).
 */
export function buildIsland(): IslandTopology {
  const slotSet = new Set<string>(SLOTS.map(([q, r]) => hexId(q, r)));

  // Accumulators keyed by id.
  const vertexHexes = new Map<string, Set<string>>(); // vertex -> hexes
  const vertexCoordsMap = new Map<string, [number, number]>();
  const edgeHexes = new Map<string, Set<string>>(); // edge -> hexes
  const edgeEndpoints = new Map<string, [string, string]>();

  const hexes: HexRef[] = [];

  for (const [q, r] of SLOTS) {
    const id = hexId(q, r);
    const [cx, cy] = hexCenter(q, r);

    // 6 vertices in winding order; edges connect vertex k to k+1 (mod 6).
    const vKeys: string[] = [];
    for (let k = 0; k < 6; k++) {
      const [ox, oy] = VERTEX_OFFSETS[k];
      const x = cx + ox;
      const y = cy + oy;
      const key = vertexKey(x, y);
      vKeys.push(key);
      if (!vertexHexes.has(key)) {
        vertexHexes.set(key, new Set());
        vertexCoordsMap.set(key, [quantize(x), quantize(y)]);
      }
      vertexHexes.get(key)!.add(id);
    }

    const eIds: string[] = [];
    for (let k = 0; k < 6; k++) {
      const a = vKeys[k];
      const b = vKeys[(k + 1) % 6];
      const [lo, hi] = a < b ? [a, b] : [b, a];
      const eId = `e:${lo}|${hi}`;
      eIds.push(eId);
      if (!edgeHexes.has(eId)) {
        edgeHexes.set(eId, new Set());
        edgeEndpoints.set(eId, [lo, hi]);
      }
      edgeHexes.get(eId)!.add(id);
    }

    const neighbors: string[] = [];
    for (const [dq, dr] of DIRS) {
      const nId = hexId(q + dq, r + dr);
      if (slotSet.has(nId)) neighbors.push(nId);
    }
    neighbors.sort();

    hexes.push({
      id,
      q,
      r,
      neighbors,
      vertices: vKeys.slice().sort(),
      edges: eIds.sort(),
    });
  }

  // Vertex -> incident edges (derived from edge endpoints), and vertex ->
  // edge-adjacent vertices (the distance-rule neighbor index).
  const vertexEdges = new Map<string, Set<string>>();
  const vertexAdjacent = new Map<string, Set<string>>();
  for (const [eId, [a, b]] of edgeEndpoints) {
    if (!vertexEdges.has(a)) vertexEdges.set(a, new Set());
    if (!vertexEdges.has(b)) vertexEdges.set(b, new Set());
    vertexEdges.get(a)!.add(eId);
    vertexEdges.get(b)!.add(eId);
    if (!vertexAdjacent.has(a)) vertexAdjacent.set(a, new Set());
    if (!vertexAdjacent.has(b)) vertexAdjacent.set(b, new Set());
    vertexAdjacent.get(a)!.add(b);
    vertexAdjacent.get(b)!.add(a);
  }

  const edges: EdgeRef[] = [...edgeHexes.entries()]
    .map(([id, hexSet]) => {
      const [a, b] = edgeEndpoints.get(id)!;
      const hexList = [...hexSet].sort();
      return { id, a, b, hexes: hexList, coastal: hexList.length === 1 };
    })
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const vertices: VertexRef[] = [...vertexHexes.entries()]
    .map(([id, hexSet]) => ({
      id,
      hexes: [...hexSet].sort(),
      edges: [...(vertexEdges.get(id) ?? new Set<string>())].sort(),
      adjacent: [...(vertexAdjacent.get(id) ?? new Set<string>())].sort(),
    }))
    .sort((x, y) => (x.id < y.id ? -1 : x.id > y.id ? 1 : 0));

  const vertexCoords: Record<string, [number, number]> = {};
  for (const [id, coords] of vertexCoordsMap) vertexCoords[id] = coords;

  const coastalVertices = vertices
    .filter((v) => v.hexes.length < 3)
    .map((v) => v.id)
    .sort();

  const interiorEdgeCount = edges.filter((e) => !e.coastal).length;
  const coastalEdgeCount = edges.filter((e) => e.coastal).length;

  return {
    hexes,
    edges,
    vertices,
    vertexCoords,
    coastalVertices,
    interiorEdgeCount,
    coastalEdgeCount,
  };
}

function vertexIndex(topo: IslandTopology): Map<string, VertexRef> {
  return new Map(topo.vertices.map((v) => [v.id, v]));
}

/**
 * Distance rule: a new settlement/city may be placed on `vertexId` iff the
 * vertex itself is unoccupied AND no vertex at the other end of any incident
 * edge is occupied. (Vertices that merely share a hex corner but no edge do
 * NOT block.) Uses the precomputed `VertexRef.adjacent` index — O(deg), no
 * edge scan.
 */
export function distanceRuleFree(
  topo: IslandTopology,
  vertexId: string,
  occupied: ReadonlySet<string>,
): boolean {
  if (occupied.has(vertexId)) return false;
  const v = vertexIndex(topo).get(vertexId);
  if (!v) throw new RangeError(`distanceRuleFree: unknown vertex ${vertexId}`);
  for (const other of v.adjacent) {
    if (occupied.has(other)) return false;
  }
  return true;
}

/** Hex ids touching a vertex (sorted). Throws on unknown vertex. */
export function hexesAtVertex(topo: IslandTopology, vertexId: string): string[] {
  const v = vertexIndex(topo).get(vertexId);
  if (!v) throw new RangeError(`hexesAtVertex: unknown vertex ${vertexId}`);
  return v.hexes.slice();
}

/** Ids of the 6 corner hexes (degree 3 — fewest neighbors on the island). */
export function cornerHexes(topo: IslandTopology): string[] {
  return topo.hexes
    .filter((h) => h.neighbors.length === 3)
    .map((h) => h.id)
    .sort();
}

/**
 * Cube distance between two hexes identified by id ("q,r").
 * `topo` is accepted for API symmetry with the other helpers (the metric is
 * purely coordinate-derived) and to leave room for non-standard boards.
 */
export function cubeDistance(topo: IslandTopology, a: string, b: string): number {
  void topo;
  const parse = (id: string): [number, number] => {
    const [q, r] = id.split(",").map(Number);
    if (!Number.isInteger(q) || !Number.isInteger(r)) {
      throw new RangeError(`cubeDistance: malformed hex id ${id}`);
    }
    return [q, r];
  };
  const [aq, ar] = parse(a);
  const [bq, br] = parse(b);
  const as = -aq - ar;
  const bs = -bq - br;
  return (Math.abs(aq - bq) + Math.abs(ar - br) + Math.abs(as - bs)) / 2;
}
