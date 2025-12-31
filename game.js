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

const guideBtn = document.getElementById('guide-btn');
const guideModal = document.getElementById('guide-modal');
const guideClose = document.getElementById('guide-close');

guideBtn.addEventListener('click', () => {
    guideModal.style.display = 'block';
});

guideClose.addEventListener('click', () => {
    guideModal.style.display = 'none';
});

// 외부 클릭 시 모달 닫기
window.addEventListener('click', (e) => {
    if (e.target == guideModal) {
        guideModal.style.display = 'none';
    }
    if (e.target == feedbackModal) {
        feedbackModal.style.display = 'none';
    }
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

let showShadows = true; // [개발자 치트] 그림자 토글 변수

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
            // [개발자 치트] 그림자 토글
            if (msg === '/fog') {
                showShadows = !showShadows;
                const status = showShadows ? 'ON' : 'OFF';

                // 로컬 메시지
                const div = document.createElement('div');
                div.innerHTML = `<span style="color:#e74c3c; font-weight:bold;">System:</span> 전장의 안개 ${status}`;
                chatMessages.appendChild(div);
                chatMessages.scrollTop = chatMessages.scrollHeight;

                // [추가] 전체 알림
                const actionMsg = showShadows ? '어둠시야를 다시 켰습니다.' : '어둠시야를 밝혔습니다! (Hellfire Mode)';
                socket.emit('announceAction', actionMsg);

                chatInput.value = '';
                return;
            }

            socket.emit('chatMessage', msg);
            chatInput.value = '';
            chatInput.blur(); // 채팅 입력 후 포커스 해제 (즉시 이동 가능)
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

    let dx = 0, dy = 0;

    // 1. 조이스틱 입력 확인
    if (joystickData.active) {
        dx = joystickData.dx;
        dy = joystickData.dy;
    }
    // 2. 키보드 입력 확인
    else {
        if (keys['arrowup'] || keys['w']) dy = -1;
        else if (keys['arrowdown'] || keys['s']) dy = 1;
        else if (keys['arrowleft'] || keys['a']) dx = -1;
        else if (keys['arrowright'] || keys['d']) dx = 1;
    }

    // 3. 입력이 없으면 랜덤 방향 (이전 버그: 여기서 dx=0, dy=0이면 아무것도 안 하거나 이상해짐)
    if (dx === 0 && dy === 0) {
        const dirs = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
        const rand = dirs[Math.floor(Math.random() * dirs.length)];
        dx = rand.x; dy = rand.y;
    }

    // 정규화
    if (dx !== 0 || dy !== 0) {
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

socket.on('tagOccurred', (data) => {
    if (!isJoined) return;

    // 1. 화면 흔들림 효과
    gameContainer.classList.add('shake-effect');
    setTimeout(() => {
        gameContainer.classList.remove('shake-effect');
    }, 500);

    // 2. 기절 처리 (내가 새 술래라면)
    if (data.newTaggerId === socket.id) {
        isStunned = true;
        setTimeout(() => {
            isStunned = false;
        }, 2000);
    }

    // 3. 텍스트 오버레이 표시
    const overlay = document.getElementById('tagged-overlay');
    if (overlay) {
        overlay.style.display = 'block';
        if (data.newTaggerId === socket.id) {
            overlay.innerText = "술래 당첨!\n(2초 기절)";
        } else {
            overlay.innerText = "술래 체인지!";
        }
        setTimeout(() => {
            overlay.style.display = 'none';
        }, 2000);
    }
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

        ctx.fillStyle = (id === taggerId) ? '#e74c3c' : '#fff';
        ctx.font = (id === taggerId) ? 'bold 14px "Noto Sans KR", sans-serif' : '12px "Noto Sans KR", sans-serif';
        ctx.textAlign = 'center';
        const nicknameY = (id === taggerId) ? p.y - 22 : p.y - 6;
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
let isStunned = false; // [추가] 기절 상태

function processInput(deltaTimeSec) {
    if (!isJoined || !players[socket.id]) return;
    if (isStunned) return; // [추가] 기절 시 조작 불가

    let dx = 0; let dy = 0;

    if (isSlipped) {
        // 미끄러지는 중: 키 입력 무시, 강제 이동
        dx = slipVelocity.x;
        dy = slipVelocity.y;
    } else if (joystickData.active) {
        // 조이스틱 입력 우선
        dx = joystickData.dx;
        dy = joystickData.dy;
        // 조이스틱은 이미 정규화된 벡터(vector.x, vector.y)를 주거나 force에 따라 다를 수 있음.
        // nipple.js vector is normalized unit vector direction.
        // We can multiply speed by force if we want analog speed control, 
        // but for now let's keep it max speed for simplicity, or simple threshold.
    } else {
        // 키보드/정상 상태
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
    drawShadows();   // 그림자(시야 제한) 효과
    drawInventory(); // 인벤토리 그리기

    requestAnimationFrame(update);
}

// 그림자(시야 제한) 효과 - Even-Odd Rule 적용
function drawShadows() {
    if (!isJoined || !players[socket.id]) return;
    if (!showShadows) return; // 개발자 명령어로 꺼짐 확인

    const p = players[socket.id];
    const cx = p.x + TILE_SIZE / 2;
    const cy = p.y + TILE_SIZE / 2;

    const points = [];

    // 1. Raycasting (그림자 다각형 생성용) - 정밀도 향상
    // 각도 간격을 0.05 -> 0.015로 촘촘하게 (부드러운 경계)
    for (let angle = 0; angle < Math.PI * 2; angle += 0.015) {
        const result = castRay(cx, cy, angle);
        points.push(result);
    }
    points.push(castRay(cx, cy, 0));

    ctx.save();

    // 2. 그림자 마스크 그리기
    ctx.beginPath();
    ctx.rect(0, 0, canvas.width, canvas.height); // 전체 화면

    ctx.moveTo(points[0].x, points[0].y);
    for (let i = 1; i < points.length; i++) {
        ctx.lineTo(points[i].x, points[i].y);
    }
    ctx.closePath();

    // 외부는 어둡게,내부는 투명하게 (도넛) -> 둥근 모서리 처리
    ctx.lineJoin = 'round';
    ctx.fillStyle = 'rgba(0, 0, 0, 0.95)';
    ctx.fill('evenodd');

    // 3. "모든 벽" 덧칠하기 (사용자 요청: 벽은 무조건 보이게)
    ctx.fillStyle = '#7f8c8d'; // 벽 색상
    ctx.strokeStyle = '#555';  // 벽 테두리
    ctx.lineWidth = 1;

    for (let r = 0; r < ROWS; r++) {
        for (let c = 0; c < COLS; c++) {
            if (map[r][c] === 1) { // 벽이라면 무조건 그림
                const x = c * TILE_SIZE;
                const y = r * TILE_SIZE;

                // 그림자 위에 덮어쓰기
                ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
                ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
            }
        }
    }

    ctx.restore();
}

function castRay(x, y, angle) {
    const dx = Math.cos(angle);
    const dy = Math.sin(angle);

    let curX = x;
    let curY = y;

    const range = 1000;
    const step = 2; // [정밀도 향상] 8 -> 2 (벽 모서리 인식 개선)

    for (let i = 0; i < range; i += step) {
        curX += dx * step;
        curY += dy * step;

        const c = Math.floor(curX / TILE_SIZE);
        const r = Math.floor(curY / TILE_SIZE);

        if (c < 0 || c >= COLS || r < 0 || r >= ROWS) {
            return { x: curX, y: curY };
        }

        if (map[r][c] === 1) {
            return { x: curX, y: curY };
        }
    }
    return { x: curX, y: curY };
}


// --- 모바일 및 UI 유틸 ---

// 아이템 버튼
const mobileItemBtn = document.getElementById('mobile-item-btn');
if (mobileItemBtn) {
    mobileItemBtn.addEventListener('touchstart', (e) => {
        e.preventDefault();
        socket.emit('useItem');
        mobileItemBtn.style.transform = 'scale(0.9)';
    });
    mobileItemBtn.addEventListener('touchend', (e) => {
        e.preventDefault();
        mobileItemBtn.style.transform = 'scale(1)';
    });
}

// 조이스틱 (nipple.js)
let joystickManager = null;
let joystickData = { angle: 0, force: 0, active: false };

// 조이스틱 초기화 함수
function initJoystick() {
    const zone = document.getElementById('joystick-zone');
    if (!zone) return;

    // 이미 생성되었으면 스킵
    if (joystickManager) return;

    joystickManager = nipplejs.create({
        zone: zone,
        mode: 'dynamic', // 터치하는 곳에 생성 (가장 직관적)
        color: 'white',
        size: 100,
        threshold: 0.1 // 너무 민감하지 않게
    });

    joystickManager.on('move', (evt, data) => {
        if (data && data.vector) {
            joystickData.active = true;
            // nipple.js vector: {x, y} unit vector.
            // 보통 Up은 y=1 (수학적), Canvas는 Up= y=-1.
            // 따라서 y를 반전시켜야 함.
            joystickData.dx = data.vector.x;
            joystickData.dy = -data.vector.y;
            joystickData.force = Math.min(data.force, 2.0);
        }
    });

    joystickManager.on('end', () => {
        joystickData.active = false;
        joystickData.dx = 0;
        joystickData.dy = 0;
    });
}

// 모바일 접속 시 조이스틱 초기화 (터치 이벤트 발생 시 시도)
document.addEventListener('touchstart', initJoystick, { once: true });
// 혹은 로드 시 바로 시도 (zone이 있으므로)
setTimeout(initJoystick, 1000);

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
        statusIndicator.style.boxShadow = '0 0 10px #e74c3c';
    }
}

// 채팅 단축키 (/)
window.addEventListener('keydown', (e) => {
    // 채팅창이 아닌 곳에서 / 키를 누르면 채팅창으로 포커스
    if (e.key === '/' && document.activeElement !== chatInput) {
        e.preventDefault(); // / 문자 입력 방지
        chatInput.focus();
    }
});
