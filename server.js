const express = require('express');
const app = express();
const http = require('http');
const server = http.createServer(app);
const { Server } = require("socket.io");
const io = new Server(server, {
    cors: {
        origin: "*",
        methods: ["GET", "POST"]
    }
});

// [Safety] Global Error Handler
process.on('uncaughtException', (err) => {
    console.error('🔥 [CRITICAL] Uncaught Exception:', err);
});


// [모듈 임포트]
const {
    PORT,
    ROWS,
    COLS,
    TILE_IDS,
    ITEM_TYPES,
    COLORS,
    PLAYER_SPEED,
    SERVER_TICK_RATE,
    WS_TICK_RATE,
    ITEM_SPAWN_INTERVAL,
    MAP_SIZES // [추가]
} = require('./config');

const mapLoader = require('./map_loader'); // [변경] 전체 모듈 가져오기
const MAPS_MODULE = mapLoader.loadMaps(); // [유지] 호환성 위해 이름 유지하되, 아래 로직에서 mapLoader 사용 권장

// [Fix] 유틸리티 함수 임포트 (누락되어 서버 크래시 발생)
const { getRandomSpawn, analyzeMapConnectivity } = require('./utils');

// [New] Socket Listener for Voting
io.on('connection', (socket) => {
    // ... 기존 연결 로직은 아래 setupSocketEvents에서 처리
    // 여기서는 투표 이벤트만 추가 (기존 game.js와 호환되게 통합 필요하지만, 편의상 여기에 리스너 추가 가능)
    // 하지만 이미 game.js에서 connect 후 emit을 하므로, setupSocketEvents 내부나 initPlayer에서 처리 권장
    // -> setupSocketEvents 함수 내부로 이동

    socket.on('vote', (candidateId) => {
        VotingManager.vote(socket.id, candidateId);
    });

    // [New] Ping System (Latency Check)
    socket.on('latency', (startTime) => {
        socket.emit('latency', startTime);
    });
});


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
// 맵 로드
// [Duplicate Removed]
console.log(`[Server] Maps loaded: ${Object.keys(MAPS_MODULE).join(', ')}`);
if (!MAPS_MODULE['DEFAULT']) {
    console.error("🔥 [CRITICAL] DEFAULT map not found in MAPS_MODULE!");
    process.exit(1);
}

let currentMapName = 'DEFAULT';
let currentMapData = MAPS_MODULE.DEFAULT.data || (MAPS_MODULE.DEFAULT.generate ? MAPS_MODULE.DEFAULT.generate() : []);

if (!currentMapData || currentMapData.length === 0) {
    console.error("🔥 [CRITICAL] DEFAULT map data is empty!");
    process.exit(1);
}

// [Redundant import removed]
// [New] 안전 스폰 좌표 캐시
let validSpawnPoints = [];
try {
    console.log("Analyzing map connectivity...");
    validSpawnPoints = analyzeMapConnectivity(currentMapData);
    console.log("Map analysis complete.");
} catch (err) {
    console.error("🔥 Map Analysis Failed:", err);
}


let gameMode = 'TAG'; // [복구] 게임 모드 변수 선언 (TAG/ZOMBIE)
// [New] 서버 상태 관리 (State Machine)
const ServerState = {
    FREE: 'FREE',       // 자유 모드 (기존 Manual)
    VOTING: 'VOTING',   // 투표 진행 중
    PLAYING: 'PLAYING', // 게임 진행 중
    RESULT: 'RESULT'    // 결과 화면 (잠시 대기)
};
let serverState = ServerState.PLAYING; // Default: Attract Mode (Playing with bots)
let previousGameSettings = null; // Replay용 이전 설정

// [New] 투표 관리자
// [New] 투표 관리자
const VotingManager = {
    candidates: [],
    votes: {}, // { socketId: candidateIndex }
    timer: null,
    duration: 10, // [Modified] 10초로 변경
    currentStage: 'MODE', // 'MODE' | 'MAP'

    startModeVoting: function () {
        if (serverState !== ServerState.VOTING) return;
        this.currentStage = 'MODE';

        // 1. 모드 후보 생성
        this.candidates = [
            { id: 'TAG', type: 'MODE', name: '🏃 술래잡기', mode: 'TAG' },
            { id: 'ZOMBIE', type: 'MODE', name: '🧟 좀비 감염', mode: 'ZOMBIE' },
            { id: 'BOMB', type: 'MODE', name: '💣 폭탄 돌리기', mode: 'BOMB' },
            { id: 'ICE', type: 'MODE', name: '❄️ 얼음땡', mode: 'ICE' }
        ];

        // Replay 옵션 (항상 마지막)
        if (previousGameSettings) {
            this.candidates.push({
                id: 'REPLAY',
                type: 'REPLAY',
                name: '🔄 이전 게임 재플레이',
                ...previousGameSettings
            });
        }

        this.startVoting("📊 게임 모드를 선택하세요!");
    },

    startMapVoting: function (selectedMode) {
        if (serverState !== ServerState.VOTING) return;
        this.currentStage = 'MAP';

        // 2. 맵 후보 생성 (랜덤 3개)
        const allMaps = Object.values(MAPS_MODULE).filter(m => !m.isTest);
        const mapCandidates = [];

        // 맵 중복 방지 로직
        const availableMaps = [...allMaps];

        for (let i = 0; i < 3; i++) {
            if (availableMaps.length === 0) break;
            const randomIndex = Math.floor(Math.random() * availableMaps.length);
            const map = availableMaps.splice(randomIndex, 1)[0]; // 뽑고 제거

            mapCandidates.push({
                id: i, // 0, 1, 2
                type: 'MAP',
                name: map.name,
                size: map.allowedSizes ? map.allowedSizes[map.allowedSizes.length - 1] : 'M',
                mode: selectedMode // 선택된 모드 전달
            });
        }

        this.candidates = mapCandidates;
        this.startVoting(`🗺️ [${selectedMode}] 할 맵을 선택하세요!`);
    },

    startVoting: function (title) {
        this.votes = {};
        // 클라이언트에 title도 같이 보내면 좋겠지만, 현재 프로토콜 유지
        // gameMessage로 알림
        io.emit('gameMessage', title);
        io.emit('votingStart', { candidates: this.candidates, duration: this.duration, title: title });

        let timeLeft = this.duration;
        if (this.timer) clearInterval(this.timer);
        this.timer = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                this.end();
            }
        }, 1000);
    },

    start: function () {
        // 하위 호환성 (외부 호출용) -> Mode Voting으로 시작
        this.startModeVoting();
    },

    vote: function (socketId, candidateId) {
        if (serverState !== ServerState.VOTING) return;
        this.votes[socketId] = candidateId;
        io.emit('updateVotes', this.getVoteCounts());
    },

    getVoteCounts: function () {
        const counts = {};
        Object.values(this.votes).forEach(cId => {
            counts[cId] = (counts[cId] || 0) + 1;
        });
        return counts;
    },

    end: function () {
        clearInterval(this.timer);
        this.timer = null;

        // [New] Lucky Pick Logic
        const voters = Object.keys(this.votes);
        let winnerCandidate = null;
        let luckyVoter = null;

        if (voters.length > 0) {
            // 투표한 사람 중 한 명을 랜덤 추첨 (민주주의 + 운)
            const winnerSocketId = voters[Math.floor(Math.random() * voters.length)];
            const winnerChoiceId = this.votes[winnerSocketId];
            winnerCandidate = this.candidates.find(c => c.id == winnerChoiceId); // type mismatch 방지 (==)
            luckyVoter = players[winnerSocketId] ? players[winnerSocketId].nickname : 'Unknown';
        } else {
            // 투표가 없으면 랜덤
            winnerCandidate = this.candidates[Math.floor(Math.random() * this.candidates.length)];
            luckyVoter = 'System';
        }

        if (!winnerCandidate) {
            // Fallback
            winnerCandidate = this.candidates[0];
        }

        io.emit('gameMessage', `🎯 [${luckyVoter}] 님의 선택 당첨! (${winnerCandidate.name})`);

        // 단계별 처리
        if (this.currentStage === 'MODE') {
            const selectedMode = winnerCandidate.mode || 'TAG';
            if (winnerCandidate.type === 'REPLAY') {
                // Replay는 바로 시작
                io.emit('gameMessage', `🔄 이전 게임 설정을 불러옵니다...`);
                setTimeout(() => applyGameSettings(winnerCandidate), 2000);
            } else {
                // 맵 투표로 이동
                io.emit('gameMessage', `✅ 모드 결정: ${selectedMode}. 맵 투표로 넘어갑니다.`);
                setTimeout(() => this.startMapVoting(selectedMode), 3000);
            }
        } else {
            // MAP 투표 종료 -> 게임 시작
            io.emit('gameMessage', `✅ 맵 결정: ${winnerCandidate.name}. 게임을 시작합니다!`);
            setTimeout(() => applyGameSettings(winnerCandidate), 2000);
        }
    }
};

function applyGameSettings(settings) {
    // 1. 맵 변경
    if (settings.type === 'REPLAY') {
        // Replay는 이미 settings 내부에 mapName 등이 있음
    }

    // 맵 로드 및 설정
    const mapName = settings.mapName || settings.name;
    const size = settings.size || 'M';

    const nextMap = mapLoader.getMap(mapName);
    if (nextMap) {
        currentMapName = nextMap.name;
        // 크기 설정 (M 사이즈 기준 예시)
        let { width, height } = MAP_SIZES[size] || MAP_SIZES['M'];
        if (currentMapName === 'SPEEDWAY') { width = 40; height = 40; }

        if (typeof nextMap.generate === 'function') {
            currentMapData = nextMap.generate(height, width);
        } else {
            currentMapData = JSON.parse(JSON.stringify(nextMap.data));
        }

        // Settings 저장 (다음 Replay용)
        previousGameSettings = { mapName: currentMapName, size: size, mode: settings.mode };

        io.emit('mapUpdate', currentMapData);

        // 모드 변경
        gameMode = settings.mode || 'TAG';
        if (gameMode === 'TAG') resetGame(); // resetGame 내부에서 state 변경
        else if (gameMode === 'ZOMBIE') { /* 좀비 초기화 로직 */ resetGame(); }
        // ... 모드별 로직

        // ResetGame이 state를 Free로 둘 수 있으므로 강제 PLAYING
        serverState = ServerState.PLAYING;
        io.emit('votingEnd', { nextMap: currentMapName, mode: gameMode });
    }
}

let roundTime = 0;
let roundTimer = null;
// [통계 변수 추가]
let gameStartTime = 0;
let initialHostIds = []; // [수정] 다중 숙주 지원
let zombieSpawnTimer = null; // [버그 수정] 좀비 스폰 타이머 전역 관리
let gameLoop = null; // 게임 루프 타이머
let iceCountdownTimer = null; // [New] 얼음땡 카운트다운 타이머

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

    if (Object.keys(items).length >= maxItems) {
        // 가장 오래된 아이템 삭제
        const oldestId = Object.keys(items).sort((a, b) => a - b)[0];
        delete items[oldestId];
    }

    const pos = getRandomSpawn(currentMapData, validSpawnPoints);
    const id = itemNextId++;


    let availableTypes = ITEM_TYPES;
    // [New] 얼음땡 모드에서는 실드 제외 (밸런스)
    if (gameMode === 'ICE') {
        availableTypes = availableTypes.filter(t => t !== 'shield');
    }

    const type = availableTypes[Math.floor(Math.random() * availableTypes.length)];

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
    if (!player) return;
    if (player.isZombie) return; // 좀비는 아이템 획득 불가
    if (player.isSpectator) return; // [추가] 관전자 아이템 획득 불가
    // [Refinement] 얼음땡 모드: 도망자는 맵 아이템 획득 불가
    if (gameMode === 'ICE' && playerId !== taggerId) return;

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

// [New] 타일 상호작용 (용암 등)
function checkTileInteraction(playerId) {
    try {
        const player = players[playerId];
        if (!player) return;
        if (player.isSpectator) return; // 관전자는 무적

        // 현재 맵 데이터 확인
        if (!currentMapData || !currentMapData.length) return;

        // [Enhanced] 4점 + 중심점 체크 (더 민감하게 반응)
        const TILE_SIZE = 32;
        const padding = 10; // 안쪽으로 10px 들어온 지점 체크

        const checkPoints = [
            { x: player.x + 16, y: player.y + 16 }, // Center
            { x: player.x + padding, y: player.y + 16 }, // Left
            { x: player.x + 32 - padding, y: player.y + 16 }, // Right
            { x: player.x + 16, y: player.y + padding }, // Top
            { x: player.x + 16, y: player.y + 32 - padding } // Bottom
        ];

        let touchedLava = false;

        for (const p of checkPoints) {
            const c = Math.floor(p.x / TILE_SIZE);
            const r = Math.floor(p.y / TILE_SIZE);

            if (r >= 0 && r < currentMapData.length && c >= 0 && c < currentMapData[0].length) {
                if (currentMapData[r][c] === 4) {
                    touchedLava = true;
                    break;
                }
            }
        }

        if (touchedLava) {
            // 이미 기절 상태면 중복 처리 방지
            if (player.stunnedUntil && Date.now() < player.stunnedUntil) return;

            // [Knockback] 벽을 뚫지 않는 안전한 넉백 (Wall-Aware Knockback)
            if (player.lastX !== undefined && player.lastY !== undefined) {
                const dx = player.lastX - player.x;
                const dy = player.lastY - player.y;

                // 시도 1: 강력한 넉백 (5배)
                let pushFactor = 5.0;
                let targetX = player.lastX + dx * pushFactor;
                let targetY = player.lastY + dy * pushFactor;

                // 타일 판별 헬퍼 (Bounding Box Check)
                const isWall = (x, y) => {
                    const padding = 2; // 여유 공간
                    const checkPoints = [
                        { x: x + padding, y: y + padding },          // Left-Top
                        { x: x + 32 - padding, y: y + padding },     // Right-Top
                        { x: x + padding, y: y + 32 - padding },     // Left-Bottom
                        { x: x + 32 - padding, y: y + 32 - padding } // Right-Bottom
                    ];

                    for (const p of checkPoints) {
                        const c = Math.floor(p.x / TILE_SIZE);
                        const r = Math.floor(p.y / TILE_SIZE);
                        if (r >= 0 && r < currentMapData.length && c >= 0 && c < currentMapData[0].length) {
                            if (currentMapData[r][c] === 1) return true; // Wall 충돌
                        }
                    }
                    return false;
                };

                // 목표 지점이 벽이면, 거리를 줄여서 재시도
                if (isWall(targetX, targetY)) {
                    pushFactor = 2.0; // 약한 넉백
                    targetX = player.lastX + dx * pushFactor;
                    targetY = player.lastY + dy * pushFactor;

                    if (isWall(targetX, targetY)) {
                        // 이것도 벽이면 그냥 직전 위치(Safe Zone)로 복귀
                        targetX = player.lastX;
                        targetY = player.lastY;
                    }
                }

                player.x = targetX;
                player.y = targetY;

                // [Force Sync]
                io.to(playerId).emit('playerKnockback', { x: player.x, y: player.y });
                io.emit('playerMoved', player);
            }

            // [Stun] 기절 시간 (2초)
            player.stunnedUntil = Date.now() + 2000;

            io.emit('gameMessage', `🔥 [${player.nickname}] 님이 용암에 빠져 튕겨나갔습니다!`);
        }
    } catch (e) {
        console.error("[TileDetectError]", e);
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
    } else if (gameMode === 'ICE') {
        if (!taggerId) return;
        // 술래가 도망자를 칠 때
        if (moverId === taggerId) {
            for (const targetId in players) {
                if (targetId === moverId) continue;
                const target = players[targetId];
                if (target.isSpectator) continue;

                const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
                if (dist < 30) {
                    if (target.isFrozen) {
                        // 얼음 상태는 무적
                    } else {
                        // 태그 성공
                        console.log(`[ICE_TAG] ${mover.nickname} caught ${target.nickname}.`);
                        target.isSpectator = true;
                        target.isEliminated = true;
                        target.hasItem = null;
                        io.to(targetId).emit('updateInventory', null);
                        target.color = 'rgba(255, 255, 255, 0.3)';

                        io.emit('playerMoved', target);
                        io.emit('gameMessage', `💀 [${target.nickname}] 탈락!`);
                        io.emit('effect', { type: 'die', x: target.x, y: target.y });

                        checkIceWin();
                        return;
                    }
                }
            }
        } else {
            // [Fix] 도망자가 움직일 때 구출(땡) 체크
            checkIceThaw(moverId);
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

            // [New] 타이머 종료 시 모든 모드 공통: 투표로 전환
            // 각 모드별 결과 메시지는 여기서 처리

            if (gameMode === 'TAG') {
                // [TAG Mode] 시간 종료 -> 투표
                io.emit('gameMessage', '⏰ 시간 종료! 다음 맵 투표를 진행합니다.');

                // 결과 데이터 전송 (술래가 못 잡았나? 그냥 종료?)
                // 간단히 현재 생존자/술래 보여주고 종료
                const ids = Object.keys(players);
                const survivors = ids.filter(id => id !== taggerId && !players[id].isSpectator);
                const survivorNames = survivors.map(id => players[id].nickname);

                const resultData = {
                    winner: 'time_over',
                    survivorList: survivorNames,
                    host: players[taggerId] ? players[taggerId].nickname : '-'
                };
                io.emit('gameResult', resultData);

                // 10초 후 투표 시작
                setTimeout(() => startVotingPhase(), 10000);

            } else if (gameMode === 'ZOMBIE') {
                // [생존자 승리]
                io.emit('gameMessage', '🎉 생존자 승리! 2분 30초 동안 버텨냈습니다! 🎉');

                // 통계 및 명단 집계
                const ids = Object.keys(players);
                const survivors = ids.filter(id => !players[id].isZombie);
                const survivorNames = survivors.map(id => players[id].nickname);

                // MVP 계산
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

                // 10초 후 투표 시작
                setTimeout(() => startVotingPhase(), 10000);

            } else if (gameMode === 'ICE') {
                // [얼음땡 도망자 승리] (시간 초과)
                sendIceResult('runners');
            }
        }
    }, 1000);
}

// [New] 투표 화면 전환 헬퍼
function startVotingPhase() {
    if (serverState === ServerState.VOTING) return;

    // 리셋? 아니면 그냥 상태 변경?
    // VotingManager.start()가 상태 체크를 하므로 상태 변경 먼저
    serverState = ServerState.VOTING;
    VotingManager.start();
}

// 봇 생성
function createBot() {
    // [버그 수정] Date.now() 중복 방지를 위해 난수 추가
    const botId = 'bot_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    // [Safety] 봇 생성 시 안전 좌표 강제 적용
    const spawn = getRandomSpawn(currentMapData, validSpawnPoints);

    // Bot 생성자에 좌표 전달 불가 시, 생성 후 덮어쓰기
    const bot = new Bot(botId, currentMapData);
    bot.x = spawn.x;
    bot.y = spawn.y;
    bot.targetX = spawn.x;
    bot.targetY = spawn.y;

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
    const mapInfo = mapLoader.getMap(currentMapName);
    if (mapInfo && typeof mapInfo.generate === 'function') {
        try {
            console.log(`[Reset] ${currentMapName} 재생성...`);
            // 기존 크기 유지 (height, width) - currentMapData가 2차원 배열이라 [height][width]
            const h = currentMapData.length;
            const w = currentMapData[0].length;
            // 일부 맵은 고정 크기일 수 있으므로 안전장치
            currentMapData = mapInfo.generate(h, w);
            io.emit('mapUpdate', currentMapData);
        } catch (e) {
            console.error(`[Reset] Map Regen Error (${currentMapName}):`, e);
        }
    }
    // [Fix] 맵 변경/리셋 시 안전한 스폰 지점 재계산 (validSpawnPoints 갱신)
    // analyzeMapConnectivity가 server.js 상단에 require 되어 있는지 확인 필요
    // 만약 없으면 utils에서 가져와야 함.
    validSpawnPoints = analyzeMapConnectivity(currentMapData);
    console.log(`[Reset] Recalculated valid spawn points: ${validSpawnPoints.length}`);

    // [Fix] 아이템 밸런스: 맵 크기에 비례하여 초기값 설정 (Min 5, Max 30)
    const mapSize = currentMapData.length * currentMapData[0].length;
    const initialItemCount = Math.min(30, Math.max(5, Math.floor(mapSize / 600)));

    console.log(`[Reset] Spawning ${initialItemCount} items (MapSize: ${mapSize})`);

    for (let i = 0; i < initialItemCount; i++) {
        const span = getRandomSpawn(currentMapData, validSpawnPoints);
        // 아이템 ID 생성
        const itemId = `item_${Date.now()}_${i}`;

        let availableTypes = ITEM_TYPES;
        // [New] 얼음땡 모드 실드 제외
        if (gameMode === 'ICE') {
            availableTypes = availableTypes.filter(t => t !== 'shield');
        }

        const type = availableTypes[Math.floor(Math.random() * availableTypes.length)];
        items[itemId] = { x: span.x, y: span.y, type: type };
    }
    io.emit('updateItems', items);

    // Clear timer
    if (iceCountdownTimer) {
        clearInterval(iceCountdownTimer);
        iceCountdownTimer = null;
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
        const spawn = getRandomSpawn(currentMapData, validSpawnPoints);
        p.x = spawn.x;
        p.y = spawn.y;
        p.targetX = p.x;
        p.targetY = p.y;
        p.isSlipped = false;
        p.stunnedUntil = 0;
        p.hasItem = null;
        p.hasShield = false;
        p.isSpeeding = false;

        // [Refinement] 얼음/기절 상태 확실한 초기화
        p.isFrozen = false;
        p.isStunned = false;
        p.iceCooldown = 0;

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

        // [New] 술래잡기 4분 타이머
        io.emit('gameMessage', '⏱️ 4분 뒤 투표가 시작됩니다!');
        startRoundTimer(240);
    } else if (gameMode === 'ZOMBIE') {
        taggerId = null; // 좀비 모드는 술래 개념 대신 좀비가 있음
        io.emit('updateTagger', null);
        startZombieCountdown();
    } else if (gameMode === 'BOMB') {
        taggerId = null;
        startBombRound();
    } else if (gameMode === 'ICE') {
        taggerId = null;
        io.emit('updateTagger', null); // [Fix] 클라이언트 술래 표시 제거
        startIceCountdown();
    }

    io.emit('currentPlayers', players);
    io.emit('gameMode', gameMode); // [추가] 클라이언트에 게임 모드 전송

    const msg = `🔄 게임 리셋! 모드: ${gameMode}`;
    io.emit('gameMessage', msg);
    // io.emit('chatMessage', { nickname: 'System', message: msg, playerId: 'system' }); // [Fix] 중복 메시지 방지 (gameMessage와 겹침)
}

// 소켓 IO
io.on('connection', (socket) => {
    console.log('클라이언트 접속:', socket.id);
    setupSocketEvents(socket);
    // [추가] 접속 시 현재 플레이어 수 전달 (봇 제외)
    socket.emit('playerCountUpdate', Object.values(players).filter(p => !(p instanceof Bot)).length);

    // [Attract Mode] 접속 즉시 현재 게임 상태 전송 (로그인 전 관전용)
    if (currentMapData) socket.emit('mapUpdate', currentMapData);
    socket.emit('currentPlayers', players);
    if (taggerId) socket.emit('updateTagger', taggerId);
    socket.emit('gameMode', gameMode);

    // [New] Ping Pong Logic
    socket.on('latency', (clientTimestamp) => {
        socket.emit('latency', clientTimestamp);
    });
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
    try {
        if (players[socket.id]) return;

        console.log('게임 입장:', data.nickname);

        // [Safety] 맵 데이터 확인
        if (!currentMapData || !currentMapData.length) {
            throw new Error("Map data not initialized");
        }

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
            id: socket.id, // [Fix] id 속성 추가 (중요: 이것이 없어서 taggerId 비교가 실패했음)
            x: spawnPos.x,
            y: spawnPos.y,
            playerId: socket.id,
            color: initialColor,
            initialColor: initialColor, // 현재 상태의 초기 색상
            originalColor: realOriginalColor, // [버그 수정] 리셋 시 복구할 진짜 색상
            nickname: data.nickname || '익명',
            isZombie: isZombieStart,
            isSpectator: isSpectator, // [추가]
            stats: {
                distance: 0,
                infectionCount: 0,
                survivalTime: 0,
                iceUseCount: 0, // [New] 얼음 사용 횟수
                rescueCount: 0  // [New] 구출 횟수
            }
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
        // [추가] 접속자 수 갱신 브로드캐스트 (봇 제외)
        const realUserCount = Object.values(players).filter(p => !(p instanceof Bot)).length;
        io.emit('playerCountUpdate', realUserCount);
    } catch (err) {
        console.error("JoinGame Error:", err);
        socket.emit('gameMessage', '❌ 게임 입장 실패: ' + err.message);
        // 클라이언트 버튼 리셋 유도 가능? (별도 이벤트 필요할 수도)
    }
}

function handlePlayerMove(socket, movementData) {
    try {
        const player = players[socket.id];
        if (!player) return;

        // [기절 체크]
        // [Correction] 기절 상태면 위치 리셋하고 중단
        if ((player.stunnedUntil && Date.now() < player.stunnedUntil) || player.isFrozen) {
            socket.emit('playerMoved', player);
            return;
        }

        // [통계]
        if (!player.isZombie && !player.isSpectator && player.stats) {
            const dx = movementData.x - player.x;
            const dy = movementData.y - player.y;
            player.stats.distance += Math.hypot(dx, dy);
        }

        // [Move] 좌표 업데이트 전 이전 위치 저장 (넉백용)
        player.lastX = player.x;
        player.lastY = player.y;

        player.x = movementData.x;
        player.y = movementData.y;

        // [Logic Priority 1] 타일 상호작용 (용암 넉백 등 위치 수정 가능성 있음)
        checkTileInteraction(socket.id);

        // [Logic Priority 2] 확정된 위치 전송 (넉백 반영됨)
        io.emit('playerMoved', player);

        // [Logic Priority 3] 나머지 판정
        checkCollision(socket.id);

        if (gameMode === 'ICE') {
            checkIceThaw(socket.id);
        }

        checkItemCollection(socket.id);
        checkTrapCollision(socket.id);
    } catch (error) {
        console.error(`[MoveError] ${socket.id}:`, error);
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

        // [Refinement] 얼음 아이템 로직 (소모되지 않음)
        if (gameMode === 'ICE' && itemType === 'ice') {
            // 쿨타임 체크
            if (player.iceCooldown && Date.now() < player.iceCooldown) {
                const remain = Math.ceil((player.iceCooldown - Date.now()) / 1000);
                socket.emit('gameMessage', `❄️ 쿨타임 중입니다 (${remain}초)`);
                return;
            }

            // 얼음 사용
            player.isFrozen = true;
            player.isStunned = true; // 이동 불가
            io.emit('playerMoved', player);
            io.emit('gameMessage', `❄️ [${player.nickname}] 얼음!`);
            // 아이템 제거하지 않음 (무한)

            // [New] 통계: 얼음 사용 횟수 증가
            if (player.stats) player.stats.iceUseCount++;

            checkIceWin(); // [Fix] 스스로 얼었을 때도 승리 체크
        } else {
            // 일반 아이템 (소모)
            player.hasItem = null;
            io.to(socket.id).emit('updateInventory', null);
            handleItemEffect(socket.id, itemType);
        }
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
            // [Fix] 술래가 나갔을 때, 관전자가 아닌 플레이어 중에서만 새 술래 선정
            const candidates = Object.keys(players).filter(id => !players[id].isSpectator && id !== socket.id);
            if (candidates.length > 0) {
                taggerId = candidates[Math.floor(Math.random() * candidates.length)];
                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `술래가 나가서 [${players[taggerId].nickname}] 님이 새 술래가 됩니다!`);
            } else {
                taggerId = null;
                // [Fix] 생존자가 없으면 게임 종료/리셋 처리 필요 (모드별)
                if (gameMode === 'ICE') checkIceWin(); // 승리 체크 트리거
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
        const parts = cmd.split(' ');
        const mode = parts[1].toLowerCase();

        // [New] Auto/Free 모드 전환
        if (mode === 'auto') {
            serverState = ServerState.VOTING;
            io.emit('gameMessage', `🤖 [System] 자동 투표 모드로 전환합니다.`);
            VotingManager.start(); // 즉시 투표 시작
            return;
        } else if (mode === 'free') {
            serverState = ServerState.FREE;
            io.emit('gameMessage', `🔓 [System] 자유(관리자) 모드로 전환합니다.`);
            if (VotingManager.timer) clearInterval(VotingManager.timer); // 투표 중단
            return;
        }

        const modeMsg = `[${player.nickname}] 님이 명령어를 실행했습니다: ${cmd}`;
        io.emit('gameMessage', modeMsg);
        io.emit('chatMessage', { nickname: 'System', message: modeMsg, playerId: 'system' });

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
        } else if (mode === 'ice') {
            if (Object.keys(players).length < 2) {
                // [수정] 채팅 창 알림으로 변경 (User Request)
                socket.emit('chatMessage', {
                    nickname: 'System',
                    message: "🚫 인원이 부족하여 얼음땡 모드를 시작할 수 없습니다. (최소 2명)",
                    playerId: 'system'
                });
                return;
            }

            io.emit('gameMessage', `❄️ [얼음땡] 모드가 선택되었습니다! (10초 대기)`);
            gameMode = 'ICE';
            resetGame(); // 리셋 실행 (리셋 내부에서 startIceCountdown 호출됨)
            // startIceCountdown(); // [삭제] 리셋에서 호출되므로 중복 제거
        } else {
            socket.emit('chatMessage', { nickname: 'System', message: "사용법: /mode [zombie/tag] [봇수]", playerId: 'system' });
        }
        return;
    }

    // [명령어] /map [MAP_NAME] [SIZE?]
    // [명령어] /map [MAP_NAME] [SIZE?]
    // [명령어] /map [MAP_NAME] [SIZE?]
    if (cmd.startsWith('/map')) {
        const parts = cmd.split(' ');
        const args = parts.slice(1);
        const mapNameInput = args[0] ? args[0].toUpperCase() : 'RANDOM';
        const sizeInput = args[1] ? args[1].toUpperCase() : null; // Optional: S, M, L

        let nextMap = null;
        let targetSizeKey = 'M'; // Default

        // 1. 사이즈 파싱 및 랜덤 선택
        if (['SMALL', 'S'].includes(mapNameInput)) { targetSizeKey = 'S'; nextMap = mapLoader.getRandomMap('S'); }
        else if (['MEDIUM', 'M'].includes(mapNameInput)) { targetSizeKey = 'M'; nextMap = mapLoader.getRandomMap('M'); }
        else if (['LARGE', 'L'].includes(mapNameInput)) { targetSizeKey = 'L'; nextMap = mapLoader.getRandomMap('L'); }
        else if (mapNameInput === 'RANDOM') {
            const sizes = ['S', 'M', 'L'];
            targetSizeKey = sizes[Math.floor(Math.random() * sizes.length)];
            nextMap = mapLoader.getRandomMap(targetSizeKey);
        }
        else {
            // 특정 맵 지정
            nextMap = mapLoader.getMap(mapNameInput);

            // 사이즈 인자 처리
            if (sizeInput && ['S', 'M', 'L'].includes(sizeInput)) targetSizeKey = sizeInput;
            else if (sizeInput && ['SMALL', 'MEDIUM', 'LARGE'].includes(sizeInput)) targetSizeKey = sizeInput[0];
            else if (nextMap && nextMap.allowedSizes) {
                // 맵 기본 사이즈 (가장 큰 것 or 첫번째)
                targetSizeKey = nextMap.allowedSizes[nextMap.allowedSizes.length - 1];
            }
        }

        if (nextMap) {
            // 사이즈 유효성 검사 (강제 조정)
            if (nextMap.allowedSizes && !nextMap.allowedSizes.includes(targetSizeKey)) {
                console.log(`[Map] Warning: ${nextMap.name} does not support ${targetSizeKey}. Fallback.`);
                targetSizeKey = nextMap.allowedSizes[nextMap.allowedSizes.length - 1];
            }

            // 치수 결정
            let { width, height } = MAP_SIZES[targetSizeKey] || MAP_SIZES['M'];
            if (targetSizeKey === 'M' && nextMap.name === 'SPEEDWAY') { width = 40; height = 40; } // Exception

            console.log(`[Map] Switching to ${nextMap.name} (${targetSizeKey}: ${width}x${height})`);

            try {
                if (typeof nextMap.generate === 'function') {
                    currentMapData = nextMap.generate(height, width); // generate(rows, cols)
                    if (nextMap.name === 'SPEEDWAY') currentMapData = nextMap.generate(40, 40); // Exception fix
                } else if (nextMap.data) {
                    currentMapData = JSON.parse(JSON.stringify(nextMap.data)); // Copy
                } else {
                    throw new Error("Invalid Map Structure");
                }

                if (!currentMapData || !currentMapData.length) throw new Error("Generated Data Empty");

                currentMapName = nextMap.name;

                // 맵 업데이트 브로드캐스트
                // [Fix] 클라이언트가 'mapUpdate'를 리스닝하므로 이벤트명 변경
                io.emit('mapUpdate', currentMapData);
                resetGame();

                let mapMsg = `🗺️ 맵 변경: ${currentMapName} (${targetSizeKey})`;
                if (currentMapName === 'SPEEDWAY') mapMsg += " - 🏎️ 질주 본능!";
                if (currentMapName === 'FOREST') mapMsg += " - 🌲 숲 속의 술래잡기";
                if (currentMapName === 'OFFICE') mapMsg += " - 🏢 오피스 탈출";

                io.emit('chatMessage', { nickname: '[System]', message: mapMsg, color: '#00ff00' });

            } catch (e) {
                console.error('[MapGen] Error:', e);
                socket.emit('chatMessage', { nickname: '[System]', message: `❌ 맵 생성 실패: ${e.message}`, color: '#ff0000' });
            }

        } else {
            // 유사한 이름 찾기 제안 (옵션)
            socket.emit('chatMessage', { nickname: '[System]', message: `❌ 맵을 찾을 수 없습니다: ${mapNameInput}`, color: '#ff0000' });
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

    if (cmd === '/info' || cmd === '/debug') {
        const mapSize = currentMapData.length * currentMapData[0].length;
        const maxItems = Math.min(30, Math.max(5, Math.floor(mapSize / 600)));
        const currentItemCount = Object.keys(items).length;
        const infoMsg = `📊 <b>맵 정보</b><br>` +
            `- 맵 이름: ${currentMapName}<br>` +
            `- 크기: ${currentMapData[0].length} x ${currentMapData.length} (${mapSize} tiles)<br>` +
            `- 아이템: ${currentItemCount} / ${maxItems} (Max)<br>` +
            `- 생성 확률: 5% (Loop당)<br>` +
            `- 남은 시간: ${roundTime}초`;

        socket.emit('chatMessage', { nickname: 'System', message: infoMsg, playerId: 'system' });
        return;
    }

    // [New] 게임 강제 종료 (투표로 넘어감)
    if (cmd === '/endgame' || cmd === '/finish' || cmd === '/stop') {
        if (roundTimer) {
            io.emit('gameMessage', `🛑 [${player.nickname}] 님이 게임을 강제 종료했습니다.`);
            roundTime = 1; // 1초 뒤 종료 트리거 (안전하게 루프 타게 함)
            io.emit('updateTimer', roundTime);
        } else {
            socket.emit('gameMessage', '진행 중인 타이머가 없습니다. (투표 중이거나 대기 중)');
        }
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

    // [Balance] 맵이 600타일 늘어날 때마다 아이템 1개 추가 (Min 5, Max 30)
    // 기존: 300타일 -> 너무 많았음. 600으로 조정
    const maxItems = Math.min(30, Math.max(5, Math.floor(mapSize / 600)));

    if (Object.keys(items).length < maxItems) {
        // 생성 확률 50% -> 너무 높음
        // 100%로 채우되, 5초마다는 너무 빠름 -> 루프는 유지하되 확률 적용?
        // 일단 무조건 채우는 방식 유지하되, Max 개수를 줄였으므로 밸런스 조절됨.
        spawnItem();
    }
}, 5000);

// 초기 아이템 및 테스트 바나나
setTimeout(() => {
    spawnItem(); spawnItem();


}, 1000);

// 게임 루프 (봇 업데이트)
setInterval(() => {
    try {
        Object.keys(players).forEach(id => {
            if (players[id] instanceof Bot) {
                // [중요] 봇에게 게임 state와 callback 전달
                // gameMode 추가 전달 (BOMB 모드면 bombHolderId를 술래로 취급)
                const currentTaggerId = (gameMode === 'BOMB') ? bombHolderId : taggerId;

                players[id].update(players, currentTaggerId, lastTaggerId, {
                    handleItemEffect: handleItemEffect,
                    handleBotAction: handleBotAction
                }, currentMapData, gameMode);

                // 동기화
                io.emit('playerMoved', players[id]);
                checkCollision(id);
                checkItemCollection(id);
                checkTrapCollision(id);

                // [Fix] 바나나(isSlipped) 상태 해제 체크
                if (players[id].isSlipped && players[id].slipStartTime) {
                    if (Date.now() - players[id].slipStartTime > 3000) {
                        players[id].isSlipped = false;
                        players[id].slipStartTime = 0;
                    }
                }
            }
        });

        // [BOMB] 게임 루프
        if (gameMode === 'BOMB') {
            updateBombGame();
        }
    } catch (e) {
        // [User Request] 에러 억제
        if (e.message && e.message.includes("reading 'length'")) {
            // Suppress
        } else {
            console.error("GameLoop Error:", e);
            io.emit('serverError', { msg: `GameLoop Error: ${e.message}`, level: 'critical' });
        }
    }
}, 100);

// [New] 봇 전용 액션 처리
function handleBotAction(botId, actionType) {
    const bot = players[botId];
    if (!bot) return;

    if (actionType === 'ice' && gameMode === 'ICE') {
        if (bot.iceCooldown && Date.now() < bot.iceCooldown) return;
        bot.isFrozen = true;
        bot.isStunned = true;
        bot.iceCooldown = Date.now() + 5000;
        io.emit('playerMoved', bot);
        checkIceWin();
    }
}

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
                setTimeout(() => startVotingPhase(), 10000);
            } else if (survivors.length === 0) {
                // 모두 멸망? (동시 폭사 등)
                io.emit('gameMessage', `💀 생존자가 없습니다... 게임 오버.`);
                setTimeout(() => startVotingPhase(), 5000);
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

// 투표 단계 시작 (Global Function)
function startVotingPhase() {
    if (serverState === ServerState.VOTING) return;

    serverState = ServerState.VOTING;
    io.emit('gameMessage', '🗳️ 잠시 후 투표가 시작됩니다!');
    io.emit('chatMessage', { nickname: 'System', message: '🗳️ 투표 시작! 다음 게임 모드를 선택하세요.', playerId: 'system' });

    // 3초 대기 후 투표 시작 (결과 화면 감상 시간)
    setTimeout(() => {
        VotingManager.startModeVoting();
    }, 3000);
}

server.listen(PORT, () => {
    console.log(`서버 실행: http://localhost:${PORT}`);
    // [Autostart: Attract Mode] 서버 시작 시 봇 소환 및 게임 시작
    // 사용자가 로그인하기 전에 봇들이 뛰어노는 모습을 보여줌
    setTimeout(() => {
        console.log("[Auto] Starting Attract Mode (Spawn Bots)...");

        // 1. 강제 PLAYING 상태
        serverState = ServerState.PLAYING;

        // 2. 봇 3마리 소환
        for (let i = 0; i < 3; i++) {
            const botId = 'bot_' + Date.now() + '_' + i;
            const bot = new Bot(botId, currentMapData);
            players[bot.id] = bot;

            // 봇에게 색상 랜덤 할당 (비주얼)
            bot.color = COLORS[Math.floor(Math.random() * COLORS.length)];
            bot.initialColor = bot.color;
        }

        // 3. 술래 선정 (봇 중 하나)
        const botIds = Object.keys(players);
        if (botIds.length > 0) {
            taggerId = botIds[Math.floor(Math.random() * botIds.length)];
            io.emit('updateTagger', taggerId);
        }

        // 4. 게임 루프가 이미 돌고 있으므로 상태만 알리면 됨
        const realUserCount = 0;
        io.emit('playerCountUpdate', realUserCount);
        io.emit('gameMessage', "🤖 봇들이 몸을 풀고 있습니다.");

        // [New] 초기 타이머 시작 (Tag Mode)
        startRoundTimer(240);

    }, 2000);
});

// [New] 얼음땡 카운트다운 시작
function startIceCountdown() {
    let count = 10;
    io.emit('gameMessage', `⏳ ${count}초 후 시작합니다! 도망자는 '얼음' 아이템을 받습니다.`);

    if (iceCountdownTimer) clearInterval(iceCountdownTimer);
    iceCountdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            io.emit('gameMessage', `${count}...`);
        } else {
            clearInterval(iceCountdownTimer);
            startIceRound(); // Starts the actual round
        }
    }, 1000);
}

// [New] 얼음땡 승리 체크
function checkIceWin() {
    if (gameMode !== 'ICE') return;

    const ids = Object.keys(players);
    const survivors = ids.filter(id => !players[id].isSpectator && players[id].id !== taggerId);

    // Check if all living survivors are frozen
    // Check if all living survivors are frozen
    const frozenSurvivors = survivors.filter(id => players[id].isFrozen);

    // 승리 조건: 생존자가 0명이거나(모두 탈락), 남은 생존자가 모두 얼었을 때
    console.log(`[ICE_WIN_CHECK] Survivors: ${survivors.length}, Frozen: ${frozenSurvivors.length}`);

    if (survivors.length === 0 || survivors.length === frozenSurvivors.length) {
        // [수정] 3분 타이머 종료와 동일한 결과 화면 -> 투표
        sendIceResult('tagger');
    }
}

// [New] 얼음땡 결과 전송 및 리셋
function sendIceResult(winnerType) {
    if (iceCountdownTimer) clearInterval(iceCountdownTimer);
    if (roundTimer) clearInterval(roundTimer); // 라운드 타이머도 정지

    const ids = Object.keys(players);
    // [Fix] 통계용 대상: 술래 제외 + 관전자 제외
    const nonTaggers = ids.filter(id => players[id].id !== taggerId && !players[id].isSpectator);

    // 1. 술래
    const tagger = players[taggerId];
    const taggerName = tagger ? tagger.nickname : '-';

    // 2. 눈사람 (Ice King) - Most Ice Used
    const sortedIce = [...nonTaggers].sort((a, b) => ((players[b].stats?.iceUseCount || 0) - (players[a].stats?.iceUseCount || 0)));
    const iceKing = sortedIce.length > 0 ? players[sortedIce[0]] : null;

    // 3. 프로 러너 (Pro Runner) - Most Distance
    const sortedRunners = [...nonTaggers].sort((a, b) => ((players[b].stats?.distance || 0) - (players[a].stats?.distance || 0)));
    const proRunner = sortedRunners.length > 0 ? players[sortedRunners[0]] : null;

    // 4. 프로 구원자 (Pro Savior) - Most Rescues
    const sortedSaviors = [...nonTaggers].sort((a, b) => ((players[b].stats?.rescueCount || 0) - (players[a].stats?.rescueCount || 0)));
    const proSavior = sortedSaviors.length > 0 ? players[sortedSaviors[0]] : null;

    const resultData = {
        mode: 'ICE',
        winner: winnerType, // 'tagger' or 'runners'
        tagger: taggerName,
        iceKing: iceKing ? { name: iceKing.nickname, val: (iceKing.stats?.iceUseCount || 0) + '회' } : { name: '-', val: '-' },
        proRunner: proRunner ? { name: proRunner.nickname, val: Math.floor(proRunner.stats?.distance || 0) + 'px' } : { name: '-', val: '-' },
        proSavior: proSavior ? { name: proSavior.nickname, val: (proSavior.stats?.rescueCount || 0) + '회' } : { name: '-', val: '-' }
    };

    io.emit('gameResult', resultData);

    // 로그 메시지 전송
    if (winnerType === 'tagger') {
        io.emit('gameMessage', `🥶 도망자가 모두 잡히거나 얼었습니다! 술래 승리!`);
    } else {
        io.emit('gameMessage', '🎉 도망자 승리! 술래를 피해 살아남았습니다! 🎉');
    }

    setTimeout(() => startVotingPhase(), 10000);
}

// [New] 얼음땡에서 도망자 간 땡(Thaw) 로직
function checkIceThaw(moverId) {
    const mover = players[moverId];
    // [Fix] 술래는 절대로 땡을 할 수 없음 (이중 체크)
    if (!mover || mover.id === taggerId || mover.isSpectator || mover.isFrozen) return;
    if (taggerId && mover.id === taggerId) return; // 확실하게 차단

    for (const otherId in players) {
        if (otherId === moverId) continue;
        const other = players[otherId];
        if (other.id === taggerId || other.isSpectator) continue;

        // 얼어있는 동료를 건드렸는지 확인
        if (other.isFrozen) {
            const dist = Math.hypot(mover.x - other.x, mover.y - other.y);
            if (dist < 30) {
                // 땡!
                other.isFrozen = false;
                other.isStunned = false;
                other.stunnedUntil = 0;
                other.iceCooldown = Date.now() + 5000; // 5초 쿨타임

                // [New] 통계: 구출 횟수 증가
                if (mover.stats) mover.stats.rescueCount++;

                io.emit('playerMoved', other);
                io.emit('gameMessage', `🔨 [${mover.nickname}]님이 [${other.nickname}]님을 녹여주었습니다!`);
                return;
            }
        }
    }
}

function startIceRound() {
    gameMode = 'ICE';
    io.emit('gameMode', 'ICE');
    io.emit('gameMessage', '❄️ 얼음땡 시작! 술래가 선정되었습니다!');

    // [Refinement] 시작 시 술래 선정 (준비 시간엔 없음)
    const ids = Object.keys(players).filter(id => !players[id].isSpectator);
    if (ids.length > 0) {
        taggerId = ids[Math.floor(Math.random() * ids.length)];
        io.emit('updateTagger', taggerId);
    }

    // 아이템 지급 및 초기화
    Object.keys(players).forEach(id => {
        const p = players[id];
        p.isFrozen = false;
        p.isStunned = false;
        p.iceCooldown = 0;

        if (id !== taggerId && !p.isSpectator) {
            p.hasItem = 'ice'; // 얼음 아이템 지급
            io.to(id).emit('updateInventory', 'ice');
        } else {
            p.hasItem = null;
            io.to(id).emit('updateInventory', null);
        }
        io.emit('playerMoved', p);
    });

    // 라운드 타이머 (3분)
    startRoundTimer(180);
}
