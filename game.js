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
    const nickname = nicknameInput.value.trim();
    if (!nickname) {
        alert('닉네임을 입력해주세요!');
        return;
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

// 이동 딜레이
let lastMoveTime = 0;
const MOVE_DELAY = 100; // 0.1초 (적당한 속도)

// 키 상태 관리
const keys = {};

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;
    keys[e.key.toLowerCase()] = true;
});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

// 이동 처리 함수 (매 프레임 실행)
function processInput() {
    if (!isJoined || !players[socket.id]) return;

    const now = Date.now();
    if (now - lastMoveTime < MOVE_DELAY) return;

    let dx = 0;
    let dy = 0;

    if (keys['arrowup'] || keys['w']) dy = -1;
    else if (keys['arrowdown'] || keys['s']) dy = 1;
    else if (keys['arrowleft'] || keys['a']) dx = -1;
    else if (keys['arrowright'] || keys['d']) dx = 1;

    // 이동 입력이 없으면 리턴
    if (dx === 0 && dy === 0) return;

    const myPlayer = players[socket.id];
    const nextX = myPlayer.x + dx * TILE_SIZE;
    const nextY = myPlayer.y + dy * TILE_SIZE;

    if (isWalkable(nextX, nextY)) {
        players[socket.id].x = nextX;
        players[socket.id].y = nextY;
        lastMoveTime = now;

        // 이동했으므로 update 통해 즉시 렌더링 할 수 있지만,
        // 어차피 requestAnimationFrame 루프가 돌고 있으므로 데이터만 바꾸면 됩니다.
        // 다만 부드러움을 위해 여기서 emit은 해야 합니다.
        socket.emit('playerMove', { x: nextX, y: nextY });
    }
}

function update() {
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 입력 처리
    processInput();

    drawMap();
    drawPlayers();

    requestAnimationFrame(update);
}

// 초기 호출 (소켓 이벤트나 다른 곳에서 update 호출하던 것을 requestAnimationFrame 루프로 통합했으므로 중복 호출 주의)
// 소켓 이벤트에서는 데이터만 업데이트하고, 렌더링은 이 루프가 전담하게 변경하는 것이 좋습니다.
// 하지만 기존 구조를 최소한으로 건드리면서 적용하기 위해 아래와 같이 합니다.

// 기존 update 호출 제거하고 루프 시작
update();


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
        e.preventDefault(); // 스크롤 등 기본 동작 방지
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
