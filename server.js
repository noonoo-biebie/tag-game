const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
// const fs = require('fs'); // 피드백 파일 저장 제거됨
// const fs = require('fs'); // 피드백 파일 저장 제거됨

// [모듈 임포트]
const { TILE_SIZE, MAPS, BOT_PERSONALITIES, ITEM_TYPES } = require('./config');
const { getRandomSpawn, checkBotWallCollision, checkLineOfSight, findPath, generateBackrooms, generateMazeBig, generateOffice } = require('./utils');
const Bot = require('./bot');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// 게임 상태 변수
let players = {};
let taggerId = null;
let lastTaggerId = null; // 최근 술래 (봇 반격 방지용)
let currentMapName = 'DEFAULT';
let currentMapData = MAPS.DEFAULT;
let gameMode = 'TAG'; // [복구] 게임 모드 변수 선언 (TAG/ZOMBIE)
let roundTime = 0;
let roundTimer = null;

// --- 아이템 시스템 ---
let items = {};
let itemNextId = 1;

function spawnItem() {
    if (Object.keys(items).length >= 5) {
        // 가장 오래된 아이템 삭제
        const oldestId = Object.keys(items).sort((a, b) => a - b)[0];
        delete items[oldestId];
    }

    const pos = getRandomSpawn(currentMapData);
    const id = itemNextId++;
    const type = ITEM_TYPES[Math.floor(Math.random() * ITEM_TYPES.length)];

    items[id] = { x: pos.x, y: pos.y, type: type };
    io.emit('updateItems', items);
    console.log(`아이템 생성: ${type} at (${pos.x}, ${pos.y})`);
}

// 아이템 획득/사용 처리 함수 (Server Context 필요)
function handleItemEffect(playerId, itemType) {
    const player = players[playerId];
    if (!player) return;

    if (itemType === 'speed') {
        player.isSpeeding = true;
        io.to(playerId).emit('itemEffect', { type: 'speed', duration: 5000 });
        io.emit('playerMoved', player); // 시각 효과(오라) 전파 (playerMoved에서 처리됨)

        // 봇인 경우 Bot 클래스 내에서 속도 처리됨, 플레이어는 클라이언트가 속도 처리
        setTimeout(() => {
            if (players[playerId]) {
                players[playerId].isSpeeding = false;
                io.emit('playerMoved', players[playerId]);
            }
        }, 5000);
    } else if (itemType === 'banana') {
        const trapId = Date.now() + Math.random();
        traps[trapId] = { x: player.x, y: player.y, ownerId: playerId, createdAt: Date.now() };
        console.log(`[Banana] Created by ${player.nickname}, TrapID: ${trapId}, Total: ${Object.keys(traps).length}`);
        io.emit('updateTraps', traps);
        io.emit('gameMessage', `[${player.nickname}] 님이 바나나를 설치했습니다! 🍌`);
    } else if (itemType === 'shield') {
        player.hasShield = true;
        io.to(playerId).emit('itemEffect', { type: 'shield', on: true });
        io.emit('playerMoved', player);
        io.emit('gameMessage', `[${player.nickname}] 님이 방어막을 켰습니다! 🛡️`);
    }
}

// 아이템 획득 판정 (범위 30)
function checkItemCollection(playerId) {
    const player = players[playerId];
    if (!player) return;

    for (const itemId in items) {
        const item = items[itemId];
        const dx = player.x - item.x;
        const dy = player.y - item.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
            if (player.hasItem) return;

            // 쉴드 해제 (상반되는 효과? 게임 규칙)
            if (player.hasShield) {
                player.hasShield = false;
                io.to(playerId).emit('itemEffect', { type: 'shield', on: false });
                io.emit('gameMessage', `[${player.nickname}] 님의 방어막이 새 아이템 획득으로 사라졌습니다.`);
            }

            player.hasItem = item.type;
            delete items[itemId];

            io.emit('updateItems', items);
            io.to(playerId).emit('updateInventory', player.hasItem);
            io.emit('gameMessage', `[${player.nickname}] 님이 [${item.type}] 획득!`);
            break;
        }
    }
}

// 트랩 및 로직 변수
let traps = {};

function checkTrapCollision(playerId) {
    try {
        const player = players[playerId];
        if (!player) return;

        // 트랩 없으면 리턴
        if (Object.keys(traps).length === 0) return;

        // 미끄러짐 해제 체크
        if (player.isSlipped) {
            if (Date.now() - player.slipStartTime > 3000) {
                player.isSlipped = false;
                // console.log(`[Banana] ${player.nickname} recovered.`);
            } else {
                return; // 미끄러짐 중엔 체크 안함
            }
        }

        // 거리 체크
        for (const trapId in traps) {
            const trap = traps[trapId];
            if (!trap) continue;

            const pCx = player.x + 16;
            const pCy = player.y + 16;
            const tCx = trap.x + 16;
            const tCy = trap.y + 16;

            const dist = Math.sqrt((pCx - tCx) ** 2 + (pCy - tCy) ** 2);



            // 설치자 보호
            if (trap.ownerId === playerId) {
                if (Date.now() - trap.createdAt < 3000) continue;
            }

            if (dist < 30) {
                player.isSlipped = true;
                player.slipStartTime = Date.now();

                let slipDir = { x: 0, y: 0 };
                if (player instanceof Bot) {
                    slipDir = { ...player.moveDir };
                    if (slipDir.x === 0 && slipDir.y === 0) slipDir.x = Math.random() < 0.5 ? 1 : -1;
                    player.slipDir = slipDir;
                } else {
                    io.to(playerId).emit('playerSlipped', { duration: 3000 });
                }

                delete traps[trapId];
                io.emit('updateTraps', traps);
                io.emit('gameMessage', `[${player.nickname}] 님이 바나나를 밟았습니다! 으악!`);
                return;
            }
        }
    } catch (e) {
        console.error("TrapError:", e);
    }
}

// 충돌(태그) 판정
function checkCollision(moverId) {
    const mover = players[moverId];
    if (!mover) return;

    // 모드별 로직 분기
    if (gameMode === 'TAG') {
        if (!taggerId) return;
        // 내가 술래일 때만 다른 사람 잡기 체크
        if (moverId === taggerId) {
            // (기존 술래잡기 로직)
            if (mover.stunnedUntil && Date.now() < mover.stunnedUntil) return;

            for (const targetId in players) {
                if (targetId === moverId) continue;
                const target = players[targetId];
                if (targetId === lastTaggerId) {
                    // 방금 술래였던 사람은 잠깐 안전? (여기선 생략, lastTagger logic is mainly for bots)
                }

                const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
                if (dist < 30) {
                    if (target.hasShield) {
                        // 방어
                        target.hasShield = false;
                        io.to(targetId).emit('itemEffect', { type: 'shield', on: false });
                        io.emit('gameMessage', `[${target.nickname}] 님이 방어막으로 공격을 막았습니다!`);
                        // 술래 잠깐 기절 (패널티)
                        players[taggerId].stunnedUntil = Date.now() + 1000;
                        // 넉백 (옵션)
                        return;
                    }

                    // 태그 성공
                    lastTaggerId = taggerId;
                    taggerId = targetId;
                    // 새 술래 기절 처리 (2초)
                    if (players[taggerId]) {
                        players[taggerId].stunnedUntil = Date.now() + 2000;
                    }

                    io.emit('updateTagger', taggerId);
                    io.emit('gameMessage', `[${target.nickname}] 님이 술래가 되었습니다!`);
                    io.emit('tagOccurred', { newTaggerId: taggerId });
                    console.log(`태그 발생: ${mover.nickname} -> ${target.nickname}`);
                    break;
                }
            }
        }
    } else if (gameMode === 'ZOMBIE') {
        const zombieColors = ['#2ecc71', '#27ae60', '#00b894', '#55efc4', '#16a085'];

        // 좀비 모드 충돌 판정 (쌍방향 체크)
        for (const targetId in players) {
            if (targetId === moverId) continue;
            const target = players[targetId];

            const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
            if (dist < 30) {
                let zombie = null;
                let human = null;

                if (mover.isZombie && !target.isZombie) {
                    zombie = mover;
                    human = target;
                } else if (!mover.isZombie && target.isZombie) {
                    zombie = target;
                    human = mover;
                }

                if (zombie && human) {
                    // 1. 쉴드 체크
                    if (human.hasShield) {
                        human.hasShield = false;
                        const humanId = (human === mover) ? moverId : targetId;
                        io.to(humanId).emit('itemEffect', { type: 'shield', on: false });
                        io.emit('gameMessage', `🛡️ [${human.nickname}] 님이 방어막으로 좀비를 막았습니다!`);
                        zombie.stunnedUntil = Date.now() + 1000;
                        return;
                    }

                    // 2. 감염 발생
                    const humanId = (human === mover) ? moverId : targetId;

                    human.isZombie = true;
                    if (!human.originalColor) human.originalColor = human.color;
                    human.color = zombieColors[Math.floor(Math.random() * zombieColors.length)];

                    // 봇 아이콘 변경 (🤖 -> 🧟)
                    if (human.nickname.includes('🤖')) {
                        human.nickname = human.nickname.replace('🤖', '🧟');
                    } else if (!human.nickname.includes('🧟')) {
                        // 플레이어도 원하면 아이콘 추가? (일단 봇만 요청사항)
                    }

                    io.emit('playerMoved', human);
                    io.emit('gameMessage', `🧟 [${human.nickname}] 님이 좀비에게 감염되었습니다!`);
                    io.emit('zombieInfect', { targetId: humanId });

                    checkZombieWin();
                    break;
                }
            }
        }
    }
}

function checkZombieWin() {
    // 생존자 수 체크
    const ids = Object.keys(players);
    const survivors = ids.filter(id => !players[id].isZombie);

    if (survivors.length === 0 && ids.length > 0) { // 모든 플레이어가 좀비가 되었을 때
        io.emit('gameMessage', `🧟 인류가 멸망했습니다... 좀비 승리! 🧟`);
        // 게임 오버 처리? 리셋?
        // 일단 메시지만.
    } else if (survivors.length > 0 && ids.length > 0) {
        // 생존자 수 알림 (매번 하면 시끄러우니 생략하거나 변경 시에만)
        // io.emit('gameMessage', `생존자 ${survivors.length}명 남았습니다.`);
    }
}

function startRoundTimer(seconds) {
    if (roundTimer) clearInterval(roundTimer);
    roundTime = seconds;
    io.emit('updateTimer', roundTime);

    roundTimer = setInterval(() => {
        roundTime--;
        io.emit('updateTimer', roundTime);

        if (roundTime <= 0) {
            clearInterval(roundTimer);
            if (gameMode === 'ZOMBIE') {
                io.emit('gameMessage', '🎉 생존자 승리! 3분 동안 버텨냈습니다! 🎉');
                setTimeout(() => resetGame(), 5000);
            }
        }
    }, 1000);
}

// 봇 생성
function createBot() {
    const botId = 'bot_' + Date.now();
    const bot = new Bot(botId, currentMapData);

    // 성격 설정 (봇 밸런싱) - bot.js 내부 로직 활용하지만 여기서 players 넘겨주면 더 좋음
    // Bot 생성자 내 getRandomPersonality는 인자 없으면 랜덤.
    // players 정보를 넘겨주기 위해 여기서 다시 호출하거나, bot.js 설계를 따름.
    // 현재 구현: Bot 생성자에서 기존 personality 분포 확인 로직은 existingPlayers 인자가 필요함.
    // 하지만 위 코드에서는 인자 없이 호출 -> 랜덤.
    // 개선: Bot 초기화 후 재할당
    bot.personality = bot.getRandomPersonality(players);

    players[botId] = bot;

    io.emit('newPlayer', bot);
    io.emit('gameMessage', `🤖 [${bot.personality}] 성격의 봇이 입장했습니다!`);

    if (!taggerId) {
        taggerId = botId;
        io.emit('updateTagger', taggerId);
        io.emit('gameMessage', `[${bot.nickname}] 님이 첫 술래입니다!`);
    }
}

// 리셋 확인용 변수
let resetRequestTime = 0;
let resetRequesterId = null;

// 좀비 모드 카운트다운 시작
function startZombieCountdown() {
    let timeLeft = 10;
    const countdownMsg = (sec) => `⏳ ${sec}초 뒤에 좀비 바이러스가 퍼집니다!`;

    io.emit('gameMessage', countdownMsg(timeLeft));
    io.emit('chatMessage', { nickname: 'System', message: countdownMsg(timeLeft), playerId: 'system' });

    const countdownInterval = setInterval(() => {
        if (gameMode !== 'ZOMBIE') {
            clearInterval(countdownInterval);
            return;
        }

        timeLeft--;
        if (timeLeft > 0) {
            io.emit('gameMessage', countdownMsg(timeLeft));
        } else {
            clearInterval(countdownInterval);

            // 감염 시작
            const ids = Object.keys(players);
            if (ids.length > 0) {
                const hostId = ids[Math.floor(Math.random() * ids.length)];
                const host = players[hostId];

                if (host && !host.isZombie) {
                    host.isZombie = true;
                    host.originalColor = host.color;
                    host.color = '#2ecc71';

                    io.emit('playerMoved', host);
                    io.emit('gameMessage', `🧟 [${host.nickname}] 님이 최초의 좀비(숙주)가 되었습니다!!`);
                    io.emit('zombieInfect', { targetId: hostId });

                    // 3분 타이머 시작
                    startRoundTimer(180);
                }
            }
        }
    }, 1000);
}

function resetGame() {
    if (roundTimer) clearInterval(roundTimer);
    roundTime = 0;
    io.emit('updateTimer', 0);
    items = {};
    traps = {};
    io.emit('updateItems', items);
    io.emit('updateTraps', traps);

    // [추가] 랜덤 맵인 경우 리셋 시 구조 재생성
    if (currentMapName === 'BACKROOMS') {
        try {
            console.log('[Reset] Backrooms 재생성...');
            currentMapData = generateBackrooms(60, 60);
            io.emit('mapUpdate', currentMapData);
        } catch (e) { console.error(e); }
    } else if (currentMapName === 'OFFICE') {
        currentMapData = generateOffice(60, 60);
        io.emit('mapUpdate', currentMapData);
    } else if (currentMapName === 'MAZE_BIG') {
        currentMapData = generateMazeBig(60, 60);
        io.emit('mapUpdate', currentMapData);
    }

    // 플레이어/봇 재배치
    for (const id in players) {
        const p = players[id];
        const spawn = getRandomSpawn(currentMapData);
        p.x = spawn.x;
        p.y = spawn.y;
        p.targetX = p.x;
        p.targetY = p.y;
        p.isSlipped = false;
        p.stunnedUntil = 0;
        p.hasItem = null;
        p.hasShield = false;
        p.isSpeeding = false;

        // 좀비 상태 초기화
        p.isZombie = false;
        if (p.originalColor) p.color = p.originalColor; // 원래 색 복구

        // [추가] 클라이언트 인벤토리 초기화 이벤트 전송
        io.to(id).emit('updateInventory', null);
    }

    // 모드별 초기화
    if (gameMode === 'TAG') {
        // 생존자 중 한 명 술래? (보통 createBot이나 join에서 함)
        // 리셋 시 술래 재선정
        const ids = Object.keys(players);
        if (ids.length > 0) {
            taggerId = ids[Math.floor(Math.random() * ids.length)];
            io.emit('updateTagger', taggerId);
        }
    } else if (gameMode === 'ZOMBIE') {
        taggerId = null; // 좀비 모드는 술래 개념 대신 좀비가 있음
        io.emit('updateTagger', null);
        startZombieCountdown();
    }

    io.emit('currentPlayers', players);
    io.emit('gameMode', gameMode); // [추가] 클라이언트에 게임 모드 전송

    const msg = `🔄 게임 리셋! 모드: ${gameMode}`;
    io.emit('gameMessage', msg);
    io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' });
}

// 소켓 IO
io.on('connection', (socket) => {
    console.log('클라이언트 접속:', socket.id);
    setupSocketEvents(socket);
});

function setupSocketEvents(socket) {
    socket.on('joinGame', (data) => handleJoinGame(socket, data));
    socket.on('playerMove', (data) => handlePlayerMove(socket, data));
    socket.on('useItem', () => handleUseItem(socket));
    socket.on('disconnect', () => handleDisconnect(socket));
    socket.on('chatMessage', (msg) => handleChatMessage(socket, msg));
    // socket.on('sendFeedback', (msg) => handleFeedback(socket, msg)); // 외부 링크로 변경
    socket.on('announceAction', (action) => handleAnnounceAction(socket, action));
}

function handleAnnounceAction(socket, action) {
    if (!players[socket.id]) return;
    const nickname = players[socket.id].nickname;
    const msg = `[${nickname}] 님이 ${action}`;
    io.emit('gameMessage', msg);
    io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' });
}

// function handleFeedback(socket, msg) { ... } // 제거됨

// function handleFeedback(socket, msg) { ... } // 제거됨

// function handleFeedback(socket, msg) { ... } // 제거됨

function handleJoinGame(socket, data) {
    if (players[socket.id]) return;

    console.log('게임 입장:', data.nickname);

    const spawnPos = getRandomSpawn(currentMapData);
    players[socket.id] = {
        x: spawnPos.x,
        y: spawnPos.y,
        playerId: socket.id,
        color: data.color || '#e74c3c',
        nickname: data.nickname || '익명'
    };

    if (!taggerId) {
        taggerId = socket.id;
        io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 첫 술래입니다!`);
    } else {
        io.emit('gameMessage', `[${players[socket.id].nickname}] 님이 입장했습니다.`);
    }

    socket.emit('joinSuccess', players[socket.id]);
    socket.emit('mapUpdate', currentMapData); // 맵 데이터 전송
    socket.emit('gameMode', gameMode); // [추가]
    socket.emit('currentPlayers', players);
    socket.emit('updateItems', items);
    socket.emit('updateTraps', traps);
    socket.emit('updateTagger', taggerId);

    socket.broadcast.emit('newPlayer', players[socket.id]);
}

function handlePlayerMove(socket, movementData) {
    if (players[socket.id] && players[socket.id].stunnedUntil && Date.now() < players[socket.id].stunnedUntil) {
        return;
    }

    if (players[socket.id]) {
        players[socket.id].x = movementData.x;
        players[socket.id].y = movementData.y;
        io.emit('playerMoved', players[socket.id]);
        checkCollision(socket.id);
        checkItemCollection(socket.id);


        checkTrapCollision(socket.id);
    }
}

// [추가] 아이템 획득 체크
function checkItemCollection(playerId) {
    const player = players[playerId];
    if (!player) return;
    if (player.isZombie) return; // 좀비는 아이템 획득 불가

    if (player.hasItem) return; // 이미 아이템 보유 중

    for (const itemId in items) {
        const item = items[itemId];
        const dist = Math.hypot(player.x - item.x, player.y - item.y);

        // 아이템 획득 반경 (30px)
        if (dist < 30) {
            player.hasItem = item.type;
            delete items[itemId];

            io.emit('updateItems', items);
            io.to(playerId).emit('updateInventory', item.type);
            io.emit('gameMessage', `[${player.nickname}] 님이 ${item.type} 획득!`);
            break;
        }
    }
}



function handleUseItem(socket) {
    const player = players[socket.id];
    if (!player) return;
    if (player.isZombie) return; // [추가] 좀비는 아이템 사용 불가

    if (player.hasItem) {
        const itemType = player.hasItem;
        player.hasItem = null;
        io.to(socket.id).emit('updateInventory', null);
        handleItemEffect(socket.id, itemType);
    }
}

function handleDisconnect(socket) {
    if (players[socket.id]) {
        console.log('플레이어 퇴장:', players[socket.id].nickname);
        const leftNickname = players[socket.id].nickname;
        delete players[socket.id];
        io.emit('disconnectPlayer', socket.id);
        io.emit('gameMessage', `[${leftNickname}] 님이 나갔습니다.`);

        if (socket.id === taggerId) {
            const remainingIds = Object.keys(players);
            if (remainingIds.length > 0) {
                taggerId = remainingIds[Math.floor(Math.random() * remainingIds.length)];
                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `술래가 나가서 [${players[taggerId].nickname}] 님이 새 술래가 됩니다!`);
            } else {
                taggerId = null;
            }
        }
    }
}

function handleChatMessage(socket, msg) {
    if (!players[socket.id]) return;

    const player = players[socket.id];
    const cmd = msg.trim();

    if (cmd === '/bot' || cmd === '/addbot') {
        createBot();
        const infoMsg = `[${player.nickname}] 님이 봇을 소환했습니다! 🤖`;
        io.emit('gameMessage', infoMsg);
        io.emit('chatMessage', { nickname: 'System', message: infoMsg, playerId: 'system' });
        return;
    }

    if (cmd === '/kickbot' || cmd === '/removebot') {
        let removedCount = 0;
        const ids = Object.keys(players);

        ids.forEach(id => {
            if (id.startsWith('bot_') || players[id] instanceof Bot) {
                delete players[id];
                io.emit('disconnectPlayer', id);
                removedCount++;
            }
        });

        if (removedCount > 0) {
            const kickMsg = `🤖 봇 ${removedCount}명을 모두 추방했습니다! 👋`;
            io.emit('gameMessage', kickMsg);
            io.emit('chatMessage', { nickname: 'System', message: kickMsg, playerId: 'system' });

            if (gameMode === 'TAG' && players[taggerId] === undefined) {
                const remaining = Object.keys(players);
                if (remaining.length > 0) {
                    taggerId = remaining[0];
                    io.emit('updateTagger', taggerId);
                    io.emit('tagOccurred', { newTaggerId: taggerId });
                } else {
                    taggerId = null;
                }
            }
        } else {
            const failMsg = "추방할 봇이 없습니다.";
            socket.emit('gameMessage', failMsg);
            socket.emit('chatMessage', { nickname: 'System', message: failMsg, playerId: 'system' });
        }
        return;
    }

    if (cmd === '/reset') {
        const now = Date.now();
        if (resetRequesterId === socket.id && now - resetRequestTime < 5000) {
            resetGame();
            const resetMsg = `[${player.nickname}] 님이 게임을 리셋했습니다! 💥`;
            io.emit('gameMessage', resetMsg);
            io.emit('chatMessage', { nickname: 'System', message: resetMsg, playerId: 'system' });
            resetRequesterId = null;
        } else {
            resetRequesterId = socket.id;
            resetRequestTime = now;
            const warnMsg = "⚠️ 5초 안에 '/reset'을 한번 더 입력하면 초기화됩니다.";
            socket.emit('gameMessage', warnMsg);
            socket.emit('chatMessage', { nickname: 'System', message: warnMsg, playerId: 'system' });
        }
        return;
    }

    // 게임 모드 설정
    if (cmd.startsWith('/mode ')) {
        const modeMsg = `[${player.nickname}] 님이 명령어를 실행했습니다: ${cmd}`;
        io.emit('gameMessage', modeMsg);
        io.emit('chatMessage', { nickname: 'System', message: modeMsg, playerId: 'system' });

        const parts = cmd.split(' ');
        const mode = parts[1].toLowerCase();

        if (mode === 'zombie') {
            gameMode = 'ZOMBIE';
            // [수정] 맵 변경 제거 (현재 맵 유지)

            if (parts[2]) {
                const botCount = parseInt(parts[2]);
                Object.keys(players).forEach(id => {
                    if (players[id] instanceof Bot) delete players[id];
                });
                for (let i = 0; i < botCount; i++) {
                    const botId = 'bot_' + Date.now() + '_' + i;
                    const bot = new Bot(botId, currentMapData);
                    players[bot.id] = bot;
                }
            }

            resetGame();



        } else if (mode === 'tag') {
            gameMode = 'TAG';
            resetGame();
        } else {
            socket.emit('chatMessage', { nickname: 'System', message: "사용법: /mode [zombie/tag] [봇수]", playerId: 'system' });
        }
        return;
    }

    // 맵 변경 커맨드
    if (cmd.startsWith('/map')) {
        const inputName = cmd.split(' ')[1];
        if (inputName) {
            const mapKey = inputName.toUpperCase();
            let isRandom = false;

            if (mapKey === 'BACKROOMS') {
                console.log('[MapGen] Backrooms(Level 0) 생성 시작...');
                try {
                    const newMap = generateBackrooms(60, 60);
                    if (!newMap || !newMap.length) throw new Error("맵 생성 실패 (결과 없음)");
                    currentMapName = 'BACKROOMS';
                    currentMapData = newMap;
                    isRandom = true;
                    console.log(`[MapGen] 생성 완료: ${currentMapData.length}x${currentMapData[0].length}`);
                } catch (e) {
                    console.error('[MapGen] Error:', e);
                    socket.emit('chatMessage', { nickname: 'System', message: `맵 생성 오류: ${e.message}`, playerId: 'system' });
                    return;
                }
            } else if (mapKey === 'OFFICE') {
                console.log('[MapGen] Office 생성 시작...');
                currentMapName = 'OFFICE';
                currentMapData = generateOffice(60, 60);
                isRandom = true;
            } else if (mapKey === 'MAZE_BIG') {
                currentMapName = 'MAZE_BIG';
                currentMapData = generateMazeBig(60, 60); // 기존 거대 미로
                isRandom = true;
            } else if (MAPS[mapKey]) {
                currentMapName = mapKey;
                currentMapData = MAPS[currentMapName];
            } else {
                const availMaps = Object.keys(MAPS).join(', ');
                const errMsg = `존재하지 않는 맵입니다. 사용 가능: ${availMaps}`;
                socket.emit('chatMessage', { nickname: 'System', message: errMsg, playerId: 'system' });
                return;
            }

            // 모든 플레이어/봇 재배치 및 리셋
            resetGame();

            io.emit('mapUpdate', currentMapData);

            let mapMsg = `🗺️ 맵이 [${currentMapName}]으로 변경되었습니다!`;
            if (isRandom) mapMsg += " (♻️ 랜덤 구조 생성)";

            io.emit('gameMessage', mapMsg);
            io.emit('chatMessage', { nickname: 'System', message: mapMsg, playerId: 'system' });
        }
        return;
    }

    if (cmd === '/help' || cmd === '/명령어' || cmd === '/?') {
        const helpMsg = '<br>📜 <b>명령어 목록</b><br>' +
            '🧟 <b>/mode zombie [숫자]</b> : 좀비모드+봇생성<br>' +
            '🤖 <b>/bot</b> : 봇 소환<br>' +
            '👋 <b>/kickbot</b> : 봇 추방<br>' +
            '🔄 <b>/reset</b> : 맵 초기화<br>' +
            '🎁 <b>/item [이름]</b> : 아이템 획득 (banana, speed, shield)<br>' +
            '🗺️ <b>/map [이름]</b> : 맵 변경<br>' +
            '👁️ <b>/fog</b> : 시야 제한 해제 (치트)';

        socket.emit('chatMessage', { nickname: 'System', message: helpMsg, playerId: 'system' });
        return;
    }

    // [추가] 아이템 치트
    if (cmd.startsWith('/item ')) {
        const parts = cmd.split(' ');
        if (parts.length > 1) {
            const itemType = parts[1].toLowerCase();
            const validItems = ['banana', 'speed', 'shield'];
            if (validItems.includes(itemType)) {
                player.hasItem = itemType;
                io.to(socket.id).emit('updateInventory', itemType);

                const cheatMsg = `⚠️ [${player.nickname}] 님이 치트(${itemType})를 사용했습니다!`;
                io.emit('gameMessage', cheatMsg);
                io.emit('chatMessage', { nickname: 'System', message: cheatMsg, playerId: 'system' });
            } else {
                socket.emit('chatMessage', { nickname: 'System', message: "유효하지 않은 아이템입니다. (banana, speed, shield)", playerId: 'system' });
            }
        }
        return;
    }

    // /readfeedback 제거됨

    io.emit('chatMessage', {
        nickname: player.nickname,
        message: msg,
        playerId: socket.id
    });
}

// 15초마다 아이템 스폰
setInterval(() => {
    spawnItem();
    io.emit('gameMessage', `🎁 선물 상자가 나타났습니다!`);
}, 15000);

// 초기 아이템 및 테스트 바나나
setTimeout(() => {
    spawnItem(); spawnItem();


}, 1000);

// 게임 루프 (봇 업데이트)
setInterval(() => {
    Object.keys(players).forEach(id => {
        if (players[id] instanceof Bot) {
            // [중요] 봇에게 게임 state와 callback 전달
            // gameMode 추가 전달
            players[id].update(players, taggerId, lastTaggerId, {
                handleItemEffect: handleItemEffect
            }, currentMapData, gameMode);

            // 동기화
            io.emit('playerMoved', players[id]);
            checkCollision(id);
            checkItemCollection(id);
            checkTrapCollision(id);
        }
    });
}, 100);

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행: http://localhost:${PORT}`);
});
