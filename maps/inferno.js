module.exports = {
    name: 'INFERNO',
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 인페르노 (용암 미로) - 소형 (20x16) - MAZE 맵 사이즈 참조
        // 4: 용암(벽), 0: 길
        // MAZE가 가로 20, 세로 약 16 정도임 (이미지 비율 및 데이터 참조)
        const fixedCols = 20;
        const fixedRows = 16;

        const map = Array.from({ length: fixedRows }, () => Array(fixedCols).fill(4)); // 전체 용암

        // 미로 생성 (Recursive Backtracker)
        const stack = [];
        const startX = 1;
        const startY = 1;

        map[startY][startX] = 0;
        stack.push({ x: startX, y: startY });

        const dirs = [
            { x: 0, y: -2 }, { x: 0, y: 2 }, { x: -2, y: 0 }, { x: 2, y: 0 }
        ];

        while (stack.length > 0) {
            const current = stack[stack.length - 1];
            // 셔플
            dirs.sort(() => Math.random() - 0.5);

            let found = false;
            for (const d of dirs) {
                const nx = current.x + d.x;
                const ny = current.y + d.y;

                if (nx > 0 && nx < fixedCols - 1 && ny > 0 && ny < fixedRows - 1) {
                    if (map[ny][nx] === 4) { // 안 간 곳
                        map[current.y + d.y / 2][current.x + d.x / 2] = 0; // 벽 뚫기
                        map[ny][nx] = 0; // 이동
                        stack.push({ x: nx, y: ny });
                        found = true;
                        break;
                    }
                }
            }
            if (!found) stack.pop();
        }

        // 테두리 마감 (이중 안전)
        for (let r = 0; r < fixedRows; r++) { map[r][0] = 4; map[r][fixedCols - 1] = 4; }
        for (let c = 0; c < fixedCols; c++) { map[0][c] = 4; map[fixedRows - 1][c] = 4; }

        return map;
    }
};
