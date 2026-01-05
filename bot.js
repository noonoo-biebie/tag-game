const { ROWS, COLS, TILE_SIZE, BOT_PERSONALITIES } = require('./config');
const { getRandomSpawn, checkBotWallCollision, checkLineOfSight } = require('./utils');

class Bot {
    constructor(id, mapData) {
        this.id = id;
        this.playerId = id; // 클라이언트 호환성
        this.nickname = '🤖Bot_' + id.slice(0, 4);
        this.color = this.getRandomColor();
        this.personality = this.getRandomPersonality();

        const spawn = getRandomSpawn(mapData);
        this.x = spawn.x;
        this.y = spawn.y;
        this.targetX = this.x; // 이동 목표
        this.targetY = this.y;

        // 상태
        this.hasItem = null;
        this.hasShield = false;
        this.isSpeeding = false;
        this.isSlipped = false; // 미끄러짐 상태 추가
        this.slipDir = { x: 0, y: 0 }; // 미끄러짐 방향

        // 기절 관련
        this.stunnedUntil = 0;

        // AI 제어 변수

        this.wanderTarget = null; // 배회 목표 지점
        this.moveDir = { x: 0, y: 0 };

        // 끼임 감지 (좌절 로직)
        this.lastCheckPos = { x: this.x, y: this.y };
        this.lastCheckTime = Date.now();
        this.isStuck = false; // 끼임 상태 플래그

        // 추격 기억 시스템 (Last Known Position)
        this.chaseMemory = null; // { x, y, id, timestamp }

        // 도망 상태 (Hysteresis)
        this.isFleeing = false;

        // 비비기 타이머
        this.wiggleTimer = 0;

        // [공포 시스템] 지속적인 도망을 위한 변수
        this.fearTimer = 0;
        this.lastFleeAngle = 0;
    }

    getRandomColor() {
        const colors = ['#e67e22', '#1abc9c', '#9b59b6', '#e84393', '#f1c40f', '#3498db'];
        return colors[Math.floor(Math.random() * colors.length)];
    }

    getRandomPersonality(existingPlayers = {}) {
        const allTypes = Object.values(BOT_PERSONALITIES);
        const currentCounts = {};
        allTypes.forEach(type => currentCounts[type] = 0);

        // 현재 존재하는 봇들의 성격 카운트
        for (const id in existingPlayers) {
            if (existingPlayers[id] instanceof Bot && existingPlayers[id].personality) {
                currentCounts[existingPlayers[id].personality]++;
            }
        }

        // 가장 적게 등장한 횟수 찾기
        let minCount = Infinity;
        for (const type of allTypes) {
            if (currentCounts[type] < minCount) {
                minCount = currentCounts[type];
            }
        }

        // 최소 등장 횟수인 성격들 중에서 랜덤 선택
        const candidates = allTypes.filter(type => currentCounts[type] === minCount);
        return candidates[Math.floor(Math.random() * candidates.length)];
    }

    // 메인 업데이트 루프 (Refactored)
    update(players, taggerId, lastTaggerId, callbacks, mapData, gameMode = 'TAG') {
        // [0] 관전 모드 (Ghost)
        if (this.isSpectator) {
            this.processGhostBehavior(mapData);
            return;
        }

        // [0] 기절 상태 체크
        if (this.stunnedUntil && Date.now() < this.stunnedUntil) return;

        // 1. 미끄러짐 처리
        if (this.handleSlip(mapData)) return;

        // 2. 끼임 감지 (0.5초마다)
        if (Date.now() - this.lastCheckTime > 500) {
            const distMoved = Math.hypot(this.x - this.lastCheckPos.x, this.y - this.lastCheckPos.y);
            this.isStuck = (distMoved < 10);
            this.lastCheckPos = { x: this.x, y: this.y };
            this.lastCheckTime = Date.now();
        }

        // 3. 환경 스캔 (타겟 및 시야)
        const env = this.scanEnvironment(players, taggerId, lastTaggerId, mapData, gameMode);

        // 4. 행동 결정 (추격자 vs 도망자)
        if (env.isChaser) {
            this.processChaserBehavior(env.target, env.canSee, mapData);
        } else {
            this.processSurvivorBehavior(env.target, env.canSee, mapData);
        }

        // 5. 아이템 사용
        this.useItemLogic(callbacks.handleItemEffect);
    }

    // [Helper] 미끄러짐 처리
    handleSlip(mapData) {
        if (!this.isSlipped) return false;

        if (Date.now() - this.slipStartTime > 10000) {
            this.isSlipped = false;
            return false;
        }

        const slipSpeed = 25;
        let nextX = this.x + this.slipDir.x * slipSpeed;
        let nextY = this.y + this.slipDir.y * slipSpeed;

        // 맵 경계 체크
        const mapRows = mapData.length;
        const mapCols = mapData[0].length;
        if (nextX < 0) nextX = 0; else if (nextX > (mapCols - 1) * TILE_SIZE) nextX = (mapCols - 1) * TILE_SIZE;
        if (nextY < 0) nextY = 0; else if (nextY > (mapRows - 1) * TILE_SIZE) nextY = (mapRows - 1) * TILE_SIZE;

        if (checkBotWallCollision(nextX, nextY, mapData)) {
            this.isSlipped = false;
        } else {
            const distMoved = Math.hypot(this.x - nextX, this.y - nextY);
            if (distMoved < 0.1) {
                this.isSlipped = false;
            } else {
                this.x = nextX;
                this.y = nextY;
            }
        }
        return true; // 미끄러지는 중임
    }

    // [New] 유령 행동 (관전 모드)
    processGhostBehavior(mapData) {
        // 벽 무시하고 천천히 배회
        if (!this.moveDir || (this.moveDir.x === 0 && this.moveDir.y === 0) || Math.random() < 0.02) {
            const angle = Math.random() * Math.PI * 2;
            this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
        }

        // 속도는 느리게
        const speed = 10;
        this.x += this.moveDir.x * speed;
        this.y += this.moveDir.y * speed;

        // 맵 밖으로 너무 멀리 나가지 않게 (경계 체크는 유지하거나 넓게)
        // 맵 밖으로 너무 멀리 나가지 않게 (경계 체크는 유지하거나 넓게)
        const mapRows = mapData.length;
        const mapCols = mapData[0].length;
        if (this.x < -100) this.moveDir.x = Math.abs(this.moveDir.x);
        if (this.x > (mapCols * TILE_SIZE) + 100) this.moveDir.x = -Math.abs(this.moveDir.x);
        if (this.y < -100) this.moveDir.y = Math.abs(this.moveDir.y);
        if (this.y > (mapRows * TILE_SIZE) + 100) this.moveDir.y = -Math.abs(this.moveDir.y);
    }

    // [Helper] 환경 스캔
    scanEnvironment(players, taggerId, lastTaggerId, mapData, gameMode) {
        let isChaser = false;
        if (gameMode === 'ZOMBIE') {
            isChaser = this.isZombie;
        } else {
            // [Server Fix] server.js passes currentTaggerId as 'taggerId' arg
            isChaser = (taggerId === this.id);
        }

        let target = null;
        let canSee = false;

        if (isChaser) {
            // 추격자: 보이는 가장 가까운 타겟 검색
            target = this.findBestTarget(players, lastTaggerId, mapData, gameMode);
            // if (gameMode === 'BOMB' && isChaser && !target) console.log(`[Bot ${this.nickname}] 폭탄 들고 헤매는 중... (타겟 없음)`);
            if (target) canSee = true;
        } else {
            // 도망자: 가장 가까운 위협 검색
            let distToThreat = Infinity;
            if (gameMode === 'ZOMBIE') {
                for (const pid in players) {
                    if (pid === this.id) continue;
                    if (players[pid].isZombie) {
                        const d = Math.hypot(players[pid].x - this.x, players[pid].y - this.y);
                        if (d < distToThreat) {
                            distToThreat = d;
                            target = players[pid];
                        }
                    }
                }
            } else {
                if (taggerId && players[taggerId]) {
                    target = players[taggerId];
                    distToThreat = Math.hypot(target.x - this.x, target.y - this.y);
                }
            }

            // 시야 체크 (250px)
            if (target && distToThreat < 250) {
                if (checkLineOfSight(this.x + 16, this.y + 16, target.x + 16, target.y + 16, mapData)) {
                    canSee = true;
                }
            }
        }

        return { isChaser, target, canSee };
    }

    // [Helper] 추격자 행동 로직
    processChaserBehavior(target, canSee, mapData) {
        if (canSee) {
            // 1. 발견: 추격 및 위치 기억
            this.patrolTarget = null;
            this.searchTimer = 0; // [Fix] 기존 수색 타이머 초기화 (안 하면 이전 타이머 만료로 즉시 포기함)
            this.chaseMemory = { x: target.x, y: target.y };

            // 끼임 방지 (무한 대치 해결)
            if (this.resolveStuck(mapData)) return;

            const angle = Math.atan2(target.y - this.y, target.x - this.x);
            this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            this.moveToDir(mapData);
        } else if (this.chaseMemory) {
            // 2. 미발견 + 기억 있음: 기억 장소로 이동
            if (this.resolveStuck(mapData)) return;

            const dx = this.chaseMemory.x - this.x;
            const dy = this.chaseMemory.y - this.y;

            if (Math.hypot(dx, dy) < 32) {
                // 도착 후 수색 (2초)
                if (!this.searchTimer) this.searchTimer = Date.now() + 2000;

                if (Date.now() < this.searchTimer) {
                    if (Math.random() < 0.1) {
                        const searchAngle = Math.random() * Math.PI * 2;
                        this.moveDir = { x: Math.cos(searchAngle), y: Math.sin(searchAngle) };
                    }
                    this.moveToDir(mapData);
                } else {
                    // 수색 종료 -> 순찰
                    this.chaseMemory = null;
                    this.searchTimer = 0;
                    this.doPatrol(mapData);
                }
            } else {
                // 기억 장소로 계속 이동
                const angle = Math.atan2(dy, dx);
                this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
                this.moveToDir(mapData);
            }
        } else {
            // 3. 평소: 순찰
            this.doPatrol(mapData);
        }
    }

    // [Helper] 도망자 행동 로직
    processSurvivorBehavior(target, canSee, mapData) {
        if (canSee) {
            // 1. 발견: 공포 모드 ON & 도망
            this.fearTimer = Date.now() + 2500;
            this.lastFleeAngle = Math.atan2(this.y - target.y, this.x - target.x);
            this.moveDir = { x: Math.cos(this.lastFleeAngle), y: Math.sin(this.lastFleeAngle) };

            // 패닉 무빙 (끼임 시)
            if (this.isStuck) {
                const panicAngle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
                this.lastFleeAngle = panicAngle;
            }
            this.moveToDir(mapData);
        } else if (Date.now() < this.fearTimer) {
            // 2. 공포 지속: 계속 도망
            this.isFleeing = true;
            this.moveDir = { x: Math.cos(this.lastFleeAngle), y: Math.sin(this.lastFleeAngle) };

            if (this.isStuck) {
                const panicAngle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
                this.lastFleeAngle = panicAngle;
            }
            this.moveToDir(mapData);
        } else {
            // 3. 평소: 순찰
            this.isFleeing = false;
            this.doPatrol(mapData);
        }
    }

    // [Helper] 끼임 해결 (Wiggle) - true 리턴 시 이미 이동함
    resolveStuck(mapData) {
        if (this.isStuck) {
            if (!this.wiggleTimer || Date.now() - this.wiggleTimer > 300) {
                const wiggleAngle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(wiggleAngle), y: Math.sin(wiggleAngle) };
                this.wiggleTimer = Date.now();
            }
            this.moveToDir(mapData);
            return true;
        }
        return false;
    }

    doPatrol(mapData) {
        if (!this.patrolTarget || this.isStuck) {
            this.patrolTarget = getRandomSpawn(mapData);
            this.isStuck = false;
        }

        const dist = Math.hypot(this.patrolTarget.x - this.x, this.patrolTarget.y - this.y);

        if (dist < 40) {
            this.patrolTarget = null;
        } else {
            const dx = this.patrolTarget.x - this.x;
            const dy = this.patrolTarget.y - this.y;
            const angle = Math.atan2(dy, dx);
            this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            this.moveToDir(mapData);
        }
    }

    moveToDir(mapData) {
        const speed = this.isSpeeding ? 25 : 15;

        // X축
        let nextX = this.x + this.moveDir.x * speed;
        let hitX = false;
        const mapRows = mapData.length;
        const mapCols = mapData[0].length;

        if (nextX < 0) { nextX = 0; hitX = true; }
        if (nextX > (mapCols - 1) * TILE_SIZE) { nextX = (mapCols - 1) * TILE_SIZE; hitX = true; }

        // [Spectator] 벽 무시
        if (!this.isSpectator) {
            if (checkBotWallCollision(nextX, this.y, mapData)) hitX = true;
            else this.x = nextX;
        } else {
            this.x = nextX;
        }

        // Y축
        let nextY = this.y + this.moveDir.y * speed;
        let hitY = false;
        if (nextY < 0) { nextY = 0; hitY = true; }
        if (nextY > (mapRows - 1) * TILE_SIZE) { nextY = (mapRows - 1) * TILE_SIZE; hitY = true; }

        // [Spectator] 벽 무시
        if (!this.isSpectator) {
            if (checkBotWallCollision(this.x, nextY, mapData)) hitY = true;
            else this.y = nextY;
        } else {
            this.y = nextY;
        }

        // 양방향 막힘 시 랜덤 탈출 (끼임 방지)
        if (hitX || hitY) {
            if (hitX && hitY && this.path.length === 0) {
                this.x -= this.moveDir.x * 5;
                this.y -= this.moveDir.y * 5;
                const angle = Math.random() * Math.PI * 2;
                this.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };
            } else {
                this.moveDir.x += (Math.random() - 0.5) * 0.2;
                this.moveDir.y += (Math.random() - 0.5) * 0.2;
                const mag = Math.sqrt(this.moveDir.x ** 2 + this.moveDir.y ** 2);
                if (mag > 0) { this.moveDir.x /= mag; this.moveDir.y /= mag; }
            }
        }
    }



    findBestTarget(players, lastTaggerId, mapData, gameMode = 'TAG') {
        let closest = null;
        let minDist = Infinity;
        for (const pid in players) {
            if (pid === this.id) continue;
            const p = players[pid];

            // 타겟 필터링
            if (gameMode === 'ZOMBIE') {
                // 좀비는 생존자(비좀비)만 추격
                if (p.isZombie) continue;
            } else {
                // 기본 술래잡기: 기절한 사람 제외
                if (p.stunnedUntil && Date.now() < p.stunnedUntil) continue;
            }

            // [Bomb/General] 관전자 제외 (확실하게)
            if (p.isSpectator || p.isManualSpectator) continue;

            const dist = Math.hypot(p.x - this.x, p.y - this.y);

            // 시야 체크
            const isVisible = checkLineOfSight(this.x + 16, this.y + 16, p.x + 16, p.y + 16, mapData);

            if (dist < minDist && isVisible) {
                minDist = dist;
                closest = p;
            }
        }
        return closest;
    }

    useItemLogic(handleItemEffectCallback) {
        if (!this.hasItem) return;
        let useChance = 0.05;

        if (this.personality === BOT_PERSONALITIES.AGGRESSIVE) {
            if (this.hasItem === 'speed') useChance = 0.2;
        } else if (this.personality === BOT_PERSONALITIES.PLAYFUL) {
            if (this.hasItem === 'banana') useChance = 0.1;
        } else if (this.personality === BOT_PERSONALITIES.COWARD) {
            if (this.hasItem === 'shield' || this.hasItem === 'speed') useChance = 0.2;
        }

        if (Math.random() < useChance) {
            if (handleItemEffectCallback) {
                handleItemEffectCallback(this.id, this.hasItem);
            }
            this.hasItem = null;
        }
    }
}

module.exports = Bot;
