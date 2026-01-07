const { TILE_SIZE } = require('./config');

// 랜덤 스폰 위치 반환 (Safe Spawn v2)
function getRandomSpawn(mapData, validPoints = null) {
    // 1. 미리 계산된 안전 구역이 있으면 거기서 뽑기 (O(1))
    if (validPoints && validPoints.length > 0) {
        const p = validPoints[Math.floor(Math.random() * validPoints.length)];
        return { x: p.c * TILE_SIZE, y: p.r * TILE_SIZE };
    }

    // 2. Fallback: 기존 랜덤 서치 (최대 100번 시도)
    const rows = mapData.length;
    const cols = mapData[0].length;
    let attempts = 0;
    while (attempts < 100) { // [Safety] 무한 루프 방지
        const c = Math.floor(Math.random() * mapData[0].length);
        const r = Math.floor(Math.random() * mapData.length);
        const tile = mapData[r][c];

        // 0(빈공간), 2(진흙), 3(얼음)은 스폰 가능, 1(벽), 4(용암) 불가
        if (tile !== 1 && tile !== 4) {
            return { x: c * 32, y: r * 32 };
        }
        attempts++;
    }
    // 실패 시 맵 중앙 근처 안전 구역 반환 (fallback)
    return { x: 32, y: 32 };

    // 3. 정 안되면 맵 전체를 뒤져서라도 안전한 곳(0, 2, 3) 하나 찾기
    for (let rr = 1; rr < rows - 1; rr++) {
        for (let cc = 1; cc < cols - 1; cc++) {
            const t = mapData[rr][cc];
            // [Fix] 블랙리스트 방식
            if (t !== 1 && t !== 4) {
                return { x: cc * TILE_SIZE, y: rr * TILE_SIZE };
            }
        }
    }

    // 최후의 수단 (정말 맵에 빈 곳이 하나도 없으면?? 일단 1,1 리턴하지만 로그 남김)
    console.error("CRITICAL: No valid spawn point found on map!");
    return { x: TILE_SIZE, y: TILE_SIZE };
}

// [New] 맵 연결성 분석 (Flood Fill)
// 가장 큰 빈 공간 덩어리를 찾아, 그 안의 좌표들만 반환함
function analyzeMapConnectivity(mapData) {
    const rows = mapData.length;
    const cols = mapData[0].length;
    const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
    const regions = [];

    for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
            // [Fix] 0(Empty), 2(Mud), 3(Ice) 모두 체크
            const tile = mapData[r][c];
            if ((tile === 0 || tile === 2 || tile === 3) && !visited[r][c]) {
                // 새로운 영역 발견 -> 탐색 시작
                const regionPoints = [];
                const queue = [{ r, c }];
                visited[r][c] = true;
                regionPoints.push({ r, c });

                let head = 0;
                while (head < queue.length) {
                    const curr = queue[head++];
                    const dirs = [
                        { r: 1, c: 0 }, { r: -1, c: 0 }, { r: 0, c: 1 }, { r: 0, c: -1 }
                    ];

                    for (const d of dirs) {
                        const nr = curr.r + d.r;
                        const nc = curr.c + d.c;

                        if (nr >= 0 && nr < rows && nc >= 0 && nc < cols) {
                            // [Fix] 0(Empty), 2(Mud), 3(Ice) 모두 이동 가능 영역으로 간주
                            const nextTile = mapData[nr][nc];
                            if ((nextTile === 0 || nextTile === 2 || nextTile === 3) && !visited[nr][nc]) {
                                visited[nr][nc] = true;
                                regionPoints.push({ r: nr, c: nc });
                                queue.push({ r: nr, c: nc });
                            }
                        }
                    }
                }
                regions.push(regionPoints);
            }
        }
    }

    if (regions.length === 0) return [];

    // 가장 큰 영역 선택
    regions.sort((a, b) => b.length - a.length);
    const mainRegion = regions[0];

    console.log(`[MapAnalysis] Found ${regions.length} regions. Main region size: ${mainRegion.length} tiles.`);

    // 만약 메인 영역이 너무 작다면(예: 10칸 미만), 맵이 이상한 것임.
    if (mainRegion.length < 10) {
        console.warn('[MapAnalysis] Warning: Main region is very small!');
    }

    return mainRegion;
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
        // [Fix] 벽(1) 또는 용암(4)이면 충돌로 처리
        const tile = mapData[p.r][p.c];
        if (tile === 1 || tile === 4) return true;
    }
    return false;
}

// 두 점 사이의 시야 체크 (벽이 있는지) (Bresenham-like)
function checkLineOfSight(x1, y1, x2, y2, mapData) {
    // [Safety] 맵 데이터 유효성 검사
    if (!mapData || !mapData.length || !mapData[0]) return false;

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
            // [Fix] 벽(1) 또는 용암(4)이면 시야 차단
            const tile = mapData[r][c];
            if (tile === 1 || tile === 4) return false;
        }

        cx += dx;
        cy += dy;
    }
    return true; // 뚫림
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

// [신규 Backrooms] Level 0 (Mask-based Layout)
function generateBackrooms(rows, cols) {
    const map = Array.from({ length: rows }, () => Array(cols).fill(1));
    const zoneMap = Array.from({ length: rows }, () => Array(cols).fill('MAZE')); // 구역 마스킹
    const zones = [];

    // 1. 구역 배치 (Layout Zones)
    // WIDE 구역의 비중을 높임
    const possibleTypes = ['OPEN', 'PATTERN', 'WIDE_ROOM', 'WIDE_PATH', 'WIDE_ROOM'];
    const zoneInfos = possibleTypes.sort(() => Math.random() - 0.5);

    console.log(`[MapGen] Layout Plan: ${zoneInfos.join(', ')}`);

    for (const type of zoneInfos) {
        let minSize = 12;
        if (type.includes('WIDE')) minSize = 18; // WIDE는 확실히 크게

        const w = Math.floor(minSize + Math.random() * 8);
        const h = Math.floor(minSize + Math.random() * 8);

        let placed = false;
        // 배치 시도
        for (let k = 0; k < 20; k++) {
            const r = Math.floor(Math.random() * (rows - h - 6)) + 3;
            const c = Math.floor(Math.random() * (cols - w - 6)) + 3;

            // 겹침 확인 (여유 2칸)
            let overlap = false;
            for (let rr = r - 2; rr <= r + h + 2; rr++) {
                for (let cc = c - 2; cc <= c + w + 2; cc++) {
                    if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
                        if (zoneMap[rr][cc] !== 'MAZE') overlap = true;
                    }
                }
            }

            if (!overlap) {
                // 마킹
                for (let rr = r; rr < r + h; rr++) {
                    for (let cc = c; cc < c + w; cc++) {
                        zoneMap[rr][cc] = type;
                    }
                }
                zones.push({ r1: r, c1: c, r2: r + h - 1, c2: c + w - 1, type: type, w, h });
                console.log(`[MapGen] Zone ${type} assigned at (${r},${c})`);
                placed = true;
                break;
            }
        }
    }

    // 2. 생성기 (Generators)
    // 범용 미로 생성기 (zoneMap을 준수함)
    function createMaze(r1, c1, r2, c2, width, targetType) {
        const step = width + 1;
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
                // 범위 체크 + [중요] 구역 타입 체크
                if (nr >= r1 && nr <= r2 - width + 1 && nc >= c1 && nc <= c2 - width + 1) {
                    // 다음 발판의 중심이 해당 구역인지 확인
                    if (zoneMap[nr][nc] === targetType && !visited.has(`${nr},${nc}`)) {
                        connect(r, c, nr, nc);
                        dfs(nr, nc);
                    }
                }
            }
        }

        // 시작점 찾기 (해당 구역 내의 유효한 좌표 아무데나)
        for (let r = r1; r <= r2; r += step) {
            for (let c = c1; c <= c2; c += step) {
                if (zoneMap[r][c] === targetType && !visited.has(`${r},${c}`)) {
                    // 여유 공간 확인
                    if (r + width <= rows && c + width <= cols) {
                        dfs(r, c);
                    }
                }
            }
        }

        // Loop 생성 (Maze 퀄리티)
        if (targetType === 'MAZE' || targetType === 'WIDE_PATH') {
            for (let r = r1 + 1; r < r2 - 1; r++) {
                for (let c = c1 + 1; c < c2 - 1; c++) {
                    if (map[r][c] === 1 && zoneMap[r][c] === targetType && Math.random() < 0.1) {
                        const openV = (map[r - 1][c] === 0 && map[r + 1][c] === 0);
                        const openH = (map[r][c - 1] === 0 && map[r][c + 1] === 0);
                        if (openV || openH) map[r][c] = 0;
                    }
                }
            }
        }
    }

    // 각 구역 생성 실행
    // A. Base MAZE (전체 순회하지만 zoneMap=='MAZE'인 곳만 팜)
    createMaze(0, 0, rows - 1, cols - 1, 2, 'MAZE');

    // B. Sub Zones
    zones.forEach(z => {
        if (z.type === 'WIDE_ROOM' || z.type === 'WIDE_PATH') {
            createMaze(z.r1, z.c1, z.r2, z.c2, 3, z.type);
        } else if (z.type === 'OPEN') {
            for (let r = z.r1; r <= z.r2; r++) {
                for (let c = z.c1; c <= z.c2; c++) {
                    map[r][c] = 0;
                    if (Math.random() < 0.05) map[r][c] = 1;
                }
            }
        } else if (z.type === 'PATTERN') {
            const pattern = Math.random() < 0.5 ? 'GRID' : 'LINES';
            for (let r = z.r1; r <= z.r2; r++) {
                for (let c = z.c1; c <= z.c2; c++) {
                    map[r][c] = 0;
                    if (pattern === 'GRID' && r % 4 === 0 && c % 4 === 0) map[r][c] = 1;
                    if (pattern === 'LINES' && c % 5 === 0 && r % 6 !== 0) map[r][c] = 1;
                }
            }
        }
    });

    // 3. 구역 연결 (Connections)
    // 각 Zone의 테두리를 돌면서 인접한 MAZE와 연결
    zones.forEach(z => {
        const { r1, c1, r2, c2, type } = z;

        // 연결 후보 지점 수집
        const connections = [];

        // 상하 테두리
        for (let c = c1; c <= c2; c++) {
            if (r1 > 0 && zoneMap[r1 - 1][c] === 'MAZE') connections.push({ r: r1, c: c, dr: -1, dc: 0 });
            if (r2 < rows - 1 && zoneMap[r2 + 1][c] === 'MAZE') connections.push({ r: r2, c: c, dr: 1, dc: 0 });
        }
        // 좌우 테두리
        for (let r = r1; r <= r2; r++) {
            if (c1 > 0 && zoneMap[r][c1 - 1] === 'MAZE') connections.push({ r: r, c: c1, dr: 0, dc: -1 });
            if (c2 < cols - 1 && zoneMap[r][c2 + 1] === 'MAZE') connections.push({ r: r, c: c2, dr: 0, dc: 1 });
        }

        // 연결 개수 결정
        let numLinks = 4; // 기본
        if (type === 'WIDE_ROOM') numLinks = 6; // 방은 입구 많게
        if (type === 'WIDE_PATH') numLinks = 12; // 패스는 자연스럽게 많이 연결
        if (type === 'OPEN') numLinks = 8;

        // 랜덤 선택 및 뚫기
        connections.sort(() => Math.random() - 0.5);
        for (let i = 0; i < Math.min(numLinks, connections.length); i++) {
            const { r, c, dr, dc } = connections[i];

            // 경계벽 허물기 (2칸 너비로 넉넉하게)
            map[r][c] = 0;
            map[r + dr][c + dc] = 0; // MAZE 쪽 벽

            // 2칸 두께 (직교 방향으로 한 칸 더)
            if (dr !== 0) { // 상하 연결이면 좌우로 확장
                if (c + 1 <= c2) { map[r][c + 1] = 0; map[r + dr][c + dc + 1] = 0; }
            } else { // 좌우 연결이면 상하로 확장
                if (r + 1 <= r2) { map[r + 1][c] = 0; map[r + dr + 1][c + dc] = 0; }
            }
        }
    });

    // 4. [후처리] 고립 지역 제거 및 강제 연결 (Islands Cleanup)
    function cleanupMap() {
        const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
        const regions = [];

        // Flood Fill로 연결된 구역 찾기
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (map[r][c] === 0 && !visited[r][c]) {
                    const region = [];
                    const queue = [{ r, c }];
                    visited[r][c] = true;
                    region.push({ r, c });

                    let head = 0;
                    while (head < queue.length) {
                        const { r: cr, c: cc } = queue[head++];
                        const dirs = [{ dr: 1, dc: 0 }, { dr: -1, dc: 0 }, { dr: 0, dc: 1 }, { dr: 0, dc: -1 }];
                        for (const { dr, dc } of dirs) {
                            const nr = cr + dr, nc = cc + dc;
                            if (nr >= 0 && nr < rows && nc >= 0 && nc < cols && map[nr][nc] === 0 && !visited[nr][nc]) {
                                visited[nr][nc] = true;
                                region.push({ r: nr, c: nc });
                                queue.push({ r: nr, c: nc });
                            }
                        }
                    }
                    regions.push(region);
                }
            }
        }

        // 크기순 정렬 (가장 큰 구역이 메인)
        regions.sort((a, b) => b.length - a.length);

        if (regions.length > 1) {
            const mainRegion = regions[0];

            console.log(`[MapGen] Cleanup: Found ${regions.length} regions. Main size: ${mainRegion.length}`);

            for (let i = 1; i < regions.length; i++) {
                const region = regions[i];

                // 20칸 미만의 작은 구멍은 메워버림 (제거)
                if (region.length < 20) {
                    for (const { r, c } of region) {
                        map[r][c] = 1;
                    }
                } else {
                    // 큰 구역이 끊겨 있다면 메인 구역과 직선으로 뚫어 연결 (응급 복구)
                    console.log(`[MapGen] Connecting isolated region of size ${region.length}`);
                    const p1 = region[Math.floor(region.length / 2)];
                    const p2 = mainRegion[Math.floor(mainRegion.length / 2)];

                    let cr = p1.r, cc = p1.c;
                    // p1 -> p2 직선 파기
                    while (cr !== p2.r || cc !== p2.c) {
                        map[cr][cc] = 0;
                        // 대각선 이동보다는 하나씩
                        if (cr < p2.r) cr++;
                        else if (cr > p2.r) cr--;
                        else if (cc < p2.c) cc++;
                        else if (cc > p2.c) cc--;

                        // 통로 너비 확보
                        if (cr + 1 < rows) map[cr + 1][cc] = 0;
                        if (cc + 1 < cols) map[cr][cc + 1] = 0;
                    }
                    map[p2.r][p2.c] = 0;
                }
            }
        }
    }

    cleanupMap();

    return map;
}

module.exports = {
    getRandomSpawn,
    analyzeMapConnectivity, // [Export]
    checkBotWallCollision,
    checkLineOfSight
};
