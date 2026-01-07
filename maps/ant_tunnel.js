module.exports = {
    name: 'ANT_TUNNEL',
    allowedSizes: ['M', 'L'],
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 개미굴 (Organic Worm Tunnels) - MAZE 변형
        // 기존 GLACIER (Worm) 로직에서 얼음(3) -> 빈 공간(0)으로 변경
        // 1: 벽, 0: 길
        const map = Array.from({ length: rows }, () => Array(cols).fill(1));

        const worms = [];
        worms.push({
            x: Math.floor(cols / 2),
            y: Math.floor(rows / 2),
            dir: Math.floor(Math.random() * 4),
            life: 300
        });

        const totalTiles = rows * cols;
        let carvedCount = 0;
        const targetFill = totalTiles * 0.45;

        function getEmptyNeighborCount(mx, my) {
            let count = 0;
            const check = [[0, 1], [0, -1], [1, 0], [-1, 0]];
            for (const d of check) {
                const cx = mx + d[0];
                const cy = my + d[1];
                if (cx >= 0 && cx < cols && cy >= 0 && cy < rows) {
                    if (map[cy][cx] === 0) count++; // 0체크
                }
            }
            return count;
        }

        while (worms.length > 0 && carvedCount < targetFill) {
            for (let i = worms.length - 1; i >= 0; i--) {
                const worm = worms[i];

                if (map[worm.y][worm.x] === 1) {
                    map[worm.y][worm.x] = 0; // 0으로 뚫기
                    carvedCount++;
                }

                const moves = [
                    { dx: 0, dy: -1, dir: 0 },
                    { dx: 0, dy: 1, dir: 1 },
                    { dx: -1, dy: 0, dir: 2 },
                    { dx: 1, dy: 0, dir: 3 }
                ];

                if (Math.random() < 0.2) moves.sort(() => Math.random() - 0.5);
                else {
                    const others = moves.filter(m => m.dir !== worm.dir);
                    others.sort(() => Math.random() - 0.5);
                    moves.sort((a, b) => (a.dir === worm.dir ? -1 : 1));
                }

                let moved = false;
                for (const move of moves) {
                    const nx = worm.x + move.dx;
                    const ny = worm.y + move.dy;

                    if (nx > 1 && nx < cols - 2 && ny > 1 && ny < rows - 2) {
                        if (map[ny][nx] === 1) {
                            const neighbors = getEmptyNeighborCount(nx, ny);
                            if (neighbors <= 1 || (neighbors === 2 && Math.random() < 0.1)) {
                                worm.x = nx;
                                worm.y = ny;
                                worm.dir = move.dir;
                                worm.life--;
                                moved = true;
                                break;
                            }
                        }
                    }
                }

                if (!moved || worm.life <= 0) {
                    worms.splice(i, 1);
                } else {
                    if (Math.random() < 0.05 && worms.length < 15) {
                        worms.push({
                            x: worm.x,
                            y: worm.y,
                            dir: Math.floor(Math.random() * 4),
                            life: 50
                        });
                    }
                }
            }

            if (worms.length === 0 && carvedCount < targetFill) {
                let revived = false;
                for (let k = 0; k < 100; k++) {
                    const rx = Math.floor(Math.random() * (cols - 4)) + 2;
                    const ry = Math.floor(Math.random() * (rows - 4)) + 2;
                    if (map[ry][rx] === 0) { // 0체크
                        worms.push({ x: rx, y: ry, dir: Math.floor(Math.random() * 4), life: 50 });
                        revived = true;
                        break;
                    }
                }
                if (!revived) break;
            }
        }

        for (let r = 0; r < rows; r++) { map[r][0] = 1; map[r][cols - 1] = 1; }
        for (let c = 0; c < cols; c++) { map[0][c] = 1; map[rows - 1][c] = 1; }

        return map;
    }
};
