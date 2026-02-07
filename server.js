const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const path = require('path');

app.use(express.static(path.join(__dirname, 'public')));

// --- 游戏核心数据 ---
const CONFIG = { rooms: 5, slots: 4 };
let gameState = {
    players: [], // { id: socket.id, name: 'P1', color: '...', r: null, s: 0, hp: 3, ap: 3, alive: true }
    demon: { r: null },
    shards: [],
    turnIdx: 0,     // 当前回合属于 players 数组中的第几个人
    phase: 'LOBBY', // LOBBY, SETUP, PLAYING
    setupStep: 0,   // 投掷阶段进度
    logs: []        // 游戏日志
};

const COLORS = ['#ff4757', '#ffa502', '#3742fa']; 
const P_COLORS = ['#00d2d3', '#e056fd', '#ff9f43', '#2ecc71', '#ff6b81'];

// 初始化碎片数据
function initShards() {
    gameState.shards = [];
    for(let r=0; r<CONFIG.rooms; r++) {
        for(let s=0; s<CONFIG.slots; s++) {
            gameState.shards.push({
                r, s, 
                rot: Math.floor(Math.random()*3)*120,
                edges: [Math.floor(Math.random()*3), Math.floor(Math.random()*3), Math.floor(Math.random()*3)]
            });
        }
    }
}
initShards();

io.on('connection', (socket) => {
    console.log('玩家连接:', socket.id);

    // 1. 玩家加入
    socket.on('joinGame', (playerName) => {
        if(gameState.phase !== 'LOBBY') {
            socket.emit('errorMsg', '游戏已在进行中，无法加入');
            return;
        }
        if(gameState.players.length >= 5) {
            socket.emit('errorMsg', '房间已满');
            return;
        }

        const pId = gameState.players.length;
        gameState.players.push({
            id: socket.id,
            publicId: pId, // 0-4
            name: playerName || `玩家${pId+1}`,
            color: P_COLORS[pId],
            r: null, s: 1, hp: 3, ap: 3, alive: true
        });

        io.emit('updateState', gameState);
        io.emit('log', `✅ ${playerName} 加入了游戏`);
    });

    // 2. 开始游戏 (房主/第一个人触发)
    socket.on('startGame', () => {
        if(gameState.players.length > 0 && gameState.phase === 'LOBBY') {
            gameState.phase = 'SETUP';
            gameState.setupStep = 0;
            io.emit('updateState', gameState);
            io.emit('log', `🎲 游戏开始！进入投掷阶段`);
        }
    });

    // 3. 投掷骰子 (处理出生点)
    socket.on('rollDice', () => {
        // 校验是否轮到该玩家
        if(gameState.phase !== 'SETUP') return;
        
        const isPlayerRoll = gameState.setupStep < gameState.players.length;
        
        if (isPlayerRoll) {
            const currentPlayer = gameState.players[gameState.setupStep];
            if(socket.id !== currentPlayer.id) return; // 不是你在扔

            const roll = Math.floor(Math.random() * 5);
            currentPlayer.r = roll;
            io.emit('log', `🎲 ${currentPlayer.name} 掷出了 ${roll+1}`);
            gameState.setupStep++;
        } else {
            // 恶魔投掷 (由最后一个人触发)
            const roll = Math.floor(Math.random() * 5);
            gameState.demon.r = roll;
            io.emit('log', `👹 恶魔降临 R${roll+1}`);
            gameState.phase = 'PLAYING';
            gameState.turnIdx = 0;
        }
        io.emit('updateState', gameState);
    });

    // 4. 游戏内动作 (旋转、移动、交换、结束)
    socket.on('action', (data) => {
        if(gameState.phase !== 'PLAYING') return;
        
        const pIdx = gameState.turnIdx;
        const player = gameState.players[pIdx];
        if(!player || player.id !== socket.id) return; // 不是你的回合

        handleAction(player, data);
        io.emit('updateState', gameState);
    });

    socket.on('disconnect', () => {
        console.log('玩家断开:', socket.id);
        // 简单处理：如果在大厅，直接移除；如果在游戏，标记死亡
        if(gameState.phase === 'LOBBY') {
            gameState.players = gameState.players.filter(p => p.id !== socket.id);
            io.emit('updateState', gameState);
        } else {
            const p = gameState.players.find(p => p.id === socket.id);
            if(p) { 
                p.alive = false; 
                p.name += "(离线)";
                io.emit('updateState', gameState);
            }
        }
    });
});

// --- 逻辑处理函数 ---
// --- 逻辑处理函数 ---
// --- 逻辑处理函数 ---
function handleAction(player, data) {
    const { type, selected } = data; 
    
    // 1. 优先处理“结束回合” (无需目标，无需AP)
    if (type === 'endTurn') {
        nextTurn();
        return;
    }

    if (!selected) return;

    // 2. 检查 AP
    const cost = (type === 'swap') ? 2 : 1;
    if (player.ap < cost) return;

    // 获取目标碎片
    const shard = gameState.shards.find(s => s.r === selected.r && s.s === selected.s);
    if (!shard) return;

    // 3. 执行具体动作
    if (type === 'rotate') {
        if(selected.r !== player.r) return;
        if(player.r === gameState.demon.r) return;
        
        shard.rot = (shard.rot + 120) % 360;
        player.ap -= 1;
        io.emit('log', `🔄 ${player.name} 旋转了碎片`);

    } else if (type === 'move') {
        // 【关键修复】 在这里加入连通性检查！
        const currentPos = { r: player.r, s: player.s };
        const targetPos = { r: selected.r, s: selected.s };

        // 这里的逻辑：如果不是原地不动，且检查连接失败，则拒绝移动
        if (currentPos.r === targetPos.r && currentPos.s === targetPos.s) return;
        
        const connection = checkConnection(currentPos, targetPos);
        
        if (!connection.ok) {
            // 可选：给该玩家发送一个错误提示（需要前端监听 errorMsg）
            // socket.emit('errorMsg', connection.reason); 
            return; // 拒绝移动！
        }

        // 验证通过，执行移动
        player.r = selected.r;
        player.s = selected.s;
        player.ap -= 1;
        io.emit('log', `🏃 ${player.name} 移动成功`);

    } else if (type === 'swap') {
        if(player.r === gameState.demon.r || selected.r === gameState.demon.r) return;
        const myShard = gameState.shards.find(s => s.r === player.r && s.s === player.s);
        
        let tempE = myShard.edges; let tempR = myShard.rot;
        myShard.edges = shard.edges; myShard.rot = shard.rot;
        shard.edges = tempE; shard.rot = tempR;
        
        player.ap -= 2;
        io.emit('log', `🌌 ${player.name} 施展了空间互换`);
    }
}

function nextTurn() {
    let loopCount = 0;
    do {
        gameState.turnIdx = (gameState.turnIdx + 1);
        // 如果一轮结束，恶魔行动
        if (gameState.turnIdx >= gameState.players.length) {
            gameState.turnIdx = 0;
            runDemon();
        }
        loopCount++;
    } while (!gameState.players[gameState.turnIdx].alive && loopCount < 10);
    // 如果所有人都死了... (这里暂不处理)
}

function runDemon() {
    gameState.demon.r = (gameState.demon.r + 1) % 5;
    io.emit('log', `👹 恶魔移动到了 R${gameState.demon.r+1}`);
    gameState.players.forEach(p => {
        if(p.alive && p.r === gameState.demon.r) {
            p.hp -= 1;
            io.emit('log', `🩸 ${p.name} 受伤！剩余HP: ${p.hp}`);
            if(p.hp <= 0) {
                p.alive = false;
                io.emit('log', `💀 ${p.name} 牺牲了...`);
            }
        }
    });
    // 重置所有活人AP
    gameState.players.forEach(p => p.ap = 3);
}

// --- 核心校验逻辑 (从单机版移植) ---

function checkConnection(from, to) {
    // 1. 获取邻接关系
    const adj = getAdjacencyIndices(from, to);
    if(!adj.valid) return { ok: false, reason: "位置不相邻" };

    // 2. 获取碎片数据
    const s1 = gameState.shards.find(s => s.r === from.r && s.s === from.s);
    const s2 = gameState.shards.find(s => s.r === to.r && s.s === to.s);

    if (!s1 || !s2) return { ok: false, reason: "数据错误" };

    // 3. 计算颜色 (考虑旋转)
    // EdgeIndex 是物理边的索引 (0,1,2)
    // 实际颜色索引 = (物理边 - 旋转偏移 + 3) % 3
    const c1 = s1.edges[(adj.edges[0] - (s1.rot/120) + 3) % 3];
    const c2 = s2.edges[(adj.edges[1] - (s2.rot/120) + 3) % 3];

    // 4. 比对颜色
    if (c1 !== c2) return { ok: false, reason: "颜色不匹配" };

    return { ok: true };
}

function getAdjacencyIndices(f, t) {
    // 情况A: 同房间内
    if(f.r === t.r) {
        // S1 <-> S0
        if((f.s===1 && t.s===0) || (f.s===0 && t.s===1)) return {valid:true, edges: f.s===1?[1,0]:[0,1]};
        // S2 <-> S0
        if((f.s===0 && t.s===2) || (f.s===2 && t.s===0)) return {valid:true, edges:[2,2]};
        // S3 <-> S0
        if((f.s===0 && t.s===3) || (f.s===3 && t.s===0)) return {valid:true, edges: f.s===0?[1,2]:[2,1]};
    } 
    // 情况B: 跨房间
    else {
        const nextR = (f.r + 1) % 5;
        const prevR = (f.r + 4) % 5; // 相当于 -1

        // 顺时针跨越 (f -> next)
        if(t.r === nextR) {
            if(f.s === 1 && t.s === 1) return {valid:true, edges:[2,0]}; // 内圈直连
            if(f.s === 3 && t.s === 2) return {valid:true, edges:[0,0]}; // 外圈顺连
        }
        // 逆时针跨越 (f -> prev)
        if(t.r === prevR) {
            if(f.s === 1 && t.s === 1) return {valid:true, edges:[0,2]}; // 内圈逆连
            if(f.s === 2 && t.s === 3) return {valid:true, edges:[0,0]}; // 外圈逆连
        }
    }
    return {valid:false};
}



// server.js 的最后一行
const PORT = process.env.PORT || 3000; // 如果云端给了端口就用云端的，否则用3000
http.listen(PORT, () => {
    console.log(`服务器启动在端口 ${PORT}`);
});