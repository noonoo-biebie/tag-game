const { ROWS, COLS, TILE_SIZE } = require('./config');

// 랜덤 스폰 위치 반환
function getRandomSpawn(mapData) {
    let x, y, c, r;
    do {
        c = Math.floor(Math.random() * COLS);
        r = Math.floor(Math.random() * ROWS);
    } while (mapData[r][c] === 1); // 벽이 아닐 때까지 반복
    return { x: c * TILE_SIZE, y: r * TILE_SIZE };
}

// 봇 충돌 체크 (BOUNDING BOX - 여유 공간 추가)
function checkBotWallCollision(x, y, mapData) {
    // 5px 여유를 두어 모서리 끼임 방지
    const margin = 5;
    const points = [
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 좌상단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + margin) / TILE_SIZE) }, // 우상단
        { c: Math.floor((x + margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) }, // 좌하단
        { c: Math.floor((x + TILE_SIZE - margin) / TILE_SIZE), r: Math.floor((y + TILE_SIZE - margin) / TILE_SIZE) } // 우하단
    ];

    for (const p of points) {
        if (p.r < 0 || p.r >= ROWS || p.c < 0 || p.c >= COLS) return true; // 맵 밖
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

        if (r >= 0 && r < ROWS && c >= 0 && c < COLS) {
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
    visited.add(`${startC},${startR}`);

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

        for (const dir of dirs) {
            const nc = c + dir.dc;
            const nr = r + dir.dr;

            if (nc >= 0 && nc < COLS && nr >= 0 && nr < ROWS &&
                mapData[nr][nc] === 0 && !visited.has(`${nc},${nr}`)) {

                visited.add(`${nc},${nr}`);
                queue.push({
                    c: nc, r: nr,
                    path: [...path, { c: nc, r: nr }]
                });
            }
        }
    }
    return []; // 경로 없음
}

module.exports = {
    getRandomSpawn,
    checkBotWallCollision,
    checkLineOfSight,
    findPath
};
