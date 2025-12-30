const socket = io();

// HTML 요소 가져오기
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const errorLog = document.getElementById('error-log');
const statusIndicator = document.getElementById('status-indicator');

// --- 에러 및 상태 표시 로직 ---

function showError(msg) {
    errorLog.style.display = 'block';
    errorLog.innerHTML += `<div>[Error] ${msg}</div>`;
    // 스크롤을 맨 아래로 이동
    errorLog.scrollTop = errorLog.scrollHeight;
    console.error(msg);
}

function updateStatus(isConnected) {
    if (isConnected) {
        statusIndicator.style.backgroundColor = '#2ecc71'; // 연결됨 (초록)
        statusIndicator.style.boxShadow = '0 0 10px #2ecc71';
    } else {
        statusIndicator.style.backgroundColor = '#e74c3c'; // 끊김 (빨강)
        statusIndicator.style.boxShadow = '0 0 10px #e74c3c';
    }
}

// 전역 에러 핸들링
window.onerror = function (message, source, lineno, colno, error) {
    showError(`${message} at line ${lineno}`);
};

// 소켓 이벤트 핸들링 (연결 상태)
socket.on('connect', () => {
    updateStatus(true);
    errorLog.style.display = 'none';
    errorLog.innerHTML = '';
});

socket.on('disconnect', () => {
    updateStatus(false);
});

socket.on('connect_error', (err) => {
    showError(`Connection Error: ${err.message}`);
    updateStatus(false);
});

// --- 게임 로직 ---

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

// 접속한 모든 플레이어 정보
let players = {};

// 서버로부터 전체 플레이어 목록 수신
socket.on('currentPlayers', (serverPlayers) => {
    players = serverPlayers;
    update();
});

// 새 플레이어 접속 또는 이동 정보 수신
socket.on('playerMoved', (playerInfo) => {
    players[playerInfo.playerId] = playerInfo;
    update();
});

socket.on('newPlayer', (playerInfo) => {
    players[playerInfo.playerId] = playerInfo;
    update();
});

// 플레이어 접속 해제
socket.on('disconnectPlayer', (playerId) => {
    delete players[playerId];
    update();
});

function drawMap() {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (map[r][c] === 1) {
                ctx.fillStyle = '#95a5a6'; // 벽
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            } else {
                ctx.fillStyle = '#34495e'; // 바닥
                // ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            }
        }
    }
}

function drawPlayers() {
    Object.keys(players).forEach((id) => {
        const p = players[id];
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, TILE_SIZE, TILE_SIZE);

        // 내 캐릭터 강조
        if (id === socket.id) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.strokeRect(p.x, p.y, TILE_SIZE, TILE_SIZE);
        }
    });
}

function update() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    drawMap();
    drawPlayers();
}

function isWalkable(x, y) {
    const col = Math.floor(x / TILE_SIZE);
    const row = Math.floor(y / TILE_SIZE);

    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) {
        return false;
    }
    return map[row][col] === 0;
}

window.addEventListener('keydown', (e) => {
    if (!players[socket.id]) return; // 내 정보 없으면 무시

    const myPlayer = players[socket.id];
    const speed = TILE_SIZE;
    let nextX = myPlayer.x;
    let nextY = myPlayer.y;

    if (e.key === 'ArrowUp') nextY -= speed;
    else if (e.key === 'ArrowDown') nextY += speed;
    else if (e.key === 'ArrowLeft') nextX -= speed;
    else if (e.key === 'ArrowRight') nextX += speed;

    if (isWalkable(nextX, nextY)) {
        // 즉시 반영
        players[socket.id].x = nextX;
        players[socket.id].y = nextY;
        update();

        // 서버 전송
        socket.emit('playerMove', { x: nextX, y: nextY });
    }
});
