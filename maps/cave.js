module.exports = {
    name: 'CAVE',
    allowedSizes: ['M', 'L'],
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 넓은 동굴 (Cellular Automata v1 - Saved)
        // 1: 벽, 0: 바닥 (얼음 아님)

        let map = Array.from({ length: rows }, () => Array(cols).fill(0));

        // 1. 초기화: 랜덤하게 벽 생성 (45%)
        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                if (Math.random() < 0.45) map[r][c] = 1;
                else map[r][c] = 0;
            }
        }

        // 2. Cellular Automata (Smoothing)
        for (let i = 0; i < 5; i++) {
            const newMap = map.map(row => [...row]);
            for (let r = 1; r < rows - 1; r++) {
                for (let c = 1; c < cols - 1; c++) {
                    let wallCount = 0;
                    for (let dy = -1; dy <= 1; dy++) {
                        for (let dx = -1; dx <= 1; dx++) {
                            if (dx === 0 && dy === 0) continue;
                            if (map[r + dy][c + dx] === 1) wallCount++;
                        }
                    }

                    if (wallCount > 4) newMap[r][c] = 1;
                    else if (wallCount < 4) newMap[r][c] = 0;
                }
            }
            map = newMap;
        }

        // 3. 테두리 강제 벽 처리
        for (let r = 0; r < rows; r++) { map[r][0] = 1; map[r][cols - 1] = 1; }
        for (let c = 0; c < cols; c++) { map[0][c] = 1; map[rows - 1][c] = 1; }

        return map;
    }
};
