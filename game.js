const socket = io();

// HTML 요소
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const errorLog = document.getElementById('error-log');
const statusIndicator = document.getElementById('status-indicator');
const gameMessage = document.getElementById('game-message');

const loginScreen = document.getElementById('login-screen');
const gameContainer = document.getElementById('game-container');
const nicknameInput = document.getElementById('nickname-input');
const colorInput = document.getElementById('color-input');
const startBtn = document.getElementById('start-btn');

// 채팅 요소
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

// 게임 상태 변수
let isJoined = false;
let players = {};
let taggerId = null;

// --- 로그인(입장) 로직 ---

startBtn.addEventListener('click', () => {
    let nickname = nicknameInput.value.trim();
    if (!nickname) {
        // 닉네임 안 쓰면 랜덤 생성 (테스트 편의성)
        nickname = 'Player' + Math.floor(Math.random() * 1000);
    }
    socket.emit('joinGame', { nickname: nickname, color: colorInput.value });
});

// 채팅 전송 로직
chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg) {
            socket.emit('chatMessage', msg);
            chatInput.value = '';
        }
    }
});

// 서버가 입장을 허락하면 화면 전환
socket.on('joinSuccess', (myInfo) => {
    isJoined = true;
    loginScreen.style.display = 'none';
    gameContainer.style.display = 'block';

    // 포커스를 캔버스나 바디로 돌려서 키 입력을 바로 받을 수 있게 함
    document.body.focus();
});

// --- 소켓 이벤트 핸들링 ---

socket.on('currentPlayers', (serverPlayers) => {
    players = serverPlayers;
    if (isJoined) update();
});

socket.on('updateTagger', (id) => {
    taggerId = id;
    if (isJoined) update();
});

socket.on('playerMoved', (playerInfo) => {
    // 내 캐릭터의 서버 위치 수신은 무시 (클라이언트 예측 이동 우선)
    if (playerInfo.playerId === socket.id) return;

    players[playerInfo.playerId] = playerInfo;
    if (isJoined) update();
});

socket.on('newPlayer', (playerInfo) => {
    players[playerInfo.playerId] = playerInfo;
    if (isJoined) update();
});

socket.on('disconnectPlayer', (playerId) => {
    delete players[playerId];
    if (isJoined) update();
});

socket.on('gameMessage', (msg) => {
    if (!isJoined) return;
    gameMessage.innerText = msg;
    setTimeout(() => {
        gameMessage.innerText = '달리고 잡기 v0.4';
    }, 5000);
});

socket.on('chatMessage', (data) => {
    if (!isJoined) return;
    const div = document.createElement('div');
    // 내 메시지는 노란색, 남 메시지는 흰색?
    const color = (data.playerId === socket.id) ? '#f1c40f' : '#ecf0f1';
    div.innerHTML = `<span style="color:${color}; font-weight:bold;">${data.nickname}:</span> ${data.message}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight; // 스크롤 맨 아래로
});

socket.on('tagOccurred', () => {
    if (!isJoined) return;
    document.body.style.backgroundColor = '#c0392b';
    setTimeout(() => {
        document.body.style.backgroundColor = '#2c3e50';
    }, 200);
});

socket.on('connect', () => {
    updateStatus(true);
    errorLog.style.display = 'none';
    errorLog.innerHTML = '';
});

socket.on('disconnect', () => {
    updateStatus(false);
    // 연결 끊기면 다시 로그인 화면으로? 아니면 재접속 대기?
    // 일단은 유지
});

socket.on('connect_error', (err) => {
    showError(`Connection Error: ${err.message}`);
    updateStatus(false);
});


// --- 렌더링 및 게임 로직 ---

const TILE_SIZE = 32;
const ROWS = 15;
const COLS = 20;

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

function drawMap() {
    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (map[r][c] === 1) {
                ctx.fillStyle = '#95a5a6';
                ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
            } else {
                ctx.fillStyle = '#34495e';
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

        // 술래 테두리
        if (id === taggerId) {
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 4;
            ctx.strokeRect(p.x, p.y, TILE_SIZE, TILE_SIZE);

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.fillText('술래', p.x + 4, p.y - 6);
        }

        // 닉네임 표시
        ctx.fillStyle = '#fff';
        ctx.font = '12px "Noto Sans KR", sans-serif';
        ctx.textAlign = 'center';
        // 닉네임은 캐릭터 아래에? 위에? 
        // 술래 텍스트랑 겹칠 수 있으니 일반적으론 위. 술래일 땐 술래 텍스트 위로.
        const nicknameY = (id === taggerId) ? p.y - 20 : p.y - 6;
        ctx.fillText(p.nickname, p.x + TILE_SIZE / 2, nicknameY);
        ctx.textAlign = 'start'; // 복구

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

    if (col < 0 || col >= COLS || row < 0 || row >= ROWS) return false;
    return map[row][col] === 0;
}

// 이동 속도 (픽셀 단위)
// 기존 4px/frame -> 60fps 기준 약 240px/sec
const MOVE_SPEED_PER_SEC = 240;

// 키 상태 관리
const keys = {};

// 키 상태 초기화 (자율주행 방지)
function resetInput() {
    for (let key in keys) {
        keys[key] = false;
    }
}

// 탭이 가려지거나 포커스를 잃으면 키 입력 취소
document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetInput();
});
window.addEventListener('blur', resetInput);

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    keys[e.key.toLowerCase()] = true;
});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

// AABB 충돌 처리 (직사각형 벽 충돌 확인)
function checkWallCollision(newX, newY) {
    // 캐릭터 크기를 32x32보다 약간 작게 잡아서(여유 2px) 끼임 방지 및 좁은 길 통과 용이하게
    const padding = 4;
    const box = {
        left: newX + padding,
        right: newX + TILE_SIZE - padding,
        top: newY + padding,
        bottom: newY + TILE_SIZE - padding
    };

    // 검사해야 할 4개의 모서리 좌표 (TopLeft, TopRight, BottomLeft, BottomRight)
    const points = [
        { x: box.left, y: box.top },
        { x: box.right, y: box.top },
        { x: box.left, y: box.bottom },
        { x: box.right, y: box.bottom }
    ];

    for (const p of points) {
        const c = Math.floor(p.x / TILE_SIZE);
        const r = Math.floor(p.y / TILE_SIZE);

        // 맵 밖으로 나가면 충돌
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
        // 벽(1)이면 충돌
        if (map[r][c] === 1) return true;
    }

    return false;
}

// 이동 처리 함수 (매 프레임 실행, deltaTime 반영)
function processInput(deltaTimeSec) {
    if (!isJoined || !players[socket.id]) return;

    let dx = 0;
    let dy = 0;

    if (keys['arrowup'] || keys['w']) dy = -1;
    if (keys['arrowdown'] || keys['s']) dy = 1;
    if (keys['arrowleft'] || keys['a']) dx = -1;
    if (keys['arrowright'] || keys['d']) dx = 1;

    // 대각선 이동 시 속도 일정하게 보정 (Normalize)
    if (dx !== 0 && dy !== 0) {
        const length = Math.sqrt(dx * dx + dy * dy);
        dx /= length;
        dy /= length;
    }

    if (dx === 0 && dy === 0) return;

    // 이동 거리 = 속도(px/sec) * 시간(sec)
    const moveDist = MOVE_SPEED_PER_SEC * deltaTimeSec;

    const myPlayer = players[socket.id];
    let nextX = myPlayer.x + dx * moveDist;
    let nextY = myPlayer.y + dy * moveDist;

    // X축 이동 시도 및 충돌 체크
    if (!checkWallCollision(nextX, myPlayer.y)) {
        myPlayer.x = nextX;
    }
    // Y축 이동 시도 및 충돌 체크 (독립적으로 체크하여 벽 비비기 가능하게)
    if (!checkWallCollision(myPlayer.x, nextY)) {
        myPlayer.y = nextY;
    }

    // 위치 전송 (너무 자주 보내면 부하가 생길 수 있으나, 부드러운 동기화를 위해 일단 보냄)
    socket.emit('playerMove', { x: myPlayer.x, y: myPlayer.y });
}

let lastTime = 0;

function update(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const deltaTime = timestamp - lastTime;
    lastTime = timestamp;

    // 탭 비활성 등으로 인해 시간이 너무 많이 흐른 경우(0.1초 이상), 
    // 그냥 0.1초(100ms)만큼만 흐른 것으로 간주하여 텔레포트 방지
    const validDelta = Math.min(deltaTime, 100);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 입력 처리 (초 단위로 변환해서 전달)
    processInput(validDelta / 1000);

    drawMap();
    drawPlayers();

    requestAnimationFrame(update);
}

// 루프 시작
requestAnimationFrame(update);


// --- 모바일 컨트롤 로직 ---

const btnUp = document.getElementById('btn-up');
const btnDown = document.getElementById('btn-down');
const btnLeft = document.getElementById('btn-left');
const btnRight = document.getElementById('btn-right');

function handleMobileInput(key, isPressed) {
    if (!isJoined) return;
    keys[key] = isPressed;
}

function addMobileListeners(btn, key) {
    if (!btn) return;

    // 터치 이벤트 (모바일)
    btn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        handleMobileInput(key, true);
    });
    btn.addEventListener('touchend', (e) => {
        e.preventDefault();
        handleMobileInput(key, false);
    });

    // 마우스 이벤트 (PC 테스트용)
    btn.addEventListener('mousedown', (e) => {
        e.preventDefault();
        handleMobileInput(key, true);
    });
    btn.addEventListener('mouseup', (e) => {
        e.preventDefault();
        handleMobileInput(key, false);
    });
    btn.addEventListener('mouseleave', (e) => {
        handleMobileInput(key, false);
    });
}

addMobileListeners(btnUp, 'arrowup');
addMobileListeners(btnDown, 'arrowdown');
addMobileListeners(btnLeft, 'arrowleft');
addMobileListeners(btnRight, 'arrowright');


function showError(msg) {
    errorLog.style.display = 'block';
    errorLog.innerHTML += `<div>[Error] ${msg}</div>`;
    errorLog.scrollTop = errorLog.scrollHeight;
    console.error(msg);
}

function updateStatus(isConnected) {
    if (isConnected) {
        statusIndicator.style.backgroundColor = '#2ecc71';
        statusIndicator.style.boxShadow = '0 0 10px #2ecc71';
    } else {
        statusIndicator.style.backgroundColor = '#e74c3c';
        statusIndicator.style.boxShadow = '0 0 10px #e74c3c';
    }
}
