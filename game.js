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

// [추가] 고급 명령어 자동완성 및 가이드
const COMMAND_DATA = {
    '/reset': { desc: '🔄 게임 리셋', args: [] },
    '/mode': { desc: '🎮 모드 변경', args: ['zombie', 'tag'] },
    '/map': { desc: '🗺️ 맵 변경', args: ['DEFAULT', 'MAZE', 'OPEN', 'BACKROOMS'] },
    '/bot': { desc: '🤖 봇 소환', args: [] },
    '/kickbot': { desc: '👋 봇 전체 추방', args: [] },
    '/help': { desc: '❓ 도움말', args: [] },
    '/fog': { desc: '🌫️ 시야 토글', args: [] },
    '/item': { desc: '⚡ 치트 아이템', args: ['speed', 'banana', 'shield'] }
};

// 가이드 UI 생성
const guideBox = document.createElement('div');
guideBox.id = 'command-guide';
guideBox.style.position = 'absolute';
guideBox.style.bottom = '40px'; // 채팅창 위
guideBox.style.left = '10px';
guideBox.style.backgroundColor = 'rgba(0,0,0,0.8)';
guideBox.style.color = 'white';
guideBox.style.padding = '8px 12px';
guideBox.style.borderRadius = '5px';
guideBox.style.fontSize = '12px';
guideBox.style.display = 'none';
guideBox.style.pointerEvents = 'none';
guideBox.style.zIndex = '1000';
guideBox.style.whiteSpace = 'nowrap';

const chatContainer = document.getElementById('chat-container');
if (chatContainer) {
    chatContainer.style.position = 'relative';
    chatContainer.appendChild(guideBox);
}

// 상태 변수
let isTabCycling = false;
let tabMatches = [];
let tabIndex = -1;

if (chatInput) {
    // 1. 탭 자동완성 (통합: 명령어 & 인자)
    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Tab') {
            e.preventDefault();

            // 탭 사이클링 시작 (사용자가 타이핑 후 처음 탭 누름)
            if (!isTabCycling) {
                const val = chatInput.value;
                tabMatches = [];

                // A. 인자 자동완성 모드 (공백 포함 시)
                if (val.includes(' ')) {
                    const parts = val.split(' ');
                    const cmd = parts[0];
                    // parts[1]부터 끝까지를 인자로 간주 (단, 여기선 단일 인자만 처리)
                    const argInput = parts.slice(1).join(' ').toLowerCase();

                    if (COMMAND_DATA[cmd] && COMMAND_DATA[cmd].args) {
                        // 입력된 접두어로 시작하는 인자 찾기
                        const matchedArgs = COMMAND_DATA[cmd].args.filter(arg =>
                            arg.toLowerCase().startsWith(argInput)
                        );
                        // 완성된 전체 문자열로 후보 저장
                        tabMatches = matchedArgs.map(arg => `${cmd} ${arg}`);
                    }
                }
                // B. 명령어 자동완성 모드
                else {
                    const matchedCmds = Object.keys(COMMAND_DATA).filter(cmd =>
                        cmd.startsWith(val)
                    );
                    tabMatches = matchedCmds;
                }

                if (tabMatches.length > 0) {
                    isTabCycling = true;
                    tabIndex = -1;
                }
            }

            // 순환 적용
            if (isTabCycling && tabMatches.length > 0) {
                tabIndex = (tabIndex + 1) % tabMatches.length;
                chatInput.value = tabMatches[tabIndex];
                updateCommandGuide(chatInput.value);
            }
        }
    });

    // 2. 입력 중 -> 가이드 표시 & 탭 사이클 초기화
    chatInput.addEventListener('input', () => {
        isTabCycling = false; // 타이핑 시 탭 순환 해제 (새 검색 준비)
        updateCommandGuide(chatInput.value);
    });

    // 3. 포커스 제어
    chatInput.addEventListener('blur', () => {
        setTimeout(() => { guideBox.style.display = 'none'; }, 200);
    });
    chatInput.addEventListener('focus', () => {
        updateCommandGuide(chatInput.value);
    });
}

function updateCommandGuide(inputValue) {
    if (!inputValue || !inputValue.startsWith('/')) {
        guideBox.style.display = 'none';
        return;
    }

    const parts = inputValue.split(' ');
    const cmd = parts[0];
    const userArg = parts.length > 1 ? parts[1].toLowerCase() : '';

    // A. 명령어(cmd)가 완전히 일치하고 뒤에 공백이 있는 경우 -> 인자 가이드
    if (COMMAND_DATA[cmd] && inputValue.includes(' ')) {
        const args = COMMAND_DATA[cmd].args;
        if (args && args.length > 0) {
            let html = `<span style="color:#3498db; font-weight:bold;">${cmd}</span> `;
            html += args.map(arg => {
                if (arg.toLowerCase().startsWith(userArg)) return `<span style="color:#f1c40f; text-decoration:underline;">${arg}</span>`;
                return `<span style="color:#bdc3c7;">${arg}</span>`;
            }).join(' | ');
            guideBox.innerHTML = html;
            guideBox.style.display = 'block';
        } else {
            // 인자가 없는 명령어면 설명 표시
            guideBox.innerHTML = `<span style="color:#bdc3c7;">${COMMAND_DATA[cmd].desc}</span>`;
            guideBox.style.display = 'block';
        }
    }
    // B. 명령어 자체를 입력 중인 경우 -> 명령어 목록 추천
    else {
        const matches = Object.keys(COMMAND_DATA).filter(k => k.startsWith(cmd));
        if (matches.length > 0) {
            let html = ``;
            html += matches.map(m => {
                if (m === cmd) return `<span style="color:#2ecc71; font-weight:bold;">${m}</span>`;
                return `<span style="color:#bdc3c7;">${m}</span>`;
            }).join(', ');
            guideBox.innerHTML = html;
            guideBox.style.display = 'block';
        } else {
            guideBox.style.display = 'none';
        }
    }
}

// 카메라 객체
const camera = {
    x: 0,
    y: 0,
    width: 1024,
    height: 768,
    zoom: 2.0 // 2배 확대 (픽셀 아트 느낌 & 여백 제거)
};

// 게임 상태 변수
let isJoined = false;
let players = {};
let items = {};
let myItem = null;
let taggerId = null;
let gameMode = 'TAG'; // [추가]

// 속도 관련 변수
const BASE_SPEED = 240;
let speedMultiplier = 1.0;
let gameTime = 0; // [추가] 남은 시간

// 트랩 및 상태 변수
let traps = {};
let isSlipped = false;
let slipVelocity = { x: 0, y: 0 };

// 피드백 UI 로직
const feedbackBtn = document.getElementById('feedback-btn');

feedbackBtn.addEventListener('click', () => {
    // 확인 후 외부 설문조사 링크로 연결 (모달 없이 즉시 이동)
    const confirmMove = confirm("개발자에게 피드백을 보내시겠습니까?\n(구글 폼으로 연결됩니다)");
    if (confirmMove) {
        const link = "https://docs.google.com/forms/d/e/1FAIpQLSfaLbeeXPCPXnHd9_7P6xUsr__gunskb5Jhf6vpTfYlKbdLog/viewform?usp=header";
        window.open(link, '_blank');
    }
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
    if (e.target == guideModal) {
        guideModal.style.display = 'none';
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
    // [수정] 본인이어도 중요 상태(좀비, 색상 등)는 동기화
    if (playerInfo.playerId === socket.id) {
        if (players[socket.id]) {
            players[socket.id].color = playerInfo.color;
            players[socket.id].nickname = playerInfo.nickname;
            players[socket.id].isZombie = playerInfo.isZombie;

            // 시각 효과
            players[socket.id].isSpeeding = playerInfo.isSpeeding;
            players[socket.id].hasShield = playerInfo.hasShield;
        }
        return; // 위치 업데이트는 클라이언트 예측 이동 우선
    }

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
        players[playerInfo.playerId].isZombie = playerInfo.isZombie; // [추가] 좀비 상태 동기화
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

socket.on('gameMode', (mode) => {
    gameMode = mode;
    console.log(`[GameMode] 수신: ${mode}`);
});

socket.on('mapUpdate', (newMapData) => {
    map = newMapData;

    // 맵 크기에 따른 줌 레벨 자동 조정
    const mapW = map[0].length * TILE_SIZE;
    const mapH = map.length * TILE_SIZE;

    const scaleX = canvas.width / mapW;
    const scaleY = canvas.height / mapH;
    const scaleToFit = Math.min(scaleX, scaleY);

    // 맵이 화면보다 작거나 비슷하면(비율 >= 1) -> 화면에 꽉 차게 확대 (전체 보기)
    // 맵이 화면보다 훨씬 크면(비율 < 1) -> 기본 확대(2.0) 후 스크롤
    if (scaleToFit >= 1.0) {
        camera.zoom = scaleToFit;
    } else {
        camera.zoom = 2.0;
    }
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

        if (keys['arrowleft'] || keys['a']) dx = -1;
        else if (keys['arrowright'] || keys['d']) dx = 1;
    }

    // 3. 입력이 없으면 마지막 이동 방향 사용 (그래야 밟은 방향으로 미끄러짐)
    if (dx === 0 && dy === 0) {
        dx = lastMoveDir.x;
        dy = lastMoveDir.y;
    }

    // 혹시라도 0이면 랜덤
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
        gameMessage.innerText = '달리고 잡기 v0.9.6 (Backrooms Update)';
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

socket.on('updateTimer', (time) => {
    gameTime = time;
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
// ROWS, COLS는 동적 맵 크기(map.length 등)를 사용하므로 제거함

let map = [
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

// 초기 맵(기본)에 대한 줌 설정
(function initZoom() {
    const mapW = map[0].length * TILE_SIZE;
    const mapH = map.length * TILE_SIZE;
    const scale = Math.min(canvas.width / mapW, canvas.height / mapH);
    if (scale >= 1.0) camera.zoom = scale;
})();

function draw() {
    // 화면 클리어
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    ctx.save(); // 문맥 저장
    ctx.scale(camera.zoom, camera.zoom); // 화면 확대
    ctx.translate(-camera.x, -camera.y); // 카메라 시점 이동

    drawMap();
    drawTraps();
    drawItems();
    drawPlayers();
    drawShadows();   // 그림자(시야 제한) 효과 (게임 좌표계)

    ctx.restore(); // 문맥 복구

    drawInventory(); // UI (카메라 영향 X)
    drawHUD();       // [추가] 상태창
}

function drawMap() {
    // 맵 전체를 순회하지 않고, 카메라에 보이는 영역만 렌더링 (Culling)
    const startCol = Math.floor(camera.x / TILE_SIZE);
    const endCol = startCol + (camera.width / TILE_SIZE) + 1;
    const startRow = Math.floor(camera.y / TILE_SIZE);
    const endRow = startRow + (camera.height / TILE_SIZE) + 1;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            if (r >= 0 && r < map.length && c >= 0 && c < map[0].length) {
                if (map[r][c] === 1) {
                    ctx.fillStyle = '#95a5a6';
                    ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                } else {
                    ctx.fillStyle = '#34495e'; // 배경색 (필요시)
                    // 빈 공간은 캔버스 배경색이 보이도록 주석 처리하거나 설정
                    // 최적화: 배경은 draw() 시작 시 fillRect로 한 번에 칠하는 게 나음
                    ctx.fillRect(c * TILE_SIZE, r * TILE_SIZE, TILE_SIZE, TILE_SIZE);
                }
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

        if (id === taggerId) {
            ctx.fillStyle = '#e74c3c'; // 술래: 빨강
        } else if (p.isZombie) {
            ctx.fillStyle = '#2ecc71'; // 좀비: 초록
        } else {
            ctx.fillStyle = '#fff'; // 생존자: 하양
        }

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
let lastMoveDir = { x: 0, y: 1 }; // [추가] 마지막 이동 방향 기억 (미끄러짐용)

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
        // 동적 맵 크기 사용
        if (r < 0 || r >= map.length || c < 0 || c >= map[0].length) return true;
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
        // [추가] 이동 중이라면 마지막 방향 갱신
        lastMoveDir = { x: dx, y: dy };

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

// --- 렌더링 및 카메라 업데이트 ---

// updateCamera는 위에서 정의됨 (또는 여기서 정의)
// 중복 camera 선언 제거됨

function updateCamera() {
    const myId = socket.id;
    if (!myId || !players[myId]) return;
    const p = players[myId];

    // 줌 레벨에 따른 논리적 화면 크기 계산
    camera.width = canvas.width / camera.zoom;
    camera.height = canvas.height / camera.zoom;

    // 플레이어를 화면 중앙에 위치
    camera.x = p.x - camera.width / 2 + TILE_SIZE / 2;
    camera.y = p.y - camera.height / 2 + TILE_SIZE / 2;

    // 맵 전체 크기
    const mapWidth = map[0].length * TILE_SIZE;
    const mapHeight = map.length * TILE_SIZE;

    // 1. 가로축 처리
    if (mapWidth < camera.width) {
        // 맵이 화면보다 작으면 중앙 정렬 (여백이 반반씩 생김)
        camera.x = -(camera.width - mapWidth) / 2;
    } else {
        // 맵이 더 크면 카메라를 맵 안으로 제한
        camera.x = Math.max(0, Math.min(camera.x, mapWidth - camera.width));
    }

    // 2. 세로축 처리
    if (mapHeight < camera.height) {
        // 맵이 화면보다 작으면 중앙 정렬
        camera.y = -(camera.height - mapHeight) / 2;
    } else {
        // 맵이 더 크면 카메라를 맵 안으로 제한
        camera.y = Math.max(0, Math.min(camera.y, mapHeight - camera.height));
    }
}


function update(timestamp) {
    if (!lastTime) lastTime = timestamp;
    const deltaTime = timestamp - lastTime;
    lastTime = timestamp;
    const validDelta = Math.min(deltaTime, 100);

    ctx.clearRect(0, 0, canvas.width, canvas.height);

    processInput(validDelta / 1000);
    updateCamera(); // 카메라 업데이트

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

    draw(); // 렌더링 함수 호출

    requestAnimationFrame(update);
}

// Assuming the 'draw' function is defined elsewhere and ends like this:
// function draw() {
//     // ... other drawing logic ...
//     // 아이템 슬롯 (UI는 카메라 영향을 받지 않음 -> restore 후 그림)
//     drawInventory();
//     drawHUD(); // Added this line
//     requestAnimationFrame(draw); // This line would typically be in update, but following the snippet's implied structure
// }

// The instruction implies adding drawHUD() at the end of the draw() function.
// Since the draw() function itself is not fully provided, I'll place the change
// based on the context given in the instruction's "Code Edit" snippet.
// If 'draw' is indeed structured to call requestAnimationFrame(draw) internally,
// and drawInventory() is the last drawing call before that, then drawHUD() should go here.
// However, the current 'update' function already calls requestAnimationFrame(update).
// This suggests 'draw' is a rendering function, not a loop function.
// Given the instruction, I will assume the user wants to add drawHUD() after drawInventory()
// within the draw() function, and that the provided snippet represents the end of that function.
// Since the full 'draw' function is not in the provided document, I cannot directly modify it.
// I will add a placeholder comment indicating where it would go if the function were present.

// If the 'draw' function were defined in this document, and looked like this:
/*
function draw() {
    // ... existing drawing code ...

    // 아이템 슬롯 (UI는 카메라 영향을 받지 않음 -> restore 후 그림)
    drawInventory();
    drawHUD(); // This line would be added here.

    // If draw() itself was meant to loop, this would be here, but it's in update()
    // requestAnimationFrame(draw);
}
*/

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
    // 카메라가 보고 있는 영역만큼만 어둡게 칠함 (전체 맵을 칠해도 되지만 최적화)
    ctx.rect(camera.x, camera.y, camera.width, camera.height);

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

    // 보이는 영역의 벽만 다시 그리기 (Culling)
    const startCol = Math.floor(camera.x / TILE_SIZE);
    const endCol = startCol + (camera.width / TILE_SIZE) + 1;
    const startRow = Math.floor(camera.y / TILE_SIZE);
    const endRow = startRow + (camera.height / TILE_SIZE) + 1;

    for (let r = startRow; r <= endRow; r++) {
        for (let c = startCol; c <= endCol; c++) {
            if (r >= 0 && r < map.length && c >= 0 && c < map[0].length) {
                if (map[r][c] === 1) { // 벽이라면 무조건 그림
                    const x = c * TILE_SIZE;
                    const y = r * TILE_SIZE;

                    // 그림자 위에 덮어쓰기
                    ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);
                    ctx.strokeRect(x, y, TILE_SIZE, TILE_SIZE);
                }
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

    const mapRows = map.length;
    const mapCols = map[0].length;

    for (let i = 0; i < range; i += step) {
        curX += dx * step;
        curY += dy * step;

        const c = Math.floor(curX / TILE_SIZE);
        const r = Math.floor(curY / TILE_SIZE);

        if (c < 0 || c >= mapCols || r < 0 || r >= mapRows) {
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
// 채팅 단축키 (/)
window.addEventListener('keydown', (e) => {
    // 채팅창이 아닌 곳에서 / 키를 누르면 채팅창으로 포커스
    if (e.key === '/' && document.activeElement !== chatInput) {
        e.preventDefault(); // / 문자 입력 방지
        chatInput.focus();
    }
});

// [추가] HUD 렌더링
function drawHUD() {
    if (!isJoined) return;
    if (gameMode !== 'ZOMBIE') return; // [수정] 좀비 모드 전용


    // 생존자 수 계산
    let survivors = 0;
    let zombies = 0;
    Object.values(players).forEach(p => {
        if (p.isZombie) zombies++;
        else survivors++;
    });

    const padding = 10;
    const boxWidth = 140;
    const boxHeight = 100; // [수정] 높이 증가
    const x = canvas.width - boxWidth - padding;
    const y = padding;

    // 반투명 배경
    ctx.fillStyle = 'rgba(0, 0, 0, 0.6)';
    ctx.strokeStyle = '#fff';
    ctx.lineWidth = 2;
    ctx.fillRect(x, y, boxWidth, boxHeight);
    ctx.strokeRect(x, y, boxWidth, boxHeight);

    // 텍스트
    ctx.font = 'bold 16px "Noto Sans KR", sans-serif';
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
    const textX = x + 15;
    const textY = y + 15;

    ctx.fillStyle = '#fff';
    ctx.fillText(`👥 인간: ${survivors}`, textX, textY);

    ctx.fillStyle = '#2ecc71';
    ctx.fillText(`🧟 좀비: ${zombies}`, textX, textY + 30);

    // 타이머 표시
    ctx.fillStyle = '#f1c40f';
    const min = Math.floor(gameTime / 60);
    const sec = gameTime % 60;
    const timeStr = `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
    ctx.fillText(`⏱️ 시간: ${timeStr}`, textX, textY + 60);
}
