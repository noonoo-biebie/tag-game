module.exports = {
    name: 'FOREST',
    allowedSizes: ['M', 'L'],
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 뻥 뚫려있지만 나무(장애물)가 불규칙하게 많은 맵
        const map = Array.from({ length: rows }, () => Array(cols).fill(0));

        // 1. 테두리
        for (let r = 0; r < rows; r++) {
            map[r][0] = 1; map[r][cols - 1] = 1;
        }
        for (let c = 0; c < cols; c++) {
            map[0][c] = 1; map[rows - 1][c] = 1;
        }

        // 2. 나무 심기 (Perlin Noise 대신 Random Scatter)
        // 뭉쳐있는 숲 느낌을 내기 위해 '씨앗' 뿌리기
        const seeds = 40;
        for (let i = 0; i < seeds; i++) {
            const sr = Math.floor(Math.random() * (rows - 4)) + 2;
            const sc = Math.floor(Math.random() * (cols - 4)) + 2;

            const radius = Math.floor(Math.random() * 4) + 2; // 2~5 크기 덤불

            for (let r = sr - radius; r <= sr + radius; r++) {
                for (let c = sc - radius; c <= sc + radius; c++) {
                    if (r > 1 && r < rows - 2 && c > 1 && c < cols - 2) {
                        // 원형 덤불
                        if (Math.sqrt((r - sr) ** 2 + (c - sc) ** 2) <= radius) {
                            if (Math.random() < 0.7) map[r][c] = 1; // 70% 밀도
                        }
                    }
                }
            }
        }

        // 3. 낱개 나무
        for (let r = 2; r < rows - 2; r++) {
            for (let c = 2; c < cols - 2; c++) {
                if (Math.random() < 0.05) map[r][c] = 1;
            }
        }

        return map;
    }
};
