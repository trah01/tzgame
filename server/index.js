const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const cors = require('cors');
const crypto = require('crypto');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: ["http://localhost:3000", "http://tz.trah.cn", "http://tz.trah.cn:3000", "https://tz.trah.cn"],
    methods: ["GET", "POST"]
  }
});

// 游戏状态管理
const rooms = new Map();

// 全局游戏配置
const gameConfig = {
  initialCoins: 1000,
  foldPenalty: 10,
  maxRounds: 10
};

// 生成房间ID
function generateRoomId() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

// 初始化玩家
function createPlayer(socketId, name) {
  return {
    socketId,
    name,
    coins: gameConfig.initialCoins, // 使用动态初始积分
    bet: 0,
    dice: [0, 0, 0],
    diceTotal: 0,
    isReady: false,
    isFolded: false
  };
}

// 初始化房间
function createRoom(roomId, hostSocketId, hostName) {
  const host = createPlayer(hostSocketId, hostName);
  host.isReady = true; // 房主默认准备好
  return {
    roomId,
    host: host.socketId,
    players: new Map([[hostSocketId, host]]),
    dealer: hostSocketId, // 庄家
    gamePhase: 'waiting', // waiting, betting, rolling, dealer_choice, reveal, result
    dice: [0, 0, 0],
    dealerChoice: null, // 'high' or 'low'
    multiplier: 1,
    pot: 0,
    minPlayers: 2,
    currentRound: 0,
    maxRounds: gameConfig.maxRounds
  };
}

// 骰3个骰子
function rollDice() {
  return [
    crypto.randomInt(1, 7),
    crypto.randomInt(1, 7),
    crypto.randomInt(1, 7)
  ];
}

// 计算骰子总数
function calculateTotal(dice) {
  return dice.reduce((sum, val) => sum + val, 0);
}

// 根据点数计算倍率 (庄家的风险与赔率)
function calculateMultiplier(total, choice) {
  if (choice === 'high') {
    if (total <= 5) return 12.0;
    if (total <= 7) return 6.0;
    if (total <= 9) return 3.0;
    if (total <= 10) return 2.2;
    if (total <= 11) return 1.8;
    if (total <= 13) return 1.5;
    if (total <= 15) return 1.2;
    return 1.1;
  } else {
    if (total >= 16) return 12.0;
    if (total >= 14) return 6.0;
    if (total >= 12) return 3.0;
    if (total >= 11) return 2.2;
    if (total >= 10) return 1.8;
    if (total >= 8) return 1.5;
    if (total >= 6) return 1.2;
    return 1.1;
  }
}

// Socket.IO 连接处理
io.on('connection', (socket) => {
  console.log(`玩家连接: ${socket.id}`);

  // 发送当前配置给新连接玩家
  socket.emit('config_updated', gameConfig);

  // 后台更新配置
  socket.on('update_config', (newConfig) => {
    if (newConfig.initialCoins !== undefined) gameConfig.initialCoins = Number(newConfig.initialCoins);
    if (newConfig.foldPenalty !== undefined) gameConfig.foldPenalty = Number(newConfig.foldPenalty);
    if (newConfig.maxRounds !== undefined) gameConfig.maxRounds = Number(newConfig.maxRounds);
    io.emit('config_updated', gameConfig); // 广播给所有人
  });

  // 创建房间
  socket.on('create_room', ({ playerName }) => {
    const roomId = generateRoomId();
    const room = createRoom(roomId, socket.id, playerName);
    rooms.set(roomId, room);
    socket.join(roomId);
    socket.data.roomId = roomId;

    socket.emit('room_created', {
      roomId,
      player: room.players.get(socket.id),
      players: Array.from(room.players.values())
    });
  });

  // 加入房间
  socket.on('join_room', ({ roomId, playerName }) => {
    const room = rooms.get(roomId);

    if (!room) {
      socket.emit('error', { message: '房间不存在' });
      return;
    }

    if (room.gamePhase !== 'waiting') {
      socket.emit('error', { message: '游戏已开始，无法加入' });
      return;
    }

    if (room.players.has(socket.id)) {
      socket.emit('error', { message: '你已在房间中' });
      return;
    }

    const player = createPlayer(socket.id, playerName);
    room.players.set(socket.id, player);
    socket.join(roomId);
    socket.data.roomId = roomId;

    // 通知所有玩家
    io.to(roomId).emit('player_joined', {
      player,
      players: Array.from(room.players.values())
    });
  });

  // 准备游戏
  socket.on('ready', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    const player = room.players.get(socket.id);
    if (!player) return;

    player.isReady = true;

    // 检查是否所有人都准备好了
    const allReady = Array.from(room.players.values()).every(p => p.isReady);

    io.to(roomId).emit('player_ready', {
      playerId: socket.id,
      allReady,
      players: Array.from(room.players.values())
    });

    // 如果所有人都准备好了，开始游戏
    if (allReady && room.players.size >= room.minPlayers) {
      startGame(room);
    }
  });

  // 下注
  socket.on('place_bet', ({ betAmount, isFold }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || room.gamePhase !== 'betting') return;

    const player = room.players.get(socket.id);
    if (!player) return;

    if (socket.id === room.dealer) {
      socket.emit('error', { message: '庄家无需下注' });
      return;
    }

    if (isFold) {
      if (player.coins < gameConfig.foldPenalty) {
        socket.emit('error', { message: `积分不足(需${gameConfig.foldPenalty}分弃牌底注)` });
        return;
      }
      player.bet = 0;
      player.isFolded = true;
      player.coins -= gameConfig.foldPenalty;
      room.pot += gameConfig.foldPenalty;
    } else {
      if (betAmount < 100 || betAmount > player.coins) {
        socket.emit('error', { message: '最低下注100，积分不足或下注无效' });
        return;
      }
      player.bet = betAmount;
      room.pot += betAmount;
    }

    io.to(roomId).emit('bet_placed', {
      playerId: socket.id,
      betAmount: isFold ? 0 : betAmount,
      pot: room.pot,
      players: Array.from(room.players.values())
    });

    // 检查是否所有人都下注了或弃牌了
    const allBet = Array.from(room.players.values()).every(p => p.socketId === room.dealer || p.bet > 0 || p.isFolded);
    if (allBet) {
      startResultPhase(room);
    }
  });

  // 庄家选择比大或比小
  socket.on('dealer_choice', ({ choice }) => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room || room.gamePhase !== 'dealer_choice') return;

    if (socket.id !== room.dealer) {
      socket.emit('error', { message: '只有庄家可以做选择' });
      return;
    }

    if (choice !== 'high' && choice !== 'low') {
      socket.emit('error', { message: '无效的选择' });
      return;
    }

    room.dealerChoice = choice;
    room.multiplier = calculateMultiplier(room.diceTotal, choice);

    io.to(roomId).emit('dealer_choice_made', {
      choice,
      multiplier: room.multiplier,
      diceTotal: room.diceTotal
    });

    // 进入下注阶段
    room.gamePhase = 'betting';
    io.to(roomId).emit('betting_start', {
      message: '庄家已选择，请下注！',
      choice: room.dealerChoice,
      multiplier: room.multiplier
    });
  });

  // 开始下一轮
  socket.on('next_round', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // 轮换庄家
    const playerArray = Array.from(room.players.values());
    const dealerIndex = playerArray.findIndex(p => p.socketId === room.dealer);
    const nextDealerIndex = (dealerIndex + 1) % playerArray.length;
    room.dealer = playerArray[nextDealerIndex].socketId;

    startGame(room);
  });

  // 重启游戏
  socket.on('restart_game', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    // 重置房间参数
    room.currentRound = 0;
    room.pot = 0;

    // 重置所有玩家积分到初始值
    room.players.forEach(player => {
      player.coins = gameConfig.initialCoins;
      player.isReady = (player.socketId === room.host); // 房主默认准备好
      player.bet = 0;
      player.isFolded = false;
    });

    io.to(roomId).emit('game_restarted', {
      players: Array.from(room.players.values()),
      config: gameConfig
    });

    // 如果房主已经准备好（默认），且满足最小人数，可直接准备开始第一局
    // 实际上通常让大家重新点准备比较稳妥，但这里遵循房主默认准备的逻辑
    io.to(roomId).emit('waiting_for_players', {
      message: '游戏已重启，等待玩家准备...'
    });
  });

  // 离开房间
  socket.on('leave_room', () => {
    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(socket.id);
    socket.leave(roomId);

    // 如果房间没人了，删除房间
    if (room.players.size === 0) {
      rooms.delete(roomId);
    } else {
      // 如果庄家离开，转移庄家
      if (room.dealer === socket.id) {
        room.dealer = room.players.values().next().value.socketId;
      }

      io.to(roomId).emit('player_left', {
        playerId: socket.id,
        players: Array.from(room.players.values())
      });
    }
  });

  // 断开连接
  socket.on('disconnect', () => {
    console.log(`玩家断开连接: ${socket.id}`);

    const roomId = socket.data.roomId;
    if (!roomId) return;

    const room = rooms.get(roomId);
    if (!room) return;

    room.players.delete(socket.id);

    if (room.players.size === 0) {
      rooms.delete(roomId);
    } else {
      io.to(roomId).emit('player_left', {
        playerId: socket.id,
        players: Array.from(room.players.values())
      });
    }
  });
});

// 开始游戏
function startGame(room) {
  room.gamePhase = 'rolling';
  room.pot = 0;
  room.dice = [0, 0, 0];
  room.diceTotal = 0;
  room.dealerChoice = null;
  room.multiplier = 1;
  room.currentRound++;

  // 重置玩家状态
  room.players.forEach(player => {
    player.bet = 0;
    player.dice = [0, 0, 0];
    player.diceTotal = 0;
    player.isReady = false;
    player.isFolded = false;
  });

  io.to(room.roomId).emit('game_started', {
    dealer: room.dealer,
    players: Array.from(room.players.values()),
    currentRound: room.currentRound,
    maxRounds: room.maxRounds
  });

  // 先骰子
  startRollingPhase(room);
}

// 开始骰子阶段
function startRollingPhase(room) {
  room.gamePhase = 'rolling';

  io.to(room.roomId).emit('rolling_start', {
    message: '开始骰子!'
  });

  // 每个玩家骰3个骰子
  room.players.forEach(player => {
    player.dice = rollDice();
    player.diceTotal = calculateTotal(player.dice);
  });

  // 庄家骰子(用于倍率计算)
  room.dice = rollDice();
  room.diceTotal = calculateTotal(room.dice);

  // 延迟后显示结果
  setTimeout(() => {
    // 给每个玩家发送他们自己的骰子
    room.players.forEach((player, playerId) => {
      io.to(playerId).emit('dice_revealed', {
        dice: player.dice,
        diceTotal: player.diceTotal,
        dealerDice: room.dice, // 庄家骰子
        dealerDiceTotal: room.diceTotal,
        isDealer: playerId === room.dealer
      });
    });

    // 进入庄家选择阶段
    room.gamePhase = 'dealer_choice';
    io.to(room.roomId).emit('dealer_choice_phase', {
      dealer: room.dealer,
      diceTotal: room.diceTotal
    });
  }, 2000);
}

// 计算结果阶段
function startResultPhase(room) {
  console.log(`\n--- [结算阶段] 房间: ${room.roomId} ---`);
  console.log(`庄家 ID: ${room.dealer}, 倍率: ${room.multiplier}, 选择: ${room.dealerChoice}, 庄家点数: ${room.diceTotal}`);

  room.gamePhase = 'reveal';
  const results = [];
  const dealerPlayer = room.players.get(room.dealer);

  if (!dealerPlayer) {
    console.error("[错误] 找不到庄家玩家对象");
    return;
  }

  let dealerFinalChange = 0;

  // 1. 遍历所有玩家（非庄家）计算输赢
  room.players.forEach((player, playerId) => {
    // 庄家本人跳过计算，最后汇总
    if (playerId === room.dealer) return;

    let winAmount = 0;
    let isTie = false;

    if (player.isFolded) {
      // 玩家弃牌：玩家失去底注，庄家赢得底注
      winAmount = -gameConfig.foldPenalty;
      dealerFinalChange += gameConfig.foldPenalty;
      console.log(`> 玩家 ${player.name} 已弃牌: 输 ${Math.abs(winAmount)}`);
    } else {
      const outcome = determineWinner(room.diceTotal, player.diceTotal, room.dealerChoice);

      if (outcome === 'player') {
        // 玩家赢：玩家赢得 N 倍下注，庄家补偿 N 倍下注 (遵循倍率)
        const payout = Math.floor(player.bet * room.multiplier);
        winAmount = payout;
        dealerFinalChange -= winAmount;
        console.log(`> 玩家 ${player.name} 赢点: +${winAmount} (倍率 ${room.multiplier}x)`);
      } else if (outcome === 'dealer') {
        // 庄家赢：玩家输 N 倍下注，庄家赚取 N 倍下注
        const lossAmount = Math.floor(player.bet * room.multiplier);
        winAmount = -lossAmount;
        dealerFinalChange += lossAmount;
        console.log(`> 庄家赢 (vs ${player.name}): 庄家赚 ${lossAmount} (倍率 ${room.multiplier}x)`);
      } else {
        // 平局
        winAmount = 0;
        isTie = true;
        console.log(`> 玩家 ${player.name} 与庄家平局: 0`);
      }
    }

    // 更新非庄家积分
    player.coins += winAmount;
    results.push({
      playerId,
      playerName: player.name,
      win: winAmount,
      dice: player.dice,
      diceTotal: player.diceTotal,
      isDealer: false,
      isFolded: player.isFolded,
      isTie: isTie
    });
  });

  // 2. 统一更新庄家总积分
  dealerPlayer.coins += dealerFinalChange;
  results.push({
    playerId: room.dealer,
    playerName: dealerPlayer.name,
    win: dealerFinalChange,
    dice: room.dice,
    diceTotal: room.diceTotal,
    isDealer: true
  });

  console.log(`[结算完成] 庄家总盈亏: ${dealerFinalChange}\n------------------------\n`);

  const gameOver = checkGameOver(room);

  io.to(room.roomId).emit('game_result', {
    results,
    dealerChoice: room.dealerChoice,
    multiplier: room.multiplier,
    dealerDice: room.dice,
    dealerDiceTotal: room.diceTotal,
    players: Array.from(room.players.values()),
    currentRound: room.currentRound,
    maxRounds: room.maxRounds,
    isGameOver: gameOver
  });

  if (gameOver) {
    room.gamePhase = 'final_result';
    io.to(room.roomId).emit('final_settlement', {
      players: Array.from(room.players.values()),
      message: room.currentRound >= room.maxRounds ? '回合数已满，游戏结束！' : '有玩家积分为0，游戏提前结束！'
    });
  } else {
    room.gamePhase = 'result';
  }
}

// 检查游戏是否结束
function checkGameOver(room) {
  // 1. 达到最大回合数
  if (room.currentRound >= room.maxRounds) return true;

  // 2. 有玩家破产 (积分为0或负数)
  for (const player of room.players.values()) {
    if (player.coins <= 0) return true;
  }

  return false;
}

// 判定胜负
function determineWinner(dealerTotal, playerTotal, dealerChoice) {
  if (dealerTotal === playerTotal) return 'tie';
  if (dealerChoice === 'high') {
    // 比大: 点数大的赢
    return playerTotal > dealerTotal ? 'player' : 'dealer';
  } else {
    // 比小: 点数小的赢
    return playerTotal < dealerTotal ? 'player' : 'dealer';
  }
}

// 启动服务器
const PORT = process.env.PORT || 3001;
server.listen(PORT, () => {
  console.log(`服务器运行在端口 ${PORT}`);
});
