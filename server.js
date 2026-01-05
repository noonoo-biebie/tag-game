const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server);


// [모듈 임포트]
const { TILE_SIZE, MAPS, BOT_PERSONALITIES, ITEM_TYPES } = require('./config');
const { getRandomSpawn, checkBotWallCollision, generateBackrooms, generateMazeBig, generateOffice } = require('./utils');
const Bot = require('./bot');

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(__dirname + '/index.html');
});

// [Service] Keep-Alive Ping Endpoint
app.get('/ping', (req, res) => {
    res.status(200).send('pong');
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
// [통계 변수 추가]
let gameStartTime = 0;
let initialHostIds = []; // [수정] 다중 숙주 지원
let zombieSpawnTimer = null; // [버그 수정] 좀비 스폰 타이머 전역 관리

// [BOMB MODE Variables]
let bombHolderId = null;
let bombEndTime = 0;
let bombPassCooldown = 0; // 폭탄 전달 후 쿨타임 (핑퐁 방지)
let bombDurationOverride = null; // [User Config] 폭탄 타이머 고정 값 (초)

// --- 아이템 시스템 ---
let items = {};
let itemNextId = 1;

function spawnItem() {
    // [수정] 맵 크기에 따른 아이템 최대 개수 (동적 제한)
    const mapSize = currentMapData.length * currentMapData[0].length;
    // 타일 300개당 1개, 최소 5개, 최대 50개
    const maxItems = Math.min(50, Math.max(5, Math.floor(mapSize / 300)));

    if (Object.keys(items).length >= maxItems) {
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
    if (player.isZombie) return; // 좀비는 아이템 획득 불가
    if (player.isSpectator) return; // [추가] 관전자 아이템 획득 불가

    // [수정] 이미 아이템이 있어도 새로운 아이템 획득 가능 (교체)

    for (const itemId in items) {
        const item = items[itemId];
        const dx = player.x - item.x;
        const dy = player.y - item.y;
        const dist = Math.sqrt(dx * dx + dy * dy);

        if (dist < 30) {
            // [버그 수정] 실드 사용 중 아이템 획득 시 실드 해제
            if (player.hasShield) {
                player.hasShield = false;
                io.to(playerId).emit('itemEffect', { type: 'shield', on: false });
                io.emit('gameMessage', `[${player.nickname}] 님의 방어막이 새 아이템 획득으로 사라졌습니다.`);
            }

            // 기존 아이템이 있다면 덮어쓰기됨
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
        if (player.isSpectator) return; // [추가] 관전자 트랩 무시

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

    // 관전자는 충돌 무시
    if (mover.isSpectator) return;

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
        // [수정] 기절한 상태라면 감염 활동 불가 (연쇄 감염 방지)
        if (mover.stunnedUntil && Date.now() < mover.stunnedUntil) return;

        const zombieColors = ['#2ecc71', '#27ae60', '#00b894', '#55efc4', '#16a085'];

        // 좀비 모드 충돌 판정 (쌍방향 체크)
        for (const targetId in players) {
            if (targetId === moverId) continue;
            const target = players[targetId];

            // [추가] 관전자 상호작용 완전 차단 (나 또는 상대방이 관전자면 패스)
            if (mover.isSpectator || target.isSpectator) continue;

            const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
            const collisionDist = (gameMode === 'ZOMBIE') ? 30 : 32;

            if (dist < collisionDist) {
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
                    // [버그 수정] 좀비가 기절(쿨타임) 상태면 감염시키지 않음 (연쇄 감염 방지)
                    if (zombie.stunnedUntil && Date.now() < zombie.stunnedUntil) continue;

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

                    // [수정] 감염 시 닉네임 변경 (봇/플레이어 공통)
                    if (human instanceof Bot) {
                        human.nickname = human.nickname.replace('🤖', '🧟');
                        // 이름 변경: Bot_ -> Zom_
                        if (human.nickname.includes('Bot_')) {
                            human.nickname = human.nickname.replace('Bot_', 'Zom_');
                        }
                    } else {
                        // 플레이어: 닉네임 앞에 🧟 강제 부착
                        if (!human.nickname.startsWith('🧟 ')) {
                            human.nickname = '🧟 ' + human.nickname;
                        }
                    }

                    // [통계] 감염 기록
                    if (zombie.stats) zombie.stats.infectionCount++;
                    if (human.stats) human.stats.survivalTime = Date.now() - gameStartTime;

                    // [추가] 감염 직후 2초 기절 (연쇄 감염 방지)
                    human.stunnedUntil = Date.now() + 2000;

                    // [추가] 공격한 좀비도 0.5초 경직 (마구잡이 사냥 방지)
                    zombie.stunnedUntil = Date.now() + 500;

                    io.emit('playerMoved', human);
                    io.emit('playerMoved', zombie);
                    io.emit('gameMessage', `🧟 [${human.nickname}] 님이 좀비에게 감염되었습니다!`);

                    const zombieId = (zombie === mover) ? moverId : targetId;
                    checkZombieWin(); // [버그 수정] 감염 시 승리 조건 체크
                }
            }
        }
    } else if (gameMode === 'BOMB') {
        const bombColors = ['#e74c3c', '#d35400', '#c0392b'];

        for (const targetId in players) {
            if (targetId === moverId) continue;
            const target = players[targetId];

            // 관전자, 기절 상태, 좀비(?) 등 제외
            if (target.isSpectator) continue;
            if (target.stunnedUntil && Date.now() < target.stunnedUntil) continue;
            if (mover.stunnedUntil && Date.now() < mover.stunnedUntil) continue;

            const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
            if (dist < 40) { // [수정] 판정 범위 30 -> 40
                // 폭탄 전달 로직
                // 폭탄 전달 로직
                // 조건: 둘 중 하나가 폭탄을 가지고 있고, 쿨타임이 지났어야 함
                if (Date.now() < bombPassCooldown) continue;

                let sender = null;
                let receiver = null;

                if (moverId === bombHolderId) { sender = mover; receiver = target; }
                else if (targetId === bombHolderId) { sender = target; receiver = mover; }

                if (sender && receiver) {
                    // [추가] 실드 체크 (폭탄 방어)
                    if (receiver.hasShield) {
                        receiver.hasShield = false;
                        io.to(receiver.playerId).emit('itemEffect', { type: 'shield', on: false });
                        io.emit('gameMessage', `🛡️ [${receiver.nickname}] 님이 방어막으로 폭탄을 막았습니다!`);

                        // 공격자(폭탄 홀더) 1초 기절 (페널티)
                        sender.stunnedUntil = Date.now() + 1000;
                        bombPassCooldown = Date.now() + 1000; // 쿨타임도 적용하여 연타 방지
                        return;
                    }

                    // 전달!
                    bombHolderId = receiver.playerId;
                    bombPassCooldown = Date.now() + 1000; // 1초 쿨타임

                    // [추가] 폭탄 받은 사람은 2초간 기절 (도망칠 시간 부여)
                    receiver.stunnedUntil = Date.now() + 2000;

                    // 시각 효과
                    io.emit('gameMessage', `💣 [${sender.nickname}] -> [${receiver.nickname}] 폭탄 전달! (2초 기절)`);

                    // [버그 수정] 상태 변경(기절)을 즉시 클라이언트에 알림
                    io.emit('playerMoved', receiver);
                    io.emit('playerMoved', sender);

                    io.emit('updateTagger', bombHolderId); // 폭탄 소유자 변경 알림

                    // [추가] 폭탄 전달 이벤트 (클라이언트 시각 효과용: 화면 흔들림, 소리 등)
                    io.emit('bombPassed', { senderId: sender.playerId, receiverId: receiver.playerId });

                    io.emit('updateTagger', bombHolderId); // 클라이언트에서 이펙트 처리 (taggerId 재활용)
                    return; // 한 명하고만 상호작용
                }
            }
        }
    }
}

function checkZombieWin() {
    const ids = Object.keys(players);
    const survivors = ids.filter(id => !players[id].isZombie);
    const zombies = ids.filter(id => players[id].isZombie);

    // 좀비 승리 조건: 생존자 0명 (단, 플레이어가 1명 이상일 때)
    if (survivors.length === 0 && ids.length > 0) {
        // [통계 집계]
        let mvpSurvivor = null; // 생존왕
        let mvpRunner = null;   // 도망자
        let mvpInfector = null; // 슈퍼 전파자
        let hostName = 'Unknown';

        // 1. 생존왕 (Survival Time - infected time)
        const sortedSurvivors = [...ids].sort((a, b) => ((players[b].stats?.survivalTime || 0) - (players[a].stats?.survivalTime || 0)));
        if (sortedSurvivors.length > 0) mvpSurvivor = players[sortedSurvivors[0]];

        // 2. 도망자 (Distance - human state only)
        const sortedRunners = [...ids].sort((a, b) => ((players[b].stats?.distance || 0) - (players[a].stats?.distance || 0)));
        if (sortedRunners.length > 0) mvpRunner = players[sortedRunners[0]];

        // 3. 슈퍼 전파자 (Infection Count)
        const sortedInfectors = [...zombies].sort((a, b) => ((players[b].stats?.infectionCount || 0) - (players[a].stats?.infectionCount || 0)));
        if (sortedInfectors.length > 0) mvpInfector = players[sortedInfectors[0]];

        // 4. 숙주
        if (initialHostIds.length > 0) {
            hostName = initialHostIds.map(hid => players[hid] ? players[hid].nickname : "나간 플레이어").join(", ");
        }

        const resultData = {
            winner: 'zombies', // [추가] 승자 타입
            survivor: mvpSurvivor ? { name: mvpSurvivor.nickname, val: ((mvpSurvivor.stats?.survivalTime || 0) / 1000).toFixed(1) + '초' } : { name: '-', val: '-' },
            runner: mvpRunner ? { name: mvpRunner.nickname, val: Math.floor(mvpRunner.stats?.distance || 0) + 'px' } : { name: '-', val: '-' },
            infector: mvpInfector ? { name: mvpInfector.nickname, val: (mvpInfector.stats?.infectionCount || 0) + '명' } : { name: '-', val: '-' },
            host: hostName
        };

        io.emit('gameMessage', `🧟 인류 멸망! 좀비 승리! 결과판을 확인하세요.`);
        io.emit('gameResult', resultData);

        // 타이머 중지 및 리셋 예약
        if (roundTimer) clearInterval(roundTimer);
        setTimeout(() => resetGame(), 10000);

    } else if (survivors.length > 0 && ids.length > 0) {
        // 생존자 수 알림용 (필요시)
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
                // [생존자 승리]
                io.emit('gameMessage', '🎉 생존자 승리! 2분 30초 동안 버텨냈습니다! 🎉');

                // 통계 및 명단 집계
                const ids = Object.keys(players);
                const survivors = ids.filter(id => !players[id].isZombie);
                const survivorNames = survivors.map(id => players[id].nickname);

                // MVP 계산 (도망자, 슈퍼전파자 등도 궁금할 수 있으니)
                const zombies = ids.filter(id => players[id].isZombie);

                let mvpRunner = null;   // 도망자
                let mvpInfector = null; // 슈퍼 전파자
                let hostName = 'Unknown';
                if (initialHostIds.length > 0) {
                    hostName = initialHostIds.map(hid => players[hid] ? players[hid].nickname : "나간 플레이어").join(", ");
                }

                const sortedRunners = [...ids].sort((a, b) => ((players[b].stats?.distance || 0) - (players[a].stats?.distance || 0)));
                if (sortedRunners.length > 0) mvpRunner = players[sortedRunners[0]];

                const sortedInfectors = [...zombies].sort((a, b) => ((players[b].stats?.infectionCount || 0) - (players[a].stats?.infectionCount || 0)));
                if (sortedInfectors.length > 0) mvpInfector = players[sortedInfectors[0]];

                const resultData = {
                    winner: 'survivors', // 승자 타입
                    survivorList: survivorNames,
                    runner: mvpRunner ? { name: mvpRunner.nickname, val: Math.floor(mvpRunner.stats?.distance || 0) + 'px' } : { name: '-', val: '-' },
                    infector: mvpInfector ? { name: mvpInfector.nickname, val: (mvpInfector.stats?.infectionCount || 0) + '명' } : { name: '-', val: '-' },
                    host: hostName
                };

                io.emit('gameResult', resultData);

                // 10초 후 리셋
                setTimeout(() => resetGame(), 10000);
            }
        }
    }, 1000);
}

// 봇 생성
function createBot() {
    // [버그 수정] Date.now() 중복 방지를 위해 난수 추가
    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    const bot = new Bot(botId, currentMapData);

    // [통계] 봇 통계 초기화
    bot.stats = { distance: 0, infectionCount: 0, survivalTime: 0 };

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
    let timeLeft = 15; // [수정] 15초로 증가
    const countdownMsg = (sec) => `⏳ ${sec}초 뒤에 좀비 바이러스가 퍼집니다!`;

    io.emit('gameMessage', countdownMsg(timeLeft));
    io.emit('chatMessage', { nickname: 'System', message: countdownMsg(timeLeft), playerId: 'system' });

    io.emit('chatMessage', { nickname: 'System', message: countdownMsg(timeLeft), playerId: 'system' });

    if (zombieSpawnTimer) clearInterval(zombieSpawnTimer);
    zombieSpawnTimer = setInterval(() => {
        if (gameMode !== 'ZOMBIE') {
            clearInterval(zombieSpawnTimer);
            return;
        }

        timeLeft--;
        if (timeLeft > 0) {
            io.emit('gameMessage', countdownMsg(timeLeft));
        } else {
            clearInterval(zombieSpawnTimer);

            // 감염 시작
            const ids = Object.keys(players);
            if (ids.length > 0) {
                // [수정] 숙주 수 밸런스 조정 (1/32/64)
                let targetCount = 1;
                const totalPlayers = ids.length;
                if (totalPlayers >= 64) targetCount = 3;
                else if (totalPlayers >= 32) targetCount = 2;

                // 셔플 알고리즘으로 랜덤 2명 뽑기
                const shuffled = ids.sort(() => 0.5 - Math.random());
                const selectedIds = shuffled.slice(0, targetCount);

                gameStartTime = Date.now();
                initialHostIds = [];

                selectedIds.forEach(hostId => {
                    const host = players[hostId];
                    if (host && !host.isZombie) {
                        initialHostIds.push(hostId);

                        host.isZombie = true;
                        host.originalColor = host.color;
                        host.color = '#2ecc71';

                        // [수정] 숙주 닉네임 변경 (봇/플레이어 공통)
                        if (host instanceof Bot) {
                            host.nickname = host.nickname.replace('🤖', '🧟');
                            if (host.nickname.includes('Bot_')) {
                                host.nickname = host.nickname.replace('Bot_', 'Zom_');
                            }
                        } else {
                            if (!host.nickname.startsWith('🧟 ')) {
                                host.nickname = '🧟 ' + host.nickname;
                            }
                        }

                        io.emit('playerMoved', host);
                        io.emit('gameMessage', `🧟 [${host.nickname}] 님이 숙주 좀비가 되었습니다!! (총 ${targetCount}명)`);
                        io.emit('zombieInfect', { targetId: hostId });
                    }
                });

                // [수정] 2분 30초 (150초) 타이머 시작
                startRoundTimer(150);
            }
        }
    }, 1000);
}

function resetGame() {
    if (roundTimer) clearInterval(roundTimer);
    // [버그 수정] 진행 중인 좀비 카운트다운 취소
    if (zombieSpawnTimer) {
        clearInterval(zombieSpawnTimer);
        zombieSpawnTimer = null;
    }
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

    // [BOMB] 초기화
    bombHolderId = null;
    bombEndTime = 0;
    bombPassCooldown = 0;
    bombEliminationOrder = []; // [추가] 탈락자 기록 초기화


    // [수정] 봇 초기화 (완전 재소환)
    // 좀비 상태나 이름이 꼬이는 문제를 방지하기 위해 기존 봇을 모두 삭제하고 새로 생성
    let botCount = 0;
    Object.keys(players).forEach(id => {
        if (players[id] instanceof Bot) {
            botCount++;
            delete players[id];
            io.emit('disconnectPlayer', id);
        }
    });

    // 플레이어 재배치 (봇은 제외됨)
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

        // [수정] 닉네임 복구 (🧟 접두사 제거)
        if (p.nickname && p.nickname.startsWith('🧟 ')) {
            p.nickname = p.nickname.replace('🧟 ', '');
        }

        // [BOMB] 관전 모드 해제 (단, 수동 관전자는 제외)
        if (!p.isManualSpectator) {
            p.isSpectator = false;
            // [수정] 색상 복구 (폭탄 모드 탈락 등에서 변한 색상 원복)
            // originalColor가 없으면 initialColor, 그것도 없으면 기본값
            if (p.originalColor) p.color = p.originalColor;
            else if (p.initialColor) p.color = p.initialColor;
            else p.color = '#e74c3c'; // Fallback
        } else {
            p.color = 'rgba(255, 255, 255, 0.3)'; // 관전자 색상 유지
        }

        // [통계] 초기화
        p.stats = { distance: 0, infectionCount: 0, survivalTime: 0 };

        // [추가] 클라이언트 인벤토리 초기화 이벤트 전송
        io.to(id).emit('updateInventory', null);
    }

    // [통계] 전역 변수 초기화
    gameStartTime = 0;
    initialHostId = null;

    // 봇 다시 소환
    for (let i = 0; i < botCount; i++) {
        createBot();
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
    } else if (gameMode === 'BOMB') {
        taggerId = null;
        startBombRound();
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
    // [추가] 접속 시 현재 플레이어 수 전달 (봇 제외)
    socket.emit('playerCountUpdate', Object.values(players).filter(p => !(p instanceof Bot)).length);
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



function handleJoinGame(socket, data) {
    if (players[socket.id]) return;

    console.log('게임 입장:', data.nickname);

    const spawnPos = getRandomSpawn(currentMapData);
    let initialColor = data.color || '#e74c3c';
    const realOriginalColor = initialColor; // [버그 수정] 난입 시 색상 변조 전 원본 저장
    let isZombieStart = false;

    // [난입 로직] 게임 중 난입 시 역할 자동 할당
    let isSpectator = false; // [추가] 관전자 플래그
    let joinMsg = null;

    if (gameMode === 'ZOMBIE') {
        // 좀비 모드에서 난입하면 좀비로 시작
        isZombieStart = true;
        const zombieColors = ['#2ecc71', '#27ae60', '#00b894', '#55efc4', '#16a085'];
        initialColor = zombieColors[Math.floor(Math.random() * zombieColors.length)];
    } else if (gameMode === 'BOMB' && bombEndTime > 0) {
        // [폭탄 모드] 진행 중 난입 시 관전자
        isSpectator = true;
        initialColor = 'rgba(255, 255, 255, 0.3)';
        joinMsg = "💣 폭탄 모드 진행 중이라 관전자로 입장합니다.";
    } else {
        // 태그 모드에서 난입하면 생존자(혹은 술래 없음 상태)
        isZombieStart = false;
    }

    players[socket.id] = {
        x: spawnPos.x,
        y: spawnPos.y,
        playerId: socket.id,
        color: initialColor,
        initialColor: initialColor, // 현재 상태의 초기 색상
        originalColor: realOriginalColor, // [버그 수정] 리셋 시 복구할 진짜 색상
        nickname: data.nickname || '익명',
        isZombie: isZombieStart,
        isSpectator: isSpectator, // [추가]
        stats: { distance: 0, infectionCount: 0, survivalTime: 0 }
    };

    if (joinMsg) {
        socket.emit('gameMessage', joinMsg);
        socket.emit('chatMessage', { nickname: 'System', message: joinMsg, playerId: 'system' });
    }

    if (!taggerId && !isSpectator) { // 관전자는 술래 아님
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
    // [추가] 접속자 수 갱신 브로드캐스트
    // [추가] 접속자 수 갱신 브로드캐스트 (봇 제외)
    const realUserCount = Object.values(players).filter(p => !(p instanceof Bot)).length;
    io.emit('playerCountUpdate', realUserCount);
}

function handlePlayerMove(socket, movementData) {
    // [기절 체크]
    if (players[socket.id] && players[socket.id].stunnedUntil && Date.now() < players[socket.id].stunnedUntil) {
        return;
    }

    const player = players[socket.id];
    if (player) {
        // [통계] 인간 상태일 때 이동 거리 누적
        if (!player.isZombie && player.stats) {
            const dx = movementData.x - player.x;
            const dy = movementData.y - player.y;
            player.stats.distance += Math.hypot(dx, dy);
        }

        player.x = movementData.x;
        player.y = movementData.y;
        io.emit('playerMoved', player);
        checkCollision(socket.id);
        checkItemCollection(socket.id);
        checkTrapCollision(socket.id);
    }
}

// [추가] 아이템 획득 체크
function handleUseItem(socket) {
    const player = players[socket.id];
    if (!player) return;
    if (player.isZombie) return;
    if (player.isSpectator) return; // [추가] 관전자 사용 불가

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
        const realUserCount = Object.values(players).filter(p => !(p instanceof Bot)).length;
        io.emit('playerCountUpdate', realUserCount);

        // [버그 수정] 좀비 모드에서 생존자가 나갈 경우 승리 판정 체크
        if (gameMode === 'ZOMBIE') checkZombieWin();

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

    if (cmd.startsWith('/bot') || cmd.startsWith('/addbot')) {
        const parts = cmd.split(' ');
        let count = 1;
        if (parts.length > 1) {
            count = parseInt(parts[1]);
            if (isNaN(count) || count < 1) count = 1;
            if (count > 50) count = 50; // Max 50
        }

        let spawnedCount = 0;
        for (let i = 0; i < count; i++) {
            // createBot 함수가 있다면 사용, 아니면 인라인
            // 안전하게 인라인으로 구현 (ID 충돌 방지)
            const botId = 'bot_' + Date.now() + '_' + Math.floor(Math.random() * 10000) + '_' + i;
            const bot = new Bot(botId, currentMapData);
            players[bot.id] = bot;
            spawnedCount++;
        }

        const infoMsg = `[System] 봇 ${spawnedCount}마리를 소환했습니다! 🤖`;
        io.emit('gameMessage', infoMsg);
        io.emit('chatMessage', { nickname: 'System', message: infoMsg, playerId: 'system' });
        // 접속자 수 갱신 (봇 제외)
        const realUserCount = Object.values(players).filter(p => !(p instanceof Bot)).length;
        io.emit('playerCountUpdate', realUserCount);
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



        } else if (mode === 'bomb') {
            // [추가] 인원 체크 (혼자서는 폭탄 모드 실행 불가 - 버그 방지)
            if (Object.keys(players).length < 2) {
                socket.emit('chatMessage', {
                    nickname: 'System',
                    message: "🚫 혼자서는 폭탄 모드를 플레이할 수 없습니다! /bot 명령어로 봇을 추가해주세요.",
                    playerId: 'system'
                });
                return;
            }

            gameMode = 'BOMB';

            // (Pending grep search result)] 타이머 설정 (숫자 입력 시)
            if (parts[2]) {
                const duration = parseInt(parts[2]);
                if (!isNaN(duration) && duration > 0) {
                    bombDurationOverride = duration;
                    const msg = `⚙️ 폭탄 타이머가 ${duration}초로 설정되었습니다.`;
                    io.emit('gameMessage', msg);
                    io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' });
                }
            } else {
                bombDurationOverride = null; // 초기화 (기본값 사용)
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
            '👻 <b>/spec</b> : 관전 모드 토글 (테스트용)<br>' +
            '🎁 <b>/item [이름]</b> : 아이템 획득 (banana, speed, shield)<br>' +
            '🗺️ <b>/map [이름]</b> : 맵 변경<br>' +
            '👁️ <b>/fog</b> : 시야 제한 해제 (치트)';

        socket.emit('chatMessage', { nickname: 'System', message: helpMsg, playerId: 'system' });
        return;
    }

    // [추가] 관전 모드 토글 (/spec)
    if (cmd === '/spec' || cmd === '/spectator') {
        player.isManualSpectator = !player.isManualSpectator;
        player.isSpectator = player.isManualSpectator;

        if (player.isSpectator) {
            // 관전 진입
            player.color = 'rgba(255, 255, 255, 0.3)';
            player.hasItem = null;
            player.hasShield = false;

            // 만약 술래였다면 권한 이양
            if (taggerId === socket.id || bombHolderId === socket.id) {
                const remaining = Object.keys(players).filter(id => id !== socket.id && !players[id].isSpectator);
                let nextId = null;
                if (remaining.length > 0) {
                    nextId = remaining[Math.floor(Math.random() * remaining.length)];
                }

                if (gameMode === 'BOMB' && bombHolderId === socket.id) {
                    bombHolderId = nextId;
                    io.emit('updateTagger', bombHolderId);
                } else if (taggerId === socket.id) {
                    taggerId = nextId;
                    io.emit('updateTagger', taggerId);
                    if (nextId) io.emit('gameMessage', `술래가 관전 모드로 전환하여 [${players[nextId].nickname}] 님이 술래가 됩니다.`);
                }
            }

            io.emit('gameMessage', `👻 [${player.nickname}] 님이 관전 모드로 전환했습니다.`);
        } else {
            // 관전 해제 (복귀)
            player.color = player.initialColor || '#e74c3c';
            player.isZombie = false; // 기본 인간으로 복귀
            if (player.nickname.startsWith('🧟 ')) player.nickname = player.nickname.replace('🧟 ', '');

            io.emit('gameMessage', `🙂 [${player.nickname}] 님이 게임에 복귀했습니다.`);
        }

        io.emit('playerMoved', player);
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

// [수정] 아이템 자동 관리 루프 (5초마다)
setInterval(() => {
    // 맵 크기 기반 목표 개수
    const mapSize = currentMapData.length * currentMapData[0].length;
    const maxItems = Math.min(50, Math.max(5, Math.floor(mapSize / 300)));

    // 부족하면 스폰
    if (Object.keys(items).length < maxItems) {
        spawnItem();
        // io.emit('gameMessage', `🎁 선물 상자가 나타났습니다!`); // 너무 자주 뜨면 시끄러우니 제거 or 조건부
    }
}, 5000);

// 초기 아이템 및 테스트 바나나
setTimeout(() => {
    spawnItem(); spawnItem();


}, 1000);

// 게임 루프 (봇 업데이트)
setInterval(() => {
    Object.keys(players).forEach(id => {
        if (players[id] instanceof Bot) {
            // [중요] 봇에게 게임 state와 callback 전달
            // gameMode 추가 전달 (BOMB 모드면 bombHolderId를 술래로 취급)
            const currentTaggerId = (gameMode === 'BOMB') ? bombHolderId : taggerId;

            players[id].update(players, currentTaggerId, lastTaggerId, {
                handleItemEffect: handleItemEffect
            }, currentMapData, gameMode);

            // 동기화
            io.emit('playerMoved', players[id]);
            checkCollision(id);
            checkItemCollection(id);
            checkTrapCollision(id);
        }
    });

    // [BOMB] 게임 루프
    if (gameMode === 'BOMB') {
        updateBombGame();
    }
}, 100);

// [BOMB MODE Functions]
let bombEliminationOrder = []; // [추가] 탈락 순서 기록 (Silver, Bronze 결정용)

function startBombRound() {
    const ids = Object.keys(players);
    // 생존자만 필터링
    const survivors = ids.filter(id => !players[id].isSpectator);

    if (survivors.length <= 1) {
        // 게임 종료 (1명 남음)
        // updateBombGame에서 승리 처리하므로 여기선 패스하거나 리셋
        return;
    }

    // 새 폭탄 라운드 시작
    // 5초 대기 후 시작 (긴장감 및 거리 확보)

    io.emit('gameMessage', `⏳ 5초 뒤 폭탄이 감지됩니다! 흩어지세요!`);

    // [버그 수정] 시작 시 이전 폭탄 잔상 제거 (혹시 모를 초기화)
    bombHolderId = null;
    io.emit('updateTagger', null);

    setTimeout(() => {
        // 다시 확인
        const currentSurvivors = Object.keys(players).filter(id => !players[id].isSpectator);
        if (currentSurvivors.length <= 1) return;

        const holderId = currentSurvivors[Math.floor(Math.random() * currentSurvivors.length)];
        bombHolderId = holderId;

        // 타이머: 설정값 or 30~40초 랜덤 (기본값 상향)
        let duration = 0;
        if (bombDurationOverride) {
            duration = bombDurationOverride;
        } else {
            duration = Math.floor(Math.random() * 11) + 20; // 20 ~ 30
        }

        bombEndTime = Date.now() + (duration * 1000);
        bombPassCooldown = 0;

        io.emit('updateTagger', bombHolderId); // 홀더 표시 (빨간 테두리)

        // 메시지 차별화
        if (bombDurationOverride) {
            io.emit('gameMessage', `💣 [${players[holderId].nickname}] 폭탄 점화! (설정값: ${duration}초)`);
            io.emit('chatMessage', { nickname: 'System', message: `💣 폭탄 시작! (${duration}초 고정)`, playerId: 'system' });
        } else {
            io.emit('gameMessage', `💣 [${players[holderId].nickname}] 폭탄 점화! (20~30초 랜덤)`);
            io.emit('chatMessage', { nickname: 'System', message: `💣 폭탄 시작! (???초)`, playerId: 'system' });
        }

        // 타이머 정보를 클라에 보낼 수도 있지만 "숨김"이 컨셉.
        // 대신 째깍거리는 소리나 비주얼 큐는 나중에 game.js에서 처리.
        io.emit('bombStart', { duration: duration, startTime: Date.now() }); // 클라에서 붉은 효과용
    }, 3000);
}

function updateBombGame() {
    if (!bombHolderId) return; // 라운드 진행 중 아님
    if (bombEndTime === 0) return;

    // console.log(`[BombDebug] Holder: ${players[bombHolderId]?.nickname}, TimeLeft: ${(bombEndTime - Date.now())/1000}s`);

    // 1. 폭발 체크
    if (Date.now() >= bombEndTime) {
        // BOOM!
        const loser = players[bombHolderId];
        if (loser) {
            loser.isSpectator = true;
            loser.hasShield = false;
            loser.color = 'rgba(255,255,255,0.3)'; // 반투명 (게임 로직상 처리 필요, 여기선 값만)


            io.emit('playerMoved', loser); // 상태 전파
            io.emit('gameMessage', `💥 콰쾅! [${loser.nickname}] 탈락!`);
            io.emit('bombExploded', { loserId: bombHolderId }); // 클라 효과 (폭발 파티클)

            // [추가] 탈락자 명단 기록 (나중에 2,3등 표시용)
            bombEliminationOrder.push(loser);

            bombHolderId = null;
            bombEndTime = 0;

            // 남은 생존자 확인
            const survivors = Object.keys(players).filter(id => !players[id].isSpectator);

            if (survivors.length === 1) {
                // 우승!

                const winner = players[survivors[0]];
                io.emit('gameMessage', `🏆 [${winner.nickname}] 최종 우승! 축하합니다!`);

                // [수정] 폭탄 모드 전용 결과 데이터 전송
                // 1위: winner
                // 2위: 마지막 탈락자
                // 3위: 그 전 탈락자
                const silver = bombEliminationOrder[bombEliminationOrder.length - 1];
                const bronze = bombEliminationOrder[bombEliminationOrder.length - 2];

                const resultData = {
                    type: 'BOMB', // 클라이언트 분기용
                    ranks: [
                        winner.nickname,
                        silver ? silver.nickname : '-',
                        bronze ? bronze.nickname : '-'
                    ]
                };
                io.emit('gameResult', resultData);
                setTimeout(() => resetGame(), 10000);
            } else if (survivors.length === 0) {
                // 모두 멸망? (동시 폭사 등)
                io.emit('gameMessage', `💀 생존자가 없습니다... 게임 오버.`);
                setTimeout(() => resetGame(), 5000);
            } else {
                // 다음 라운드 진행
                io.emit('gameMessage', `생존자 ${survivors.length}명 남았습니다. 다음 라운드 준비...`);
                startBombRound();
            }
        } else {
            // 홀더가 나갔거나 삭제됨
            bombHolderId = null;
            startBombRound(); // 재시작
        }
    }
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`서버 실행: http://localhost:${PORT}`);
});
