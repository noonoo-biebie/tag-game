module.exports = {
    name: 'STADIUM',
    allowedSizes: ['S', 'M'],
    data: (function () {
        const rows = 30; // 조금 작게
        const cols = 50;
        const map = Array.from({ length: rows }, () => Array(cols).fill(3)); // 기본 바닥: 얼음(3)

        // 1. 테두리 (관중석)
        for (let r = 0; r < rows; r++) {
            map[r][0] = 1; map[r][cols - 1] = 1;
        }
        for (let c = 0; c < cols; c++) {
            map[0][c] = 1; map[rows - 1][c] = 1;
        }

        // 2. 장애물 (구조물)
        // 중앙 로고/구조물
        for (let r = 12; r <= 17; r++) {
            for (let c = 22; c <= 27; c++) {
                map[r][c] = 1;
            }
        }
        // 중앙 통로
        map[14][24] = 0; map[14][25] = 0;
        map[15][24] = 0; map[15][25] = 0;

        // 코너 장애물
        map[5][5] = 1; map[5][6] = 1; map[6][5] = 1;
        map[5][44] = 1; map[5][43] = 1; map[6][44] = 1;
        map[24][5] = 1; map[24][6] = 1; map[23][5] = 1;
        map[24][44] = 1; map[24][43] = 1; map[23][44] = 1;

        return map;
    })()
};
