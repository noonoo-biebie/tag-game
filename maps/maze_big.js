module.exports = {
    name: 'MAZE_BIG',
    generate: function (rows = 60, cols = 60) {
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
};
