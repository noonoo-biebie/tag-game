module.exports = {
    name: 'SPEEDWAY',
    allowedSizes: ['M', 'L'],
    generate: function (rows = 60, cols = 60) {
        // [컨셉] 원형 트랙 (중앙은 벽, 트랙 폭 넓게)
        // 0: 빈 공간 (트랙), 1: 벽 (잔디/관중석)
        const map = Array.from({ length: rows }, () => Array(cols).fill(1));

        const centerX = cols / 2;
        const centerY = rows / 2;
        const outerRadius = Math.min(rows, cols) / 2 - 3; // 테두리 여유
        const innerRadius = outerRadius - 8; // 트랙 폭 8칸

        for (let r = 0; r < rows; r++) {
            for (let c = 0; c < cols; c++) {
                // 타원 방정식 (혹은 원)
                const dist = Math.sqrt(Math.pow(r - centerY, 2) + Math.pow(c - centerX, 2));

                if (dist <= outerRadius && dist >= innerRadius) {
                    map[r][c] = 0; // 트랙
                } else if (dist < innerRadius - 5 && Math.random() < 0.02) {
                    // 중앙 잔디밭에 드문드문 구멍 (숨을 곳 조금)
                    // 기본적으론 1(벽)이지만, 중앙을 뚫어줄 수도 있음. 
                    // 여기선 중앙은 벽(1)으로 두어 '트랙' 느낌 강조하되, 
                    // 아주 가끔 피트스탑처럼 뚫어줌
                    map[r][c] = 1;
                }
            }
        }

        // 피트 스탑 (중앙 관통로) - 빈 공간(0)이 메인, 가끔 진흙(2)
        for (let c = centerX - 2; c <= centerX + 2; c++) {
            for (let r = centerY - innerRadius; r <= centerY + innerRadius; r++) {
                // 기존: 80% Mud, 20% Wall
                // 변경: 80% Empty, 20% Mud
                if (Math.random() < 0.8) {
                    map[Math.floor(r)][Math.floor(c)] = 0; // Empty
                } else {
                    map[Math.floor(r)][Math.floor(c)] = 2; // Mud
                }
            }
        }

        // 테두리 확실히 막기
        for (let r = 0; r < rows; r++) {
            map[r][0] = 1; map[r][cols - 1] = 1;
        }
        for (let c = 0; c < cols; c++) {
            map[0][c] = 1; map[rows - 1][c] = 1;
        }

        return map;
    }
};
