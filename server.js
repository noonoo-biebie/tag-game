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
    MAP_SIZES,
    TARGET_POPULATION // [New] for Voting Recommendations
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
let roundTimer = null; // [Fix] Global timer variable
let roundTime = 0; // [Fix] Global time variable
// 맵 로드
// [Duplicate Removed]
console.log(`[Server] Maps loaded: ${Object.keys(MAPS_MODULE).join(', ')}`);
if (!MAPS_MODULE['DEFAULT']) {
    console.error("🔥 [CRITICAL] DEFAULT map not found!");
    process.exit(1);
}

const TIMEOUT_DURATION = 60 * 1000; // 1분 (사용자 입력 없을 때 연결 끊기용)

// [Smart Tagger Selection] 최근 술래 기록 (중복 방지)
let lastTaggers = [];
const MAX_LAST_TAGGERS = 2; // 최근 2명은 제외

function getSmartTagger(candidates) {
    // 1. 제외할 ID 목록
    const excludeIds = new Set(lastTaggers);

    // 2. 후보 필터링
    let validCandidates = candidates.filter(id => !excludeIds.has(id));

    // 3. 만약 후보가 없으면(모두 최근에 술래 함) 리셋 후 전체 대상
    if (validCandidates.length === 0) {
        validCandidates = [...candidates];
    }

    if (validCandidates.length === 0) return null;

    // 4. 랜덤 선택
    const selected = validCandidates[Math.floor(Math.random() * validCandidates.length)];

    // 5. 기록 업데이트
    lastTaggers.push(selected);
    if (lastTaggers.length > MAX_LAST_TAGGERS) {
        lastTaggers.shift();
    }

    return selected;
}

// 맵 데이터 로드
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
// [Refactoring] 게임 규칙 통합 엔진
const GameRules = {
    // 공통 유틸리티
    start: (mode) => {
        // 모든 모드 공통: 10초 카운트다운 후 시작
        startUniversalCountdown(mode, 10, () => {
            if (GameRules[mode] && GameRules[mode].onRoundStart) {
                GameRules[mode].onRoundStart();
            } else {
                console.error(`[GameRules] Undefined mode start: ${mode}`);
            }
        });
    },

    TAG: {
        onRoundStart: () => {
            const candidateIds = Object.keys(players).filter(id => !players[id].isSpectator);
            if (candidateIds.length > 0) {
                taggerId = getSmartTagger(candidateIds);
                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `🏃 [${players[taggerId].nickname}] 님이 술래입니다!`);
                startRoundTimer(240); // 4분
            } else {
                io.emit('gameMessage', '⚠️ 플레이어가 부족하여 시작할 수 없습니다.');
                setTimeout(() => startVotingPhase(), 3000);
            }
        },
        onCollision: (mover, target) => {
            if (!taggerId) return;

            let tagger = null;
            let victim = null;

            if (mover.id === taggerId) {
                tagger = mover;
                victim = target;
            } else if (target.id === taggerId) {
                tagger = target;
                victim = mover;
            }

            if (tagger && victim) {
                if (tagger.stunnedUntil && Date.now() < tagger.stunnedUntil) return;

                // Logic transferred from legacy checkCollision
                if (victim.hasShield) {
                    victim.hasShield = false;
                    io.to(victim.playerId).emit('itemEffect', { type: 'shield', on: false });
                    io.emit('gameMessage', `🛡️ [${victim.nickname}] 님이 방어막으로 공격을 막았습니다!`);

                    // [Fix] Broadcast shield removal to everyone (Visual Sync)
                    io.emit('playerMoved', victim);

                    players[taggerId].stunnedUntil = Date.now() + 1000;
                    return;
                }
                // 태그 성공
                lastTaggerId = taggerId;
                taggerId = victim.id;

                // [Fix] players[taggerId] refers to NEW tagger (victim)
                if (players[taggerId]) players[taggerId].stunnedUntil = Date.now() + 2000;

                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `🏃 [${victim.nickname}] 님이 술래가 되었습니다!`);
                io.emit('tagOccurred', { newTaggerId: taggerId });
                if (victim.stats) victim.stats.caughtCount = (victim.stats.caughtCount || 0) + 1;
            }
        }
    },
    ZOMBIE: {
        onRoundStart: () => {
            // 숙주 선정
            const candidateIds = Object.keys(players).filter(id => !players[id].isSpectator);
            if (candidateIds.length > 0) {
                const totalPlayers = candidateIds.length;
                let hostCount = 1;
                if (totalPlayers >= 8) hostCount = 2;

                initialHostIds = [];
                for (let i = 0; i < hostCount; i++) {
                    if (candidateIds.length === 0) break;
                    const idx = Math.floor(Math.random() * candidateIds.length);
                    initialHostIds.push(candidateIds[idx]);
                    candidateIds.splice(idx, 1);
                }

                initialHostIds.forEach(hid => {
                    players[hid].isZombie = true;
                    players[hid].originalColor = players[hid].color;
                    players[hid].color = '#2ecc71';
                    io.emit('playerMoved', players[hid]);
                });

                io.emit('gameMessage', `🧟 으악! ${initialHostIds.length}명의 숙주 좀비가 나타났습니다!!`);
            }
            startRoundTimer(150);
        }
    },
    BOMB: {
        onRoundStart: () => {
            const currentSurvivors = Object.keys(players).filter(id => !players[id].isSpectator);
            if (currentSurvivors.length > 1) {
                const holderId = getSmartTagger(currentSurvivors);
                bombHolderId = holderId;

                let duration = bombDurationOverride || (Math.floor(Math.random() * 11) + 20); // 20~30s
                bombEndTime = Date.now() + (duration * 1000);
                bombPassCooldown = 0;

                io.emit('updateTagger', bombHolderId);
                io.emit('gameMessage', `💣 [${players[bombHolderId].nickname}] 폭탄 점화! (${duration}초)`);
                io.emit('bombStart', { duration: duration, startTime: Date.now() });
            } else {
                io.emit('gameMessage', '⚠️ 플레이어가 부족합니다.');
                setTimeout(() => startVotingPhase(), 3000);
            }
        }
    },
    ICE: {
        onRoundStart: () => {
            // 얼음땡 술래 선정
            console.log('[ICE] Round Start Logic Initiated');
            const candidateIds = Object.keys(players).filter(id => !players[id].isSpectator);

            if (candidateIds.length > 1) { // 최소 2명 필요
                taggerId = getSmartTagger(candidateIds);
                console.log(`[ICE] Tagger Selected: ${taggerId} (${players[taggerId]?.nickname})`);

                io.emit('updateTagger', taggerId);
                io.emit('gameMessage', `🧊 [${players[taggerId].nickname}] 님이 술래입니다! 도망가세요!`);

                // 아이템 지급 및 초기화 (Batch update capability missing, loop is fine for now)
                Object.keys(players).forEach(id => {
                    const p = players[id];
                    // 상태 초기화
                    p.isFrozen = false;
                    p.isStunned = false;
                    p.iceCooldown = 0;

                    if (id !== taggerId && !p.isSpectator) {
                        p.hasItem = 'ice';
                        io.to(id).emit('updateInventory', 'ice');
                    } else {
                        p.hasItem = null;
                        io.to(id).emit('updateInventory', null);
                    }
                    // 개별 emit 대신 전체 동기화가 더 효율적일 수 있음.
                    // io.emit('playerMoved', p); -> 트래픽 과다. 
                    // 하지만 상태 변경을 알려야 하므로 유지하되, 전체 루프 후 한번에 알리는게 나음.
                });

                // [Optimization] 전체 플레이어 상태 한 번에 전송
                io.emit('currentPlayers', players);

                // 얼음땡 타이머 (3분 = 180초)
                startRoundTimer(180);
            } else {
                console.log('[ICE] Not enough players.');
                io.emit('gameMessage', '⚠️ 플레이어가 부족합니다 (최소 2명).');
                setTimeout(() => startVotingPhase(), 3000);
            }
        }
    }
};

// [Refactoring] Collision Handlers (Appended to avoid edit conflicts)
GameRules.ZOMBIE.onCollision = (mover, target) => {
    if (mover.stunnedUntil && Date.now() < mover.stunnedUntil) return;
    if (mover.isSpectator || target.isSpectator) return;

    let zombie = null;
    let human = null;

    if (mover.isZombie && !target.isZombie) {
        zombie = mover; human = target;
    } else if (!mover.isZombie && target.isZombie) {
        zombie = target; human = mover;
    }

    if (zombie && human) {
        if (zombie.stunnedUntil && Date.now() < zombie.stunnedUntil) return;

        if (human.hasShield) {
            human.hasShield = false;
            io.to(human.playerId).emit('itemEffect', { type: 'shield', on: false });
            io.emit('gameMessage', `🛡️ [${human.nickname}] 님이 방어막으로 좀비를 막았습니다!`);

            // [Fix] Broadcast shield removal
            io.emit('playerMoved', human);

            zombie.stunnedUntil = Date.now() + 1000;
            return;
        }

        human.isZombie = true;
        if (!human.originalColor) human.originalColor = human.color;
        const zombieColors = ['#2ecc71', '#27ae60', '#00b894', '#55efc4', '#16a085'];
        human.color = zombieColors[Math.floor(Math.random() * zombieColors.length)];

        if (human instanceof Bot) {
            human.nickname = human.nickname.replace('🤖', '🧟');
            if (human.nickname.includes('Bot_')) human.nickname = human.nickname.replace('Bot_', 'Zom_');
        } else {
            if (!human.nickname.startsWith('🧟 ')) human.nickname = '🧟 ' + human.nickname;
        }

        if (zombie.stats) zombie.stats.infectionCount++;
        if (human.stats) human.stats.survivalTime = Date.now() - gameStartTime;

        human.stunnedUntil = Date.now() + 2000;
        zombie.stunnedUntil = Date.now() + 500;

        io.emit('playerMoved', human);
        io.emit('playerMoved', zombie);
        io.emit('gameMessage', `🧟 [${human.nickname}] 님이 좀비에게 감염되었습니다!`);

        checkZombieWin();
    }
};

GameRules.BOMB.onCollision = (mover, target) => {
    if (!bombHolderId) return;
    if (bombPassCooldown && Date.now() < bombPassCooldown) return;

    let holder = null;
    let victim = null;

    if (mover.id === bombHolderId) {
        holder = mover;
        victim = target;
    } else if (target.id === bombHolderId) {
        holder = target;
        victim = mover;
    }

    if (holder && victim && !victim.isSpectator) {
        if (victim.hasShield) {
            victim.hasShield = false;
            io.to(victim.playerId).emit('itemEffect', { type: 'shield', on: false });
            io.emit('gameMessage', `🛡️ [${victim.nickname}] 님이 방어막으로 폭탄을 막았습니다!`);

            // [Fix] Broadcast shield removal
            io.emit('playerMoved', victim);

            holder.stunnedUntil = Date.now() + 1000;
            bombPassCooldown = Date.now() + 1000;
            return;
        }

        bombHolderId = victim.id;
        bombPassCooldown = Date.now() + 1000;
        victim.stunnedUntil = Date.now() + 2000;

        io.emit('gameMessage', `💣 [${holder.nickname}] -> [${victim.nickname}] 폭탄 전달! (2초 기절)`);
        io.emit('playerMoved', victim);
        io.emit('playerMoved', holder);
        io.emit('updateTagger', bombHolderId);
        io.emit('bombPassed', { senderId: holder.playerId, receiverId: victim.playerId });
    }
};

GameRules.ICE.onCollision = (mover, target) => {
    if (!taggerId) return;

    let tagger = null;
    let runner = null;

    if (mover.id === taggerId) {
        tagger = mover; runner = target;
    } else if (target.id === taggerId) {
        tagger = target; runner = mover;
    }

    if (tagger && runner) {
        // Tag Logic: Runner touches Tagger (Freeze)
        if (runner.isSpectator) return;
        if (runner.isFrozen) return; // 이미 얼어있으면 면역

        // [Fix] 탈락 대신 얼음 상태로 전환
        runner.isFrozen = true;
        runner.isStunned = true; // 움직임 불가
        runner.color = 'aqua'; // Visual Feedback

        io.emit('playerMoved', runner);
        io.emit('gameMessage', `❄️ [${runner.nickname}] 님이 얼어붙었습니다!`);
        io.emit('effect', { type: 'freeze', x: runner.x, y: runner.y });

        checkIceWin();
    } else {
        // Runner touches Runner (Thaw Logic)
        // Optimization: Direct check instead of calling checkIceThaw
        if (target.isFrozen && !mover.isFrozen && !mover.isSpectator && mover.id !== taggerId) {
            // Thaw target
            target.isFrozen = false;
            target.isStunned = false;
            target.iceCooldown = Date.now() + 3000;
            if (mover.stats) mover.stats.rescueCount = (mover.stats.rescueCount || 0) + 1;

            io.emit('playerMoved', target);
            io.emit('gameMessage', `🧊🔨 [${mover.nickname}] 님이 [${target.nickname}] 님을 얼음에서 구출했습니다!`);
            io.emit('effect', { type: 'thaw', x: target.x, y: target.y });
        }
    }
};

// [New] 통합 카운트다운 함수
let universalCountdownTimer = null;
function startUniversalCountdown(mode, seconds, callback) {
    if (universalCountdownTimer) clearInterval(universalCountdownTimer);

    let count = seconds;
    const modeName = { 'TAG': '술래잡기', 'ZOMBIE': '좀비 감염', 'BOMB': '폭탄 돌리기', 'ICE': '얼음땡' }[mode] || mode;

    io.emit('gameMessage', `⏳ ${modeName} 모드가 ${count}초 뒤에 시작됩니다!`);

    universalCountdownTimer = setInterval(() => {
        count--;
        if (count > 0) {
            if (count <= 5) io.emit('gameMessage', `${count}...`);
        } else {
            clearInterval(universalCountdownTimer);
            universalCountdownTimer = null;
            io.emit('gameMessage', `🚀 ${modeName} 시작!`);
            if (callback) callback();
        }
    }, 1000);
}

const VotingManager = {
    candidates: [],
    votes: {}, // { socketId: candidateIndex }
    timer: null,
    duration: 15, // [Modified] 15초로 변경 (결과창 포함)
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

            // [Safety] TARGET_POPULATION에 없는 사이즈 키가 올 경우 M으로 대체
            const size = map.allowedSizes ? map.allowedSizes[map.allowedSizes.length - 1] : 'M';
            const popConfig = TARGET_POPULATION[size] || TARGET_POPULATION['M'];
            const targetCount = popConfig[selectedMode] || 8;

            mapCandidates.push({
                id: i, // 0, 1, 2
                type: 'MAP',
                name: map.name,
                size: size,
                mode: selectedMode, // 선택된 모드 전달
                targetCount: targetCount
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

        // [New] 모든 플레이어가 투표했으면 즉시 종료
        const currentPlayersCount = Object.keys(players).filter(id => !players[id].isSpectator && !players[id].isManualSpectator && !players[id].nickname.startsWith('Bot')).length;
        // 봇 제외, 실제 플레이어 수와 투표 수 비교
        // (단, 접속 중인 유저 수 기준으로 해야 더 정확할 수 있음. 현재는 players에 봇 포함이므로 필터링 필요)
        const realUserCount = Object.values(players).filter(p => !(p instanceof Bot)).length;

        if (Object.keys(this.votes).length >= realUserCount && realUserCount > 0) {
            io.emit('gameMessage', '⚡ 모든 플레이어가 투표했습니다! 즉시 결과를 공개합니다.');
            this.end();
        }
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

        // [Debug] 투표 결과 추적
        console.log(`[Voting] Stage: ${this.currentStage}, Winner: ${winnerCandidate.name}, Mode: ${winnerCandidate.mode}, Type: ${winnerCandidate.type}`);

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

        // [Fix] 모든 모드에 대해 resetGame 호출하여 게임 시작
        // [New] 새 게임 시작이므로 라운드 초기화
        currentRound = 1;
        resetGame();

        // ResetGame이 state를 Free로 둘 수 있으므로 강제 PLAYING
        serverState = ServerState.PLAYING;
        io.emit('votingEnd', { nextMap: currentMapName, mode: gameMode });
    }
}

// [Removed] Duplicate declarations (Moved to top)
// let roundTime = 0;
// let roundTimer = null;
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
            // [Stats] 아이템 획득 카운트
            if (player.stats) player.stats.itemCount = (player.stats.itemCount || 0) + 1;

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

    // [Refactoring] Delegate to GameRules
    if (GameRules[gameMode] && GameRules[gameMode].onCollision) {

        for (const targetId in players) {
            if (targetId === moverId) continue;
            const target = players[targetId];
            if (target.isSpectator) continue;

            // Basic Distance Check (Optimization)
            const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
            const threshold = (gameMode === 'BOMB' ? 40 : 30); // Bomb is 40, others 30

            if (dist < threshold) {
                GameRules[gameMode].onCollision(mover, target);
                // If one collision handles everything (like tag), we might break?
                // In legacy: 
                // TAG: break after tag.
                // ZOMBIE: continue (one zombie can infect multiple? or just one per tick?)
                // Legacy Zombie had 'continue' if stunned.
                // Let's assume onCollision handles necessary returns or state changes.
                // For TAG, we strictly 'break' after catch to prevent multi-tag?
                // Existing TAG logic had 'break'.

                if (gameMode === 'TAG' || gameMode === 'ICE') break;
                // Bomb also returns after pass.
                if (gameMode === 'BOMB') break;
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
        handleRoundEnd(); // [Fix] Use 5-Round System

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
        // console.log(`[Timer] ${roundTime}s`); // Debug
        io.emit('updateTimer', roundTime);

        if (roundTime <= 0) {
            clearInterval(roundTimer);

            // [New] 타이머 종료 시 모든 모드 공통: 투표로 전환
            // 각 모드별 결과 메시지는 여기서 처리

            if (gameMode === 'TAG') {
                // [TAG Mode] 시간 종료 -> 투표
                io.emit('gameMessage', '⏰ 시간 종료! 통계를 집계 중입니다...');

                // [New] 통계 계산 로직
                // 1. 필요한 데이터 추출
                const ids = Object.keys(players).filter(id => !players[id].isSpectator);
                const stats = ids.map(id => {
                    const p = players[id];
                    return {
                        nickname: p.nickname,
                        caught: p.stats?.caughtCount || 0, // 많이 잡힘 (동네북)
                        taggerTime: p.stats?.taggerTime || 0, // 술래 시간 (술래왕 - 피하고 싶은..)
                        items: p.stats?.itemCount || 0, // 아이템 (수집가)
                        distance: p.stats?.distance || 0 // 이동 거리 (닌자)
                    };
                });

                // 2. 각 부문별 1위 선정
                const mostCaught = [...stats].sort((a, b) => b.caught - a.caught)[0];
                const longestTagger = [...stats].sort((a, b) => b.taggerTime - a.taggerTime)[0];
                const mostItems = [...stats].sort((a, b) => b.items - a.items)[0];
                const mostDistance = [...stats].sort((a, b) => b.distance - a.distance)[0]; // Ninja

                const resultData = {
                    mode: 'TAG_STATS', // 클라이언트 분기용
                    categories: {
                        victim: mostCaught && mostCaught.caught > 0 ? { name: mostCaught.nickname, val: mostCaught.caught + '회' } : { name: '-', val: '-' },
                        host: longestTagger && longestTagger.taggerTime > 0 ? { name: longestTagger.nickname, val: (longestTagger.taggerTime / 20).toFixed(1) + '초' } : { name: '-', val: '-' }, // 20 ticks = 1s
                        collector: mostItems && mostItems.items > 0 ? { name: mostItems.nickname, val: mostItems.items + '개' } : { name: '-', val: '-' },
                        ninja: mostDistance && mostDistance.distance > 0 ? { name: mostDistance.nickname, val: Math.floor(mostDistance.distance) + 'px' } : { name: '-', val: '-' }
                    }
                };

                io.emit('gameResult', resultData);

                // [Modified] 5라운드 체크로 위임
                handleRoundEnd();

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
                // [Modified] 5라운드 체크로 위임
                handleRoundEnd();

            } else if (gameMode === 'ICE') {
                // [얼음땡 도망자 승리] (시간 초과)
                sendIceResult('runners');
            }
        }
    }, 1000);
}

// [New] 5-Round System
let currentRound = 1;
const MAX_ROUNDS = 5;

// [New] Round End Handler
let isRoundEnding = false; // [Fix] Guard variable for re-entrancy

function handleRoundEnd() {
    // [Fix] 이미 종료 처리 중이면 무시
    if (isRoundEnding) return;
    isRoundEnding = true;

    // 5초 대기 후 결정 (결과창 보는 시간)
    setTimeout(() => {
        isRoundEnding = false; // [Fix] Reset guard before next round starts
        currentRound++;
        if (currentRound <= MAX_ROUNDS) {
            // 다음 라운드 진행
            io.emit('gameMessage', `📢 ${currentRound} / ${MAX_ROUNDS} 라운드 시작!`);
            io.emit('roundUpdate', { current: currentRound, total: MAX_ROUNDS });
            resetGame();
        } else {
            // 모든 라운드 종료 -> 투표
            currentRound = 1; // 초기화
            startVotingPhase();
        }
    }, 5000); // 5초 대기
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
    bot.playerId = botId; // [Fix] Ensure playerId exists for io.to() calls
    bot.x = spawn.x;
    bot.y = spawn.y;
    bot.targetX = spawn.x;
    bot.targetY = spawn.y;

    // [통계] 봇 통계 초기화
    bot.stats = {
        distance: 0,
        infectionCount: 0,
        survivalTime: 0,
        caughtCount: 0,
        itemCount: 0,
        taggerTime: 0
    };

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

    // [Fix] Remove auto-tagger assignment (Handled by GameRules or Attract logic)
    // if (!taggerId) { ... }
}

// 리셋 확인용 변수
let resetRequestTime = 0;
let resetRequesterId = null;



function resetGame() {
    isRoundEnding = false; // [Fix] Ensure round ending guard is reset
    if (roundTimer) clearInterval(roundTimer);
    // [버그 수정] 진행 중인 좀비 카운트다운 취소
    if (zombieSpawnTimer) {
        clearInterval(zombieSpawnTimer);
        zombieSpawnTimer = null;
    }
    // [Fix] Clear Universal Countdown Timer
    if (universalCountdownTimer) {
        clearInterval(universalCountdownTimer);
        universalCountdownTimer = null;
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

    // [Fix] Reset Tagger ID completely before loop
    taggerId = null;
    lastTaggerId = null;
    bombHolderId = null;
    io.emit('updateTagger', null); // 클라이언트 술래 표시 해제

    // [Safety] 얼음땡 모드 시작 시점에는 확실히 술래가 없어야 함 (카운트다운 동안)


    // 플레이어 재배치 및 초기화
    Object.keys(players).forEach(id => {
        const p = players[id];
        const spawn = getRandomSpawn(currentMapData, validSpawnPoints);
        p.x = spawn.x;
        p.y = spawn.y;

        p.targetX = p.x;
        p.targetY = p.y;

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

        // [Modified] 모든 관전자 해제 (수동 관전자 포함)
        // 다음 게임에는 모두 참여
        p.isSpectator = false;
        p.isManualSpectator = false; // 수동 관전 상태도 해제

        // [수정] 색상 복구 (폭탄 모드 탈락 등에서 변한 색상 원복)
        // originalColor가 없으면 initialColor, 그것도 없으면 기본값
        if (p.originalColor) p.color = p.originalColor;
        else if (p.initialColor) p.color = p.initialColor;
        else p.color = '#e74c3c'; // Fallback

        // [통계] 초기화
        p.stats = { distance: 0, infectionCount: 0, survivalTime: 0 };

        // [추가] 클라이언트 인벤토리 초기화 이벤트 전송
        io.to(id).emit('updateInventory', null);
    });

    // [통계] 전역 변수 초기화
    gameStartTime = 0;
    initialHostId = null;

    // 봇 다시 소환
    for (let i = 0; i < botCount; i++) {
        createBot();
    }

    // 모드별 초기화
    // [Smart Tagger Selection] -> GameRules로 위임
    if (GameRules[gameMode]) {
        GameRules.start(gameMode);
    } else {
        console.error(`[StartError] Unknown GameMode: ${gameMode}`);
        io.emit('gameMessage', '⚠️ 게임 모드 설정 오류');
    }

    io.emit('currentPlayers', players);
    io.emit('gameMode', gameMode);

    const msg = `🔄 게임 리셋! 모드: ${gameMode}`;
    io.emit('gameMessage', msg);

    // [Fix] 라운드 정보 즉시 업데이트
    io.emit('roundUpdate', { current: currentRound, total: MAX_ROUNDS });
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
        } else if ((gameMode === 'BOMB' && bombEndTime > 0) || (gameMode === 'ICE' && taggerId)) {
            // [폭탄/얼음 모드] 진행 중 난입 시 관전자
            isSpectator = true;
            initialColor = 'rgba(255, 255, 255, 0.3)';
            const modeName = gameMode === 'BOMB' ? '💣 폭탄' : '❄️ 얼음땡';
            joinMsg = `${modeName} 모드 진행 중이라 관전자로 입장합니다.`;
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
        socket.emit('currentPlayers', players);        // [Fix] 현재 라운드 정보 전달
        socket.emit('roundUpdate', { current: currentRound, total: MAX_ROUNDS });

        // 아이템 상태 전송
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

    // [New] Cheat Command: Finish all rounds
    if (cmd === '/finish') {
        const finishMsg = `⚡ [${player.nickname}] 님이 강제로 모든 라운드를 종료했습니다!`;
        io.emit('gameMessage', finishMsg);
        io.emit('chatMessage', { nickname: 'System', message: finishMsg, playerId: 'system' });

        // Force end
        if (roundTimer) clearInterval(roundTimer);
        currentRound = MAX_ROUNDS; // Set to max so handleRoundEnd triggers voting
        handleRoundEnd(); // Will detect max rounds and go to voting
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
            const p = players[id];

            // [Stats] 술래 시간 측정 (TAG 모드)
            if (gameMode === 'TAG' && id === taggerId) {
                if (p.stats) p.stats.taggerTime = (p.stats.taggerTime || 0) + 1;
            }

            if (p instanceof Bot) {
                // [중요] 봇에게 게임 state와 callback 전달
                // gameMode 추가 전달 (BOMB 모드면 bombHolderId를 술래로 취급)
                const currentTaggerId = (gameMode === 'BOMB') ? bombHolderId : taggerId;

                p.update(players, currentTaggerId, lastTaggerId, {
                    handleItemEffect: handleItemEffect,
                    handleBotAction: handleBotAction
                }, currentMapData, gameMode);

                // 동기화
                io.emit('playerMoved', p);
                checkCollision(id);
                checkItemCollection(id);
                checkTrapCollision(id);

                // [Fix] 바나나(isSlipped) 상태 해제 체크
                if (p.isSlipped && p.slipStartTime) {
                    if (Date.now() - p.slipStartTime > 3000) {
                        p.isSlipped = false;
                        p.slipStartTime = 0;
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

        // [Modified] 스마트 술래 선정 적용 (폭탄 시작)
        // const holderId = currentSurvivors[Math.floor(Math.random() * currentSurvivors.length)];
        const holderId = getSmartTagger(currentSurvivors);
        if (!holderId) return; // 전원 제외 시 (발생 희박)

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
                handleRoundEnd(); // [Fix] Use 5-Round System
            } else if (survivors.length === 0) {
                // 모두 멸망? (동시 폭사 등)
                io.emit('gameMessage', `💀 생존자가 없습니다... 게임 오버.`);
                handleRoundEnd(); // [Fix] Use 5-Round System
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
    io.emit('gameMessage', '🗳️ 투표 시작! 다음 게임 모드를 선택하세요.');

    // [Modified] 딜레이 없이 즉시 시작 (결과창과 동시에 진행)
    VotingManager.startModeVoting();
}


// [New] Ice Mode Helpers (Restored)
function checkIceThaw(playerId) {
    const mover = players[playerId];
    if (!mover || mover.isSpectator || mover.isFrozen) return;

    for (const targetId in players) {
        if (targetId === playerId) continue;
        const target = players[targetId];

        if (target.isSpectator) continue;
        if (!target.isFrozen) continue;

        const dist = Math.hypot(mover.x - target.x, mover.y - target.y);
        if (dist < 30) {
            // Thaw!
            target.isFrozen = false;
            target.isStunned = false;
            target.iceCooldown = Date.now() + 3000; // Immunity after thaw

            // [Stats] Rescue count
            if (mover.stats) mover.stats.rescueCount = (mover.stats.rescueCount || 0) + 1;

            io.emit('playerMoved', target);
            io.emit('gameMessage', `🧊🔨 [${mover.nickname}] 님이 [${target.nickname}] 님을 얼음에서 구출했습니다!`);
            io.emit('effect', { type: 'thaw', x: target.x, y: target.y });
        }
    }
}

function checkIceWin() {
    if (gameMode !== 'ICE') return;

    const ids = Object.keys(players).filter(id => !players[id].isSpectator);
    const runners = ids.filter(id => id !== taggerId);

    const activeRunners = runners.filter(id => {
        const p = players[id];
        return !p.isEliminated && !p.isFrozen;
    });

    if (activeRunners.length === 0 && runners.length > 0) {
        sendIceResult('tagger');
    }
}

function sendIceResult(winner) {
    if (serverState === ServerState.VOTING) return;

    let msg = '';
    if (winner === 'tagger') msg = '🥶 모든 생존자가 얼어붙었습니다! 술래 승리!';
    else msg = '🏃‍♂️ 시간이 종료되었습니다! 도망자 승리!';

    io.emit('gameMessage', msg);

    const ids = Object.keys(players);
    const tagger = players[taggerId];

    io.emit('gameResult', {
        mode: 'ICE',
        winner: winner,
        taggerName: tagger ? tagger.nickname : 'Unknown'
    });

    if (roundTimer) clearInterval(roundTimer);
    handleRoundEnd();
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
            bot.playerId = botId; // [Fix] Ensure playerId exists
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


