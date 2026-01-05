
// ice_bot.js
// 얼음땡 모드 전용 봇 행동 로직

// 가장 가까운 얼어있는 플레이어 찾기
function findNearestFrozenPlayer(bot, players) {
    let nearest = null;
    let minDist = Infinity;

    for (const id in players) {
        const p = players[id];
        if (p.id === bot.id) continue;
        if (p.isSpectator) continue;
        if (!p.isFrozen) continue;

        // 얼어있는 사람만 타겟
        const dist = Math.hypot(p.x - bot.x, p.y - bot.y);
        if (dist < minDist) {
            minDist = dist;
            nearest = p;
        }
    }
    return nearest;
}

// 얼음땡 모드 생존자 행동
function processIceSurvivorBehavior(bot, target, canSee, mapData, players) {
    // 1. 술래 발견 시 (도망 + 긴급 얼음)
    if (canSee) {
        // 공포 모드 ON & 도망
        bot.fearTimer = Date.now() + 2500;
        bot.lastFleeAngle = Math.atan2(bot.y - target.y, bot.x - target.x);
        bot.moveDir = { x: Math.cos(bot.lastFleeAngle), y: Math.sin(bot.lastFleeAngle) };

        // [긴급 얼음] 조건: 추격 1초 경과 + 거리 80px 이내
        const dist = Math.hypot(target.x - bot.x, target.y - bot.y);
        if (dist < 80 && bot.chaseStartTime > 0 && Date.now() - bot.chaseStartTime > 1200) {
            if (bot.callbacks && bot.callbacks.handleBotAction) {
                bot.callbacks.handleBotAction(bot.id, 'ice');
            }
        }

        // 패닉 무빙 (끼임 시)
        if (bot.isStuck) {
            const panicAngle = Math.random() * Math.PI * 2;
            bot.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
            bot.lastFleeAngle = panicAngle;
        }
        bot.moveToDir(mapData);
        return;
    }

    // 2. 공포 지속 (도망)
    if (Date.now() < bot.fearTimer) {
        bot.isFleeing = true;
        bot.moveDir = { x: Math.cos(bot.lastFleeAngle), y: Math.sin(bot.lastFleeAngle) };

        if (bot.isStuck) {
            const panicAngle = Math.random() * Math.PI * 2;
            bot.moveDir = { x: Math.cos(panicAngle), y: Math.sin(panicAngle) };
            bot.lastFleeAngle = panicAngle;
        }
        bot.moveToDir(mapData);
        return;
    }

    // 3. 안전함 -> 구출 작전
    const frozenTarget = findNearestFrozenPlayer(bot, players);
    if (frozenTarget) {
        bot.isFleeing = false;
        // 구출 대상으로 이동
        const angle = Math.atan2(frozenTarget.y - bot.y, frozenTarget.x - bot.x);
        bot.moveDir = { x: Math.cos(angle), y: Math.sin(angle) };

        // 끼임 해결
        if (bot.resolveStuck(mapData)) return;

        bot.moveToDir(mapData);
        return;
    }

    // 4. 할 일 없음 -> 순찰
    bot.isFleeing = false;
    bot.doPatrol(mapData);
}

module.exports = {
    processIceSurvivorBehavior
};
