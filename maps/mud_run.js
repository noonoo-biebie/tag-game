module.exports = {
    name: 'MUD_RUN',
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 진흙탕 달리기 (자연스러운 웅덩이)
        // 0: 흙길, 1: 숲(벽), 2: 진흙 웅덩이
        const map = Array.from({ length: rows }, () => Array(cols).fill(1)); // 기본 숲

        // 1. 메인 트랙 생성 (Random Walker로 넓은 길 뚫기)
        let x = Math.floor(cols / 2);
        let y = Math.floor(rows / 2);
        const steps = rows * cols * 3; // 충분히 길게

        for (let i = 0; i < steps; i++) {
            // 길 넓이 (3x3 ~ 4x4)
            const brushSize = 2; // radius
            for (let dy = -brushSize; dy <= brushSize; dy++) {
                for (let dx = -brushSize; dx <= brushSize; dx++) {
                    const ny = y + dy;
                    const nx = x + dx;
                    if (ny > 1 && ny < rows - 2 && nx > 1 && nx < cols - 2) {
                        map[ny][nx] = 0; // 흙길
                    }
                }
            }

            // 랜덤 이동 (관성 적용하여 부드럽게)
            x += Math.floor(Math.random() * 3) - 1;
            y += Math.floor(Math.random() * 3) - 1;

            // 맵 이탈 방지
            if (x < 3) x = 3; if (x > cols - 4) x = cols - 4;
            if (y < 3) y = 3; if (y > rows - 4) y = rows - 4;
        }

        // 2. 진흙 웅덩이 생성 (Organic Blobs)
        // 랜덤한 위치에 진흙 씨앗을 뿌리고 주변으로 퍼뜨림
        const numPuddles = 40;
        for (let i = 0; i < numPuddles; i++) {
            let px = Math.floor(Math.random() * (cols - 4)) + 2;
            let py = Math.floor(Math.random() * (rows - 4)) + 2;

            // 흙길 위에만 생성 시도 (숲 속에 숨겨진 늪보다는 길 위의 방해물)
            if (map[py][px] === 0) {
                const size = Math.floor(Math.random() * 4) + 2; // 2~5 반지름
                for (let r = py - size; r <= py + size; r++) {
                    for (let c = px - size; c <= px + size; c++) {
                        if (r > 1 && r < rows - 2 && c > 1 && c < cols - 2) {
                            if (map[r][c] === 0 && Math.hypot(r - py, c - px) <= size) {
                                // 80% 확률로 진흙 채우기 (가장자리 거칠게)
                                if (Math.random() < 0.8) map[r][c] = 2;
                            }
                        }
                    }
                }
            }
        }

        // 3. 테두리 마감
        for (let r = 0; r < rows; r++) { map[r][0] = 1; map[r][cols - 1] = 1; }
        for (let c = 0; c < cols; c++) { map[0][c] = 1; map[rows - 1][c] = 1; }

        return map;
    }
};
