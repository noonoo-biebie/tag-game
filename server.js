const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);
// const fs = require('fs'); // 피드백 파일 저장 제거됨
// const fs = require('fs'); // 피드백 파일 저장 제거됨

// [모듈 임포트]
const { ROWS, COLS, TILE_SIZE, ITEM_TYPES, MAPS } = require('./config');
const { getRandomSpawn, checkBotWallCollision } = require('./utils');
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
        traps[trapId] = { x: player.x, y: player.y, ownerId: playerId };
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
    const player = players[playerId];
    if (!player) return;

    // 공중부양/무적 상태면 무시하고 싶지만 일단 구현 편의상 체크
    if (player.isSlipped) return; // 이미 미끄러지는 중이면 패스

    for (const trapId in traps) {
        const trap = traps[trapId];
        // 설치 직후 본인 면역 로직 (옵션) - 일단 생략

        const dx = player.x - trap.x;
        const dy = player.y - trap.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 20) {
            // 설치자 본인이 밟았다? -> 걸리게 함 (재미)
            player.isSlipped = true;
            player.slipStartTime = Date.now();

            // 미끄러지는 방향 (현재 이동 방향 or 랜덤)
            let slipDir = { x: 0, y: 0 };

            // 봇일 경우
            if (player instanceof Bot) {
                slipDir = { ...player.moveDir };
                if (slipDir.x === 0 && slipDir.y === 0) {
                    slipDir.x = Math.random() < 0.5 ? 1 : -1;
                }
                player.slipDir = slipDir;
            } else {
                // 플레이어: 클라이언트에 알림
                io.to(playerId).emit('playerSlipped', { duration: 10000 });
            }

            delete traps[trapId];
            io.emit('updateTraps', traps);
            io.emit('gameMessage', `[${player.nickname}] 님이 바나나를 밟았습니다! 으악!`);
        }
    }
}

// 충돌(태그) 판정
function checkCollision(moverId) {
    const mover = players[moverId];
    if (!mover || !taggerId) return;

    // 내가 술래일 때만 다른 사람 잡기 체크
    if (moverId === taggerId) {
        // 0. 기절 중이면 태그 불가 (이동 로직에서 막히지만 이중 체크)
        if (mover.stunnedUntil && Date.now() < mover.stunnedUntil) return;

        for (const targetId in players) {
            if (targetId === moverId) continue;
            const target = players[targetId];

            // 1500ms 무적(재잡기 방지) 로직은 game.js client effect 위주였으나 서버도 체크 필요하다면 lastTaggerId 활용
            if (targetId === lastTaggerId) {
                // 방금 술래였던 사람은 잠깐 안전? (여기선 생략, lastTagger logic is mainly for bots)
            }

            // 거리 체크 (30px)
            const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
            if (dist < 30) {
                // 잡았다!
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

function resetGame() {
    items = {};
    traps = {};
    io.emit('updateItems', items);
    io.emit('updateTraps', traps);

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
    }
    io.emit('currentPlayers', players);

    const msg = "🔄 맵이 초기화되었습니다!";
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

function handleUseItem(socket) {
    const player = players[socket.id];
    if (player && player.hasItem) {
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
        let botId = null;
        const ids = Object.keys(players);
        for (let i = ids.length - 1; i >= 0; i--) {
            if (players[ids[i]] instanceof Bot) {
                botId = ids[i];
                break;
            }
        }

        if (botId) {
            delete players[botId];
            io.emit('disconnectPlayer', botId);
            const kickMsg = `[${player.nickname}] 님이 봇을 추방했습니다! 👋`;
            io.emit('gameMessage', kickMsg);
            io.emit('chatMessage', { nickname: 'System', message: kickMsg, playerId: 'system' });

            if (taggerId === botId) {
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

    // 맵 변경 커맨드
    if (cmd.startsWith('/map')) {
        const mapName = cmd.split(' ')[1];
        if (mapName && MAPS[mapName.toUpperCase()]) {
            currentMapName = mapName.toUpperCase();
            currentMapData = MAPS[currentMapName];

            // 모든 플레이어/봇 재배치 및 리셋
            resetGame(); // resetGame 내에서 getRandomSpawn(currentMapData) 사용됨

            io.emit('mapUpdate', currentMapData);
            const mapMsg = `🗺️ 맵이 [${currentMapName}]으로 변경되었습니다!`;
            io.emit('gameMessage', mapMsg);
            io.emit('chatMessage', { nickname: 'System', message: mapMsg, playerId: 'system' });
        } else {
            const availMaps = Object.keys(MAPS).join(', ');
            const errMsg = `존재하지 않는 맵입니다. 사용 가능: ${availMaps}`;
            socket.emit('chatMessage', { nickname: 'System', message: errMsg, playerId: 'system' });
        }
        return;
    }

    if (cmd === '/help' || cmd === '/명령어' || cmd === '/?') {
        const helpMsg = '<br>📜 <b>명령어 목록</b><br>' +
            '🤖 <b>/bot</b> : 봇 소환<br>' +
            '👋 <b>/kickbot</b> : 봇 추방<br>' +
            '🔄 <b>/reset</b> : 맵 초기화<br>' +
            '🗺️ <b>/map [이름]</b> : 맵 변경 (DEFAULT, MAZE, OPEN)<br>' +
            '👁️ <b>/fog</b> : 시야 제한 해제 (치트)';

        socket.emit('chatMessage', { nickname: 'System', message: helpMsg, playerId: 'system' });
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

// 초기 아이템
setTimeout(() => {
    spawnItem(); spawnItem();
}, 1000);

// 게임 루프 (봇 업데이트)
setInterval(() => {
    Object.keys(players).forEach(id => {
        if (players[id] instanceof Bot) {
            // [중요] 봇에게 게임 state와 callback 전달
            players[id].update(players, taggerId, lastTaggerId, {
                handleItemEffect: handleItemEffect
            }, currentMapData);

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
