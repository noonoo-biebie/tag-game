const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');

const TILE_SIZE = 32;
const ROWS = 15; // 480 / 32
const COLS = 20; // 640 / 32

// 0: 바닥, 1: 벽
const map = [
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 0, 1, 0, 0, 0, 0, 0, 0, 1, 0, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 1, 0, 0, 1, 1, 0, 0, 1, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 1],
    [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]
];

const player = {
    x: 2 * TILE_SIZE,
    y: 2 * TILE_SIZE,
    color: '#e74c3c', // 빨간색
    speed: TILE_SIZE // 한 번에 한 칸씩 이동
};

function drawMap() {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (map[r][c] === 1) {
                ctx.fillStyle = '#95a5a6'; // 벽 색상
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            } else {
                ctx.fillStyle = '#34495e'; // 바닥 색상 (배경이랑 같게 하거나 약간 다르게)
                // ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
        }
    }
}

function drawPlayer() {
    ctx.fillStyle = player.color;
    ctx.fillRect(player.x, player.y, TILE_SIZE, TILE_SIZE);
}

function update() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMap();
    drawPlayer();
    requestAnimationFrame(update);
}

function isWalkable(x, y) {
    const col = x / TILE_SIZE;
    const row = y / TILE_SIZE;
    
    // 맵 범위 체크
    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
        return false;
    }
    
    // 벽 체크 (1이면 벽)
    return map[row][col] === 0;
}

window.addEventListener('keydown', (e) => {
    let nextX = player.x;
    let nextY = player.y;

    if (e.key === 'ArrowUp') {
        nextY -= player.speed;
    } else if (e.key === 'ArrowDown') {
        nextY += player.speed;
    } else if (e.key === 'ArrowLeft') {
        nextX -= player.speed;
    } else if (e.key === 'ArrowRight') {
        nextX += player.speed;
    }

    if (isWalkable(nextX, nextY)) {
        player.x = nextX;
        player.y = nextY;
    }
});

update();
