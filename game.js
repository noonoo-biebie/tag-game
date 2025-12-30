const socket = io({
    transports: ['websocket', 'polling']
});

// HTML 요소
const canvas = document.getElementById('gameCanvas');
const ctx = canvas.getContext('2d');
const errorLog = document.getElementById('error-log');
const statusIndicator = document.getElementById('status-indicator');
const gameMessage = document.getElementById('game-message');

const loginScreen = document.getElementById('login-screen');
const gameContainer = document.getElementById('game-container'); // 복구됨
const nicknameInput = document.getElementById('nickname-input');
const colorInput = document.getElementById('color-input');
const startBtn = document.getElementById('start-btn');
const loadingOverlay = document.getElementById('server-loading-overlay'); // 추가

// 채팅 요소
const chatInput = document.getElementById('chat-input');
const chatMessages = document.getElementById('chat-messages');

// 게임 상태 변수
let isJoined = false;
let players = {};
let items = {};
let myItem = null;
let taggerId = null;

// 속도 관련 변수
const BASE_SPEED = 240;
let speedMultiplier = 1.0;

// 트랩 및 상태 변수
let traps = {};
let isSlipped = false;
let slipVelocity = { x: 0, y: 0 };

// 피드백 UI 로직
const feedbackBtn = document.getElementById('feedback-btn');
const feedbackModal = document.getElementById('feedback-modal');
const feedbackInput = document.getElementById('feedback-input');
const feedbackSend = document.getElementById('feedback-send');
const feedbackCancel = document.getElementById('feedback-cancel');

feedbackBtn.addEventListener('click', () => {
    feedbackModal.style.display = 'flex';
    feedbackInput.focus();
});

feedbackCancel.addEventListener('click', () => {
    feedbackModal.style.display = 'none';
    feedbackInput.value = '';
});

feedbackSend.addEventListener('click', () => {
    const msg = feedbackInput.value.trim();
    if (msg) {
        socket.emit('sendFeedback', msg);
        alert('소중한 의견 감사합니다! 🙇‍♂️');
        feedbackModal.style.display = 'none';
        feedbackInput.value = '';
    }
});

// --- 로그인(입장) 로직 ---

startBtn.addEventListener('click', () => {
    let nickname = nicknameInput.value.trim();
    if (!nickname) {
        nickname = 'Player' + Math.floor(Math.random() * 1000);
    }

    // 버튼 클릭 피드백
    startBtn.disabled = true;
    startBtn.innerText = "입장 중...";

    socket.emit('joinGame', { nickname: nickname, color: colorInput.value });
});

chatInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        const msg = chatInput.value.trim();
        if (msg) {
            socket.emit('chatMessage', msg);
            chatInput.value = '';
        }
    }
});

socket.on('joinSuccess', (myInfo) => {
    isJoined = true;
    loginScreen.style.display = 'none';
    gameContainer.style.display = 'block';
    document.body.focus();

    if (!loopRunning) {
        loopRunning = true;
        requestAnimationFrame(update);
    }
});

// --- 소켓 이벤트 핸들링 ---

socket.on('currentPlayers', (serverPlayers) => {
    players = serverPlayers;
    Object.keys(players).forEach(id => {
        if (players[id].targetX === undefined) {
            players[id].targetX = players[id].x;
            players[id].targetY = players[id].y;
        }
    });
});

socket.on('updateTagger', (id) => {
    taggerId = id;
});

socket.on('playerMoved', (playerInfo) => {
    if (playerInfo.playerId === socket.id) return;

    if (!players[playerInfo.playerId]) {
        players[playerInfo.playerId] = playerInfo;
        players[playerInfo.playerId].targetX = playerInfo.x;
        players[playerInfo.playerId].targetY = playerInfo.y;
    } else {
        players[playerInfo.playerId].targetX = playerInfo.x; // 복구됨
        players[playerInfo.playerId].targetY = playerInfo.y;
        players[playerInfo.playerId].color = playerInfo.color;
        players[playerInfo.playerId].nickname = playerInfo.nickname;
        // 시각 효과 동기화 추가
        players[playerInfo.playerId].hasShield = playerInfo.hasShield;
        players[playerInfo.playerId].isSpeeding = playerInfo.isSpeeding;
    }
});

socket.on('newPlayer', (playerInfo) => {
    players[playerInfo.playerId] = playerInfo;
    players[playerInfo.playerId].targetX = playerInfo.x;
    players[playerInfo.playerId].targetY = playerInfo.y;
});

socket.on('disconnectPlayer', (playerId) => {
    delete players[playerId];
});

// 아이템 관련 소켓
socket.on('updateItems', (serverItems) => {
    items = serverItems;
});

socket.on('updateTraps', (serverTraps) => {
    traps = serverTraps;
});

socket.on('updateInventory', (itemType) => {
    myItem = itemType;
});

socket.on('itemEffect', (data) => {
    const myPlayer = players[socket.id];
    if (!myPlayer) return;

    if (data.type === 'speed') {
        speedMultiplier = 1.5;
        myPlayer.isSpeeding = true; // 본인 시각 효과 켜기

        setTimeout(() => {
            speedMultiplier = 1.0;
            myPlayer.isSpeeding = false; // 본인 시각 효과 끄기 (타이밍 맞추기)
        }, data.duration);

    } else if (data.type === 'shield') {
        if (data.on) {
            myPlayer.hasShield = true;
        } else {
            myPlayer.hasShield = false;
        }
    }
});

socket.on('playerSlipped', (data) => {
    isSlipped = true;

    // 현재 이동 중이던 방향 유지 (없으면 랜덤?)
    // processInput에서 계산된 최근 dx, dy를 저장해두거나 여기서 임의 설정
    // 간단히: 최근 입력 키를 기반으로 방향 추정 or 랜덤
    let dx = 0, dy = 0;
    if (keys['arrowup'] || keys['w']) dy = -1;
    else if (keys['arrowdown'] || keys['s']) dy = 1;
    else if (keys['arrowleft'] || keys['a']) dx = -1;
    else if (keys['arrowright'] || keys['d']) dx = 1;

    // 정지 상태였다면 랜덤 방향으로 미끄러짐 (꿀잼 요소)
    if (dx === 0 && dy === 0) {
        const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
        const rand = dirs[Math.floor(Math.random() * dirs.length)];
        dx = rand.x; dy = rand.y;
    }

    // 정규화
    if (dx !== 0 && dy !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy);
        dx /= len; dy /= len;
    }

    slipVelocity = { x: dx, y: dy };

    setTimeout(() => {
        isSlipped = false;
        slipVelocity = { x: 0, y: 0 };
    }, data.duration);
});

socket.on('gameMessage', (msg) => {
    if (!isJoined) return;
    gameMessage.innerText = msg;
    setTimeout(() => {
        gameMessage.innerText = '달리고 잡기 v0.7';
    }, 5000);
});

socket.on('chatMessage', (data) => {
    if (!isJoined) return;
    const div = document.createElement('div');
    const color = (data.playerId === socket.id) ? '#f1c40f' : '#ecf0f1';
    div.innerHTML = `<span style="color:${color}; font-weight:bold;">${data.nickname}:</span> ${data.message}`;
    chatMessages.appendChild(div);
    chatMessages.scrollTop = chatMessages.scrollHeight;
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

    // 서버 연결 성공 시 로딩 숨기고 로그인 화면 표시 (이미 게임 중이면 패스)
    if (!isJoined) {
        loadingOverlay.style.display = 'none';
        loginScreen.style.display = 'block';
    }
});

socket.on('disconnect', () => {
    updateStatus(false);
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
            }
        }
    }
}

function drawItems() {
    ctx.font = '24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const id in items) {
        const item = items[id];
        ctx.fillText('🎁', item.x + TILE_SIZE / 2, item.y + TILE_SIZE / 2);
    }
}

function drawTraps() {
    ctx.font = '24px Arial';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (const id in traps) {
        const trap = traps[id];
        ctx.fillText('🍌', trap.x + TILE_SIZE / 2, trap.y + TILE_SIZE / 2);
    }
}

function drawPlayers() {
    Object.keys(players).forEach((id) => {
        const p = players[id];

        // 1. 스피드 효과 (노란색 오라)
        if (p.isSpeeding) {
            ctx.fillStyle = 'rgba(241, 196, 15, 0.4)';
            ctx.fillRect(p.x - 4, p.y - 4, TILE_SIZE + 8, TILE_SIZE + 8);
        }

        // 2. 쉴드 효과 (파란색 보호막 원)
        if (p.hasShield) {
            ctx.beginPath();
            ctx.arc(p.x + TILE_SIZE / 2, p.y + TILE_SIZE / 2, TILE_SIZE / 1.2, 0, Math.PI * 2);
            ctx.fillStyle = 'rgba(52, 152, 219, 0.3)';
            ctx.fill();
            ctx.lineWidth = 2;
            ctx.strokeStyle = '#3498db';
            ctx.stroke();
        }

        // 3. 플레이어 본체
        ctx.fillStyle = p.color;
        ctx.fillRect(p.x, p.y, TILE_SIZE, TILE_SIZE);

        if (id === taggerId) {
            ctx.strokeStyle = '#e74c3c';
            ctx.lineWidth = 4;
            ctx.strokeRect(p.x, p.y, TILE_SIZE, TILE_SIZE);

            ctx.fillStyle = '#fff';
            ctx.font = 'bold 12px Arial';
            ctx.fillText('술래', p.x + 4, p.y - 6);
        }

        ctx.fillStyle = '#fff';
        ctx.font = '12px "Noto Sans KR", sans-serif';
        ctx.textAlign = 'center';
        const nicknameY = (id === taggerId) ? p.y - 20 : p.y - 6;
        ctx.fillText(p.nickname, p.x + TILE_SIZE / 2, nicknameY);
        ctx.textAlign = 'start';

        if (id === socket.id) {
            ctx.strokeStyle = '#fff';
            ctx.lineWidth = 2;
            ctx.strokeRect(p.x, p.y, TILE_SIZE, TILE_SIZE);
        }
    });
}

function drawInventory() {
    if (!isJoined) return;
    const slotSize = 50;
    const x = canvas.width / 2 - slotSize / 2;
    const y = canvas.height - 60;

    // 슬롯 배경 (반투명)
    ctx.fillStyle = 'rgba(0, 0, 0, 0.5)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, slotSize, slotSize);
    ctx.strokeRect(x, y, slotSize, slotSize);

    if (myItem) {
        ctx.font = '30px Arial';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        let icon = '';
        if (myItem === 'speed') icon = '⚡';
        else if (myItem === 'banana') icon = '🍌';
        else if (myItem === 'shield') icon = '🛡️';

        ctx.fillStyle = '#fff';
        ctx.fillText(icon, x + slotSize / 2, y + slotSize / 2);

        ctx.font = '12px Arial';
        ctx.fillText('Space', x + slotSize / 2, y - 10);
    }
}

// 키 상태 관리
let keys = {};

function resetInput() {
    for (let key in keys) {
        keys[key] = false;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.hidden) resetInput();
});
window.addEventListener('blur', resetInput);

window.addEventListener('keydown', (e) => {
    if (document.activeElement.tagName === 'INPUT') return;

    if (['arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'w', 'a', 's', 'd'].includes(e.key.toLowerCase())) {
        keys[e.key.toLowerCase()] = true;
    }
    // 아이템 사용
    if (e.code === 'Space') {
        socket.emit('useItem');
    }
});

window.addEventListener('keyup', (e) => {
    keys[e.key.toLowerCase()] = false;
});

function checkWallCollision(newX, newY) {
    const padding = 4;
    const box = {
        left: newX + padding,
        right: newX + TILE_SIZE - padding,
        top: newY + padding,
        bottom: newY + TILE_SIZE - padding
    };
    const points = [
        { x: box.left, y: box.top },
        { x: box.right, y: box.top },
        { x: box.left, y: box.bottom },
        { x: box.right, y: box.bottom }
    ];

    for (const p of points) {
        const c = Math.floor(p.x / TILE_SIZE);
        const r = Math.floor(p.y / TILE_SIZE);
        if (r < 0 || r >= ROWS || c < 0 || c >= COLS) return true;
        if (map[r][c] === 1) return true;
    }
    return false;
}

let lastEmitTime = 0;

function processInput(deltaTimeSec) {
    if (!isJoined || !players[socket.id]) return;

    let dx = 0; let dy = 0;

    if (isSlipped) {
        // 미끄러지는 중: 키 입력 무시, 강제 이동
        dx = slipVelocity.x;
        dy = slipVelocity.y;
    } else {
        // 정상 상태
        if (keys['arrowup'] || keys['w']) dy = -1;
        if (keys['arrowdown'] || keys['s']) dy = 1;
        if (keys['arrowleft'] || keys['a']) dx = -1;
        if (keys['arrowright'] || keys['d']) dx = 1;

        if (dx !== 0 && dy !== 0) {
            const len = Math.sqrt(dx * dx + dy * dy);
            dx /= len; dy /= len;
        }
    }

    const myPlayer = players[socket.id];

    if (dx !== 0 || dy !== 0) {
        // 속도 아이템 적용
        let currentSpeed = BASE_SPEED * speedMultiplier;
        let remainingDist = currentSpeed * deltaTimeSec;
        const STEP_SIZE = 4;
        let hitWall = false; // 벽 충돌 여부 체크

        while (remainingDist > 0) {
            const step = Math.min(remainingDist, STEP_SIZE);
            remainingDist -= step;
            let nextX = myPlayer.x + dx * step;
            let nextY = myPlayer.y + dy * step;

            let movedX = false;
            let movedY = false;

            if (!checkWallCollision(nextX, myPlayer.y)) {
                myPlayer.x = nextX;
                movedX = true;
            }
            if (!checkWallCollision(myPlayer.x, nextY)) {
                myPlayer.y = nextY;
                movedY = true;
            }

            // 미끄러지는 상태에서 벽에 부딪히면(이동 실패하면) 즉시 정지
            if (isSlipped && (!movedX || !movedY)) {
                hitWall = true;
                break;
            }
        }

        if (isSlipped && hitWall) {
            isSlipped = false;
            slipVelocity = { x: 0, y: 0 };
            // (옵션) 효과음이나 파티클 추가 가능
        }

        myPlayer.targetX = myPlayer.x;
        myPlayer.targetY = myPlayer.y;
    }

    const now = Date.now();
    if (now - lastEmitTime > 30) {
        socket.emit('playerMove', { x: myPlayer.x, y: myPlayer.y });
        lastEmitTime = now;
    }
}

let lastTime = 0;
let loopRunning = false;

function update(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const deltaTime = timestamp - lastTime;
    lastTime = timestamp;
    const validDelta = Math.min(deltaTime, 100);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    processInput(validDelta / 1000);

    const lerpFactor = 0.2;
    Object.keys(players).forEach(id => {
        if (id !== socket.id) {
            const p = players[id];
            if (p.targetX !== undefined && p.targetY !== undefined) {
                p.x += (p.targetX - p.x) * lerpFactor;
                p.y += (p.targetY - p.y) * lerpFactor;
                if (Math.abs(p.targetX - p.x) < 0.5) p.x = p.targetX;
                if (Math.abs(p.targetY - p.y) < 0.5) p.y = p.targetY;
            }
        }
    });

    drawMap();
    drawItems();     // 아이템 그리기
    drawTraps();     // 트랩 그리기
    drawPlayers();
    drawInventory(); // 인벤토리 그리기

    requestAnimationFrame(update);
}


// --- 모바일 및 UI 유틸 ---

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
    btn.addEventListener('touchstart', (e) => { e.preventDefault(); handleMobileInput(key, true); });
    btn.addEventListener('touchend', (e) => { e.preventDefault(); handleMobileInput(key, false); });
    btn.addEventListener('mousedown', (e) => { e.preventDefault(); handleMobileInput(key, true); });
    btn.addEventListener('mouseup', (e) => { e.preventDefault(); handleMobileInput(key, false); });
    btn.addEventListener('mouseleave', (e) => { handleMobileInput(key, false); });
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
