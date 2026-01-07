module.exports = {
    name: 'BACKROOMS',
    allowedSizes: ['M', 'L'],
    generate: function (rows = 60, cols = 60) {
        const map = Array.from({ length: rows }, () => Array(cols).fill(1));
        const zoneMap = Array.from({ length: rows }, () => Array(cols).fill('MAZE'));
        const zones = [];

        // 1. 구역 배치 (Layout Zones)
        const possibleTypes = ['OPEN', 'PATTERN', 'WIDE_ROOM', 'WIDE_PATH', 'WIDE_ROOM'];
        const zoneInfos = possibleTypes.sort(() => Math.random() - 0.5);

        console.log(`[MapGen] Layout Plan: ${zoneInfos.join(', ')}`);

        for (const type of zoneInfos) {
            let minSize = 12;
            if (type.includes('WIDE')) minSize = 18;

            const w = Math.floor(minSize + Math.random() * 8);
            const h = Math.floor(minSize + Math.random() * 8);

            // 배치 시도
            for (let k = 0; k < 20; k++) {
                const r = Math.floor(Math.random() * (rows - h - 6)) + 3;
                const c = Math.floor(Math.random() * (cols - w - 6)) + 3;

                // 겹침 확인
                let overlap = false;
                for (let rr = r - 2; rr <= r + h + 2; rr++) {
                    for (let cc = c - 2; cc <= c + w + 2; cc++) {
                        if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) {
                            if (zoneMap[rr][cc] !== 'MAZE') overlap = true;
                        }
                    }
                }

                if (!overlap) {
                    for (let rr = r; rr < r + h; rr++) {
                        for (let cc = c; cc < c + w; cc++) {
                            zoneMap[rr][cc] = type;
                        }
                    }
                    zones.push({ r1: r, c1: c, r2: r + h - 1, c2: c + w - 1, type: type, w, h });
                    console.log(`[MapGen] Zone ${type} assigned at (${r},${c})`);
                    break;
                }
            }
        }

        // 2. 생성기
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
                    if (nr >= r1 && nr <= r2 - width + 1 && nc >= c1 && nc <= c2 - width + 1) {
                        if (zoneMap[nr][nc] === targetType && !visited.has(`${nr},${nc}`)) {
                            connect(r, c, nr, nc);
                            dfs(nr, nc);
                        }
                    }
                }
            }

            for (let r = r1; r <= r2; r += step) {
                for (let c = c1; c <= c2; c += step) {
                    if (zoneMap[r][c] === targetType && !visited.has(`${r},${c}`)) {
                        if (r + width <= rows && c + width <= cols) {
                            dfs(r, c);
                        }
                    }
                }
            }

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

        createMaze(0, 0, rows - 1, cols - 1, 2, 'MAZE');

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

        zones.forEach(z => {
            const { r1, c1, r2, c2, type } = z;
            const connections = [];

            for (let c = c1; c <= c2; c++) {
                if (r1 > 0 && zoneMap[r1 - 1][c] === 'MAZE') connections.push({ r: r1, c: c, dr: -1, dc: 0 });
                if (r2 < rows - 1 && zoneMap[r2 + 1][c] === 'MAZE') connections.push({ r: r2, c: c, dr: 1, dc: 0 });
            }
            for (let r = r1; r <= r2; r++) {
                if (c1 > 0 && zoneMap[r][c1 - 1] === 'MAZE') connections.push({ r: r, c: c1, dr: 0, dc: -1 });
                if (c2 < cols - 1 && zoneMap[r][c2 + 1] === 'MAZE') connections.push({ r: r, c: c2, dr: 0, dc: 1 });
            }

            let numLinks = 4;
            if (type === 'WIDE_ROOM') numLinks = 6;
            if (type === 'WIDE_PATH') numLinks = 12;
            if (type === 'OPEN') numLinks = 8;

            connections.sort(() => Math.random() - 0.5);
            for (let i = 0; i < Math.min(numLinks, connections.length); i++) {
                const { r, c, dr, dc } = connections[i];
                map[r][c] = 0;
                map[r + dr][c + dc] = 0;
                if (dr !== 0) {
                    if (c + 1 <= c2) { map[r][c + 1] = 0; map[r + dr][c + dc + 1] = 0; }
                } else {
                    if (r + 1 <= r2) { map[r + 1][c] = 0; map[r + dr + 1][c + dc] = 0; }
                }
            }
        });

        function cleanupMap() {
            const visited = Array.from({ length: rows }, () => Array(cols).fill(false));
            const regions = [];

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

            regions.sort((a, b) => b.length - a.length);

            if (regions.length > 1) {
                const mainRegion = regions[0];
                console.log(`[MapGen] Cleanup: Found ${regions.length} regions. Main size: ${mainRegion.length}`);

                for (let i = 1; i < regions.length; i++) {
                    const region = regions[i];
                    if (region.length < 20) {
                        for (const { r, c } of region) map[r][c] = 1;
                    } else {
                        console.log(`[MapGen] Connecting isolated region of size ${region.length}`);
                        const p1 = region[Math.floor(region.length / 2)];
                        const p2 = mainRegion[Math.floor(mainRegion.length / 2)];

                        let cr = p1.r, cc = p1.c;
                        while (cr !== p2.r || cc !== p2.c) {
                            map[cr][cc] = 0;
                            if (cr < p2.r) cr++;
                            else if (cr > p2.r) cr--;
                            else if (cc < p2.c) cc++;
                            else if (cc > p2.c) cc--;

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
};
