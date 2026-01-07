const fs = require('fs');
const path = require('path');

let loadedMaps = {};

function loadMaps() {
    loadedMaps = {};
    const mapsDir = path.join(__dirname, 'maps');

    if (!fs.existsSync(mapsDir)) {
        console.error("[MapLoader] 'maps' directory not found!");
        return loadedMaps;
    }

    const files = fs.readdirSync(mapsDir);

    files.forEach(file => {
        if (file.endsWith('.js')) {
            try {
                const mapPath = path.join(mapsDir, file);
                delete require.cache[require.resolve(mapPath)]; // Clear cache for reload

                const mapModule = require(mapPath);

                if (mapModule.name && (mapModule.data || mapModule.generate)) {
                    loadedMaps[mapModule.name] = mapModule;
                    // console.log(`[MapLoader] Loaded: ${mapModule.name} (Sizes: ${mapModule.allowedSizes || 'ALL'})`);
                } else {
                    console.warn(`[MapLoader] Skipped invalid: ${file}`);
                }
            } catch (err) {
                console.error(`[MapLoader] Error loading ${file}:`, err);
            }
        }
    });

    return loadedMaps;
}

function getRandomMap(size = 'M') {
    const candidates = Object.values(loadedMaps).filter(map => {
        // 1. Test 맵 제외 (명령어로 직접 호출해야 함)
        if (map.isTest) return false;

        // 2. 해당 사이즈 지원 여부 확인
        if (map.allowedSizes && !map.allowedSizes.includes(size)) return false;

        return true;
    });

    if (candidates.length === 0) {
        console.warn(`[MapLoader] No map found for size '${size}'. Fallback to ANY.`);
        const fallback = Object.values(loadedMaps).filter(m => !m.isTest);
        if (fallback.length === 0) return null;
        return fallback[Math.floor(Math.random() * fallback.length)];
    }

    const picked = candidates[Math.floor(Math.random() * candidates.length)];
    console.log(`[MapLoader] Random Pick (${size}): ${picked.name}`);
    return picked;
}

function getMap(name) {
    return loadedMaps[name] || null;
}

module.exports = { loadMaps, getRandomMap, getMap };
