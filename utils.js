const { TILE_SIZE } = require('./config');

// 랜덤 스폰 위치 반환
function getRandomSpawn(mapData) {
    const rows = mapData.length;
    const cols = mapData[0].length;
    let x, y, r, c;
    do {
        c = Math.floor(Math.random() * cols);
        r = Math.floor(Math.random() * rows);
    } while (mapData[r][c] === 1); // 벽이 아닐 때까지 반복
    return { x: c * TILE_SIZE, y: r * TILE_SIZE };
}

// 봇 충돌 체크 (BOUNDING BOX - 여유 공간 추가)
function checkBotWallCollision(x, y, mapData) {
    const rows = mapData.length;
    const cols = mapData[0].length;
    // 5px 여유를 두어 모서리 끼임 방지
    const margin = 5;
    const points = [
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 좌상단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 우상단
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) }, // 좌하단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) } // 우하단
    ];

    for (const p of points) {
        if (p.r < 0 || p.r >= rows || p.c < 0 || p.c >= cols) return true; // 맵 밖
        if (mapData[p.r][p.c] === 1) return true; // 벽
    }
    return false;
}

// 두 점 사이의 시야 체크 (벽이 있는지) (Bresenham-like)
function checkLineOfSight(x1, y1, x2, y2, mapData) {
    // 4px 단위로 촘촘하게 검사 (벽 관통 방지)
    const steps = Math.max(Math.abs(x2 - x1), Math.abs(y2 - y1)) / 4;
    const dx = (x2 - x1) / steps;
    const dy = (y2 - y1) / steps;

    let cx = x1;
    let cy = y1;

    for (let i = 0; i < steps; i++) {
        const c = Math.floor(cx / TILE_SIZE);
        const r = Math.floor(cy / TILE_SIZE);

        const rows = mapData.length;
        const cols = mapData[0].length;

        if (r >= 0 && r < rows && c >= 0 && c < cols) {
            if (mapData[r][c] === 1) return false; // 벽 막힘
        }

        cx += dx;
        cy += dy;
    }
    return true; // 뚫림
}

// BFS 경로 탐색 (Grid 기반)
function findPath(startX, startY, endX, endY, mapData) {
    const startC = Math.floor(startX / TILE_SIZE);
    const startR = Math.floor(startY / TILE_SIZE);
    const endC = Math.floor(endX / TILE_SIZE);
    const endR = Math.floor(endY / TILE_SIZE);

    if (startC === endC && startR === endR) return [];

    const queue = [{ c: startC, r: startR, path: [] }];
    const visited = new Set();
    visited.add(`${startC},${startR} `);

    // 최대 탐색 거리 제한 (너무 멀면 렉 방지)
    let iter = 0;
    const MAX_ITER = 300;

    while (queue.length > 0) {
        if (iter++ > MAX_ITER) break;

        const { c, r, path } = queue.shift();

        if (c === endC && r === endR) {
            return path.map(p => ({ x: p.c * TILE_SIZE + TILE_SIZE / 2, y: p.r * TILE_SIZE + TILE_SIZE / 2 }));
        }

        const dirs = [
            { dc: 0, dr: -1 }, { dc: 0, dr: 1 }, { dc: -1, dr: 0 }, { dc: 1, dr: 0 }
        ];

        const rows = mapData.length;
        const cols = mapData[0].length;

        for (const dir of dirs) {
            const nc = c + dir.dc;
            const nr = r + dir.dr;

            if (nc >= 0 && nc < cols && nr >= 0 && nr < rows &&
                mapData[nr][nc] === 0 && !visited.has(`${nc},${nr} `)) {

                visited.add(`${nc},${nr} `);
                queue.push({
                    c: nc, r: nr,
                    path: [...path, { c: nc, r: nr }]
                });
            }
        }
    }
    return []; // 경로 없음
}

// [이름 변경] 기존 미로 알고리즘 -> MAZE_BIG (Recursive Backtracker)
function generateMazeBig(rows, cols) {
    const R = rows % 2 === 0 ? rows + 1 : rows;
    const C = cols % 2 === 0 ? cols + 1 : cols;
    const map = Array.from({ length: R }, () => Array(C).fill(1));

    const stack = [];
    map[1][1] = 0;
    stack.push({ r: 1, c: 1 });

    const directions = [
        { dr: -2, dc: 0 }, { dr: 2, dc: 0 }, { dr: 0, dc: -2 }, { dr: 0, dc: 2 }
    ];

    while (stack.length > 0) {
        const current = stack[stack.length - 1];
        const neighbors = [];
        for (const dir of directions) {
            const nr = current.r + dir.dr;
            const nc = current.c + dir.dc;
            if (nr > 0 && nr < R - 1 && nc > 0 && nc < C - 1 && map[nr][nc] === 1) {
                neighbors.push({ nr, nc, dr: dir.dr, dc: dir.dc });
            }
        }

        if (neighbors.length > 0) {
            const chosen = neighbors[Math.floor(Math.random() * neighbors.length)];
            map[current.r + chosen.dr / 2][current.c + chosen.dc / 2] = 0;
            map[chosen.nr][chosen.nc] = 0;
            stack.push({ r: chosen.nr, c: chosen.nc });
        } else {
            stack.pop();
        }
    }

    // Braiding
    for (let r = 2; r < R - 2; r++) {
        for (let c = 2; c < C - 2; c++) {
            if (map[r][c] === 1 && Math.random() < 0.15) map[r][c] = 0;
        }
    }
    return map;
}

// [구 Backrooms] Office로 변경 (방 + 복도 구조)
function generateOffice(rows, cols) {
    const map = Array.from({ length: rows }, () => Array(cols).fill(1));
    const rooms = [];

    class Node {
        constructor(r, c, w, h) {
            this.r = r; this.c = c; this.w = w; this.h = h;
            this.left = null; this.right = null;
            this.room = null;
        }
    }

    const MIN_SIZE = 8;

    function split(node) {
        if (node.left || node.right) return;

        let splitH = Math.random() < 0.5;
        if (node.w > node.h && node.w / node.h >= 1.25) splitH = false;
        else if (node.h > node.w && node.h / node.w >= 1.25) splitH = true;

        const max = (splitH ? node.h : node.w) - MIN_SIZE;
        if (max < MIN_SIZE) return;

        const splitSize = Math.floor(Math.random() * (max - MIN_SIZE + 1)) + MIN_SIZE;

        if (splitH) {
            node.left = new Node(node.r, node.c, node.w, splitSize);
            node.right = new Node(node.r + splitSize, node.c, node.w, node.h - splitSize);
        } else {
            node.left = new Node(node.r, node.c, splitSize, node.h);
            node.right = new Node(node.r, node.c + splitSize, node.h - splitSize, node.w - splitSize);
        }

        split(node.left);
        split(node.right);
    }

    const root = new Node(1, 1, rows - 2, cols - 2);
    split(root);

    function getCenter(node) {
        if (node.room) return { r: Math.floor(node.room.r + node.room.h / 2), c: Math.floor(node.room.c + node.room.w / 2) };
        if (node.left && node.right) {
            const l = getCenter(node.left);
            const r = getCenter(node.right);
            return Math.random() < 0.5 ? l : r;
        }
        return { r: Math.floor(node.r + node.h / 2), c: Math.floor(node.c + node.w / 2) };
    }

    // 수평 터널 (폭 2 + 안전 체크)
    function hTunnel(r, c1, c2) {
        const minC = Math.min(c1, c2);
        const maxC = Math.max(c1, c2);
        for (let c = minC; c <= maxC; c++) {
            if (c < 0 || c >= cols) continue;

            if (r >= 0 && r < rows) map[r][c] = 0;
            if (r + 1 >= 0 && r + 1 < rows) map[r + 1][c] = 0;
        }
    }

    // 수직 터널 (폭 2 + 안전 체크)
    function vTunnel(c, r1, r2) {
        const minR = Math.min(r1, r2);
        const maxR = Math.max(r1, r2);
        for (let r = minR; r <= maxR; r++) {
            if (r < 0 || r >= rows) continue;

            if (c >= 0 && c < cols) map[r][c] = 0;
            if (c + 1 >= 0 && c + 1 < cols) map[r][c + 1] = 0;
        }
    }

    // L자형 직선 복도 생성
    function createCorridor(p1, p2) {
        if (Math.random() < 0.5) {
            // 수평 -> 수직
            hTunnel(p1.r, p1.c, p2.c);
            vTunnel(p2.c, p1.r, p2.r);
        } else {
            // 수직 -> 수평
            vTunnel(p1.c, p1.r, p2.r);
            hTunnel(p2.r, p1.c, p2.c);
        }
    }

    function processNode(node) {
        if (node.left || node.right) {
            if (node.left) processNode(node.left);
            if (node.right) processNode(node.right);

            if (node.left && node.right) {
                createCorridor(getCenter(node.left), getCenter(node.right));
            }
        } else {
            // 방 생성 (여백 1칸)
            const padding = 1;
            const roomW = Math.max(4, node.w - padding * 2);
            const roomH = Math.max(4, node.h - padding * 2);

            const roomR = node.r + padding;
            const roomC = node.c + padding;

            node.room = { r: roomR, c: roomC, w: roomW, h: roomH };
            rooms.push(node.room);
            // 방 뚫기 (안전 체크 추가)
            for (let r = roomR; r < roomR + roomH; r++) {
                if (!map[r]) continue; // 행 체크
                for (let c = roomC; c < roomC + roomW; c++) {
                    if (c >= 0 && c < cols) map[r][c] = 0;
                }
            }

            // 기둥 (큰 방만, 가끔)
            if (roomW >= 10 && roomH >= 10 && Math.random() < 0.3) {
                addPillars(roomR, roomC, roomW, roomH);
            }
        }
    }

    function addPillars(r, c, w, h) {
        const gap = 3;
        for (let i = 2; i < h - 2; i += gap) {
            const rowIndex = r + i;
            if (!map[rowIndex]) continue;
            for (let j = 2; j < w - 2; j += gap) {
                const colIndex = c + j;
                if (colIndex >= 0 && colIndex < cols) map[rowIndex][colIndex] = 1;
            }
        }
    }

    processNode(root);

    // [추가 연결] 가까운 방끼리 추가 복도 연결 (순환 구조 형성)
    // 모든 방에 대해 수행하지 않고, 랜덤하게 일부 방만 선택하여 이웃 방과 연결
    const extraConnections = Math.floor(rooms.length * 0.5); // 방의 50% 정도는 추가 연결 시도

    for (let i = 0; i < extraConnections; i++) {
        const roomA = rooms[Math.floor(Math.random() * rooms.length)];

        // 가장 가까운 방 찾기 (자신 제외)
        let bestDist = Infinity;
        let roomB = null;

        const centerA = { r: roomA.r + roomA.h / 2, c: roomA.c + roomA.w / 2 };

        for (const other of rooms) {
            if (other === roomA) continue;
            const centerB = { r: other.r + other.h / 2, c: other.c + other.w / 2 };
            const dist = Math.abs(centerA.r - centerB.r) + Math.abs(centerA.c - centerB.c);

            if (dist < bestDist) {
                bestDist = dist;
                roomB = other;
            }
        }

        if (roomB) {
            const centerB = { r: Math.floor(roomB.r + roomB.h / 2), c: Math.floor(roomB.c + roomB.w / 2) };
            const centerA_Int = { r: Math.floor(centerA.r), c: Math.floor(centerA.c) };
            createCorridor(centerA_Int, centerB);
        }
    }

    return map;
}

// [신규 Backrooms] Level 0 (Main Maze + Embedded Zones)
function generateBackrooms(rows, cols) {
    const map = Array.from({ length: rows }, () => Array(cols).fill(1));

    // Core Maze Generator (Recursive Backtracker)
    function createMaze(r1, c1, r2, c2, width) {
        const step = width + 1; // 벽 1칸 포함한 이동 간격
        const visited = new Set();
        const directions = [{ dr: -step, dc: 0 }, { dr: step, dc: 0 }, { dr: 0, dc: -step }, { dr: 0, dc: step }];

        function carve(r, c) {
            for (let i = 0; i < width; i++) {
                for (let j = 0; j < width; j++) {
                    if (r + i <= r2 && c + j <= c2) map[r + i][c + j] = 0;
                }
            }
        }

        function connect(ra, ca, rb, cb) {
            const minR = Math.min(ra, rb), maxR = Math.max(ra, rb);
            const minC = Math.min(ca, cb), maxC = Math.max(ca, cb);
            const rLimit = maxR + width - 1;
            const cLimit = maxC + width - 1;

            for (let r = minR; r <= rLimit; r++) {
                for (let c = minC; c <= cLimit; c++) {
                    if (r >= r1 && r <= r2 && c >= c1 && c <= c2) map[r][c] = 0;
                }
            }
        }

        function dfs(r, c) {
            visited.add(`${r},${c}`);
            carve(r, c);
            const dirs = [...directions].sort(() => Math.random() - 0.5);
            for (const { dr, dc } of dirs) {
                const nr = r + dr, nc = c + dc;
                if (nr >= r1 + 2 && nr <= r2 - width && nc >= c1 + 2 && nc <= c2 - width) {
                    if (!visited.has(`${nr},${nc}`)) {
                        connect(r, c, nr, nc);
                        dfs(nr, nc);
                    }
                }
            }
        }

        // Start near center
        dfs(r1 + 2, c1 + 2);

        // Random Loops
        for (let r = r1 + 1; r < r2 - 1; r++) {
            for (let c = c1 + 1; c < c2 - 1; c++) {
                if (map[r][c] === 1 && Math.random() < 0.1) {
                    const openV = (map[r - 1][c] === 0 && map[r + 1][c] === 0);
                    const openH = (map[r][c - 1] === 0 && map[r][c + 1] === 0);
                    if (openV || openH) map[r][c] = 0;
                }
            }
        }
    }

    // Zone Generators
    const generators = {
        MAZE: (r1, c1, r2, c2) => createMaze(r1, c1, r2, c2, 2), // Base: Narrow (2칸)
        WIDE: (r1, c1, r2, c2) => createMaze(r1, c1, r2, c2, 3), // Zone: Wide (3칸)

        OPEN: function (r1, c1, r2, c2) {
            for (let r = r1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    if (r <= 0 || c <= 0 || r >= rows - 1 || c >= cols - 1) continue;
                    map[r][c] = 0;
                    if (Math.random() < 0.05) map[r][c] = 1;
                }
            }
        },

        PATTERN: function (r1, c1, r2, c2) {
            const type = Math.random() < 0.5 ? 'GRID' : 'LINES';
            for (let r = r1; r <= r2; r++) {
                for (let c = c1; c <= c2; c++) {
                    if (r <= 0 || c <= 0 || r >= rows - 1 || c >= cols - 1) continue;
                    map[r][c] = 0;
                    if (type === 'GRID') {
                        if (r % 4 === 0 && c % 4 === 0) map[r][c] = 1;
                    } else {
                        if (c % 5 === 0 && r % 6 !== 0) map[r][c] = 1;
                    }
                }
            }
        }
    };

    // 1. 기본 베이스: 전체 맵을 좁은 미로(Maze)로 채움
    generators.MAZE(0, 0, rows - 1, cols - 1);

    // 2. 서브 구역 (Open, Pattern, Wide) 삽입
    const zones = [];
    const zoneTypes = ['OPEN', 'PATTERN', 'WIDE'];

    for (const type of zoneTypes) {
        // 크기 제한: 12~20칸
        const w = Math.floor(12 + Math.random() * 9);
        const h = Math.floor(12 + Math.random() * 9);

        for (let k = 0; k < 10; k++) {
            const r = Math.floor(Math.random() * (rows - h - 6)) + 3;
            const c = Math.floor(Math.random() * (cols - w - 6)) + 3;

            let overlap = false;
            for (const z of zones) {
                if (r < z.r2 + 4 && r + h > z.r1 - 4 && c < z.c2 + 4 && c + w > z.c1 - 4) {
                    overlap = true;
                    break;
                }
            }

            if (!overlap) {
                const r2 = r + h;
                const c2 = c + w;

                generators[type](r, c, r2, c2);

                // 테두리 연결
                for (let cc = c + 2; cc < c2 - 2; cc += 3) { map[r][cc] = 0; map[r2][cc] = 0; }
                for (let rr = r + 2; rr < r2 - 2; rr += 3) { map[rr][c] = 0; map[rr][c2] = 0; }

                zones.push({ r1: r, c1: c, r2: r2, c2: c2, type: type });
                break;
            }
        }
    }

    return map;
}

module.exports = {
    getRandomSpawn,
    checkBotWallCollision,
    checkLineOfSight,
    findPath,
    generateMazeBig,
    generateOffice,
    generateBackrooms
};
