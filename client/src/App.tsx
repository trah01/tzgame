import { useState, useEffect, useRef } from 'react';
import io, { Socket } from 'socket.io-client';
import './index.css';
import './App.css';

interface Player {
  socketId: string;
  name: string;
  coins: number;
  bet: number;
  dice: number[];
  diceTotal: number;
  isReady: boolean;
  isFolded?: boolean;
}

interface GameResult {
  playerId: string;
  playerName: string;
  win: number;
  dice: number[];
  diceTotal: number;
  isDealer: boolean;
  isTie?: boolean;
  isFolded?: boolean;
}

type GamePhase = 'lobby' | 'waiting' | 'betting' | 'rolling' | 'dealer_choice' | 'reveal' | 'result' | 'final_result';

// 🎊 简单的内置礼花组件 (纯CSS实现无外部依赖)
const Confetti = () => {
  const colors = ['#ff3b30', '#34c759', '#007aff', '#ffcc00', '#5856d6', '#ff9500'];
  const pieces = Array.from({ length: 60 }).map((_, i) => {
    const left = Math.random() * 100;
    const animationDelay = Math.random() * 1.5;
    const animationDuration = 2.5 + Math.random() * 2;
    const backgroundColor = colors[Math.floor(Math.random() * colors.length)];
    const shape = Math.random() > 0.5 ? '50%' : '0'; // 圆形或者纸条
    return (
      <div
        key={i}
        className="confetti-piece"
        style={{
          left: `${left}vw`,
          animationDelay: `${animationDelay}s`,
          animationDuration: `${animationDuration}s`,
          backgroundColor,
          borderRadius: shape,
          transform: `rotate(${Math.random() * 360}deg)`
        }}
      />
    );
  });

  return <div className="confetti-container">{pieces}</div>;
};

function App() {
  const [socket, setSocket] = useState<Socket | null>(null);
  const [playerName, setPlayerName] = useState(() => {
    const saved = localStorage.getItem('dbgame_playerName');
    if (saved) return saved;
    const defaultNames = [
      '幸运骰子', '大金主', '无名高手', '欧皇', '赌神',
      '爱笑的鱼', '流浪诗人', '快乐小羊', '闪电侠', '透明人',
      '星际旅者', '深海潜水员', '风中的叶子', '晨曦微光'
    ];
    return defaultNames[Math.floor(Math.random() * defaultNames.length)];
  });
  const [roomId, setRoomId] = useState('');
  const [joinRoomId, setJoinRoomId] = useState('');
  const [players, setPlayers] = useState<Player[]>([]);
  const [currentPlayer, setCurrentPlayer] = useState<Player | null>(null);
  const [gamePhase, setGamePhase] = useState<GamePhase>('lobby');
  const [dealer, setDealer] = useState('');
  const [betAmount, setBetAmount] = useState(100);
  const [pot, setPot] = useState(0);
  const [diceTotal, setDiceTotal] = useState(0);
  const [myDice, setMyDice] = useState([0, 0, 0]);
  const [dealerDice, setDealerDice] = useState([0, 0, 0]);
  const [dealerChoice, setDealerChoice] = useState<'high' | 'low' | null>(null);
  const [multiplier, setMultiplier] = useState(1);
  const [results, setResults] = useState<GameResult[]>([]);
  const [message, setMessage] = useState('');
  const [isDealer, setIsDealer] = useState(false);
  const [gameConfig, setGameConfig] = useState({ initialCoins: 1000, foldPenalty: 10, maxRounds: 10 });
  const [currentRound, setCurrentRound] = useState(0);
  const [maxRounds, setMaxRounds] = useState(10);
  const [showAdmin, setShowAdmin] = useState(false);
  const [adminInitialCoins, setAdminInitialCoins] = useState(1000);
  const [adminFoldPenalty, setAdminFoldPenalty] = useState(10);
  const [adminMaxRounds, setAdminMaxRounds] = useState(10);
  const [isWin, setIsWin] = useState(false);
  const [gameLogs, setGameLogs] = useState<any[]>([]);
  const [finalSettlementData, setFinalSettlementData] = useState<any>(null);
  const nameInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // 采用相对路径直接连接，会自动利用 Vite 设定的 proxy 穿透到 3001 端口
    const newSocket = io();
    setSocket(newSocket);

    newSocket.on('config_updated', (cf) => {
      setGameConfig(cf);
      setAdminInitialCoins(cf.initialCoins);
      setAdminFoldPenalty(cf.foldPenalty);
      setAdminMaxRounds(cf.maxRounds);
      setMaxRounds(cf.maxRounds);
    });

    // 解析 URL 中的邀请码
    const params = new URLSearchParams(window.location.search);
    const urlRoomId = params.get('roomId');
    if (urlRoomId) {
      const rid = urlRoomId.toUpperCase();
      setJoinRoomId(rid);
      setMessage(`请点击 [加入] 进入房间: ${rid}`);
      // 延迟聚焦，确保 DOM 已渲染
      setTimeout(() => {
        nameInputRef.current?.focus();
      }, 500);
    }

    newSocket.on('room_created', ({ roomId: rId, player, players: pls }) => {
      setRoomId(rId);
      setCurrentPlayer(player);
      setPlayers(pls);
      setGamePhase('waiting');
      setMessage('房间创建成功！等待其他玩家加入...');
    });

    newSocket.on('player_joined', ({ player, players: pls }) => {
      setPlayers(pls);
      if (!currentPlayer) {
        setCurrentPlayer(player);
      }
      setGamePhase('waiting');
      if (player.socketId === newSocket.id) {
        setMessage(`成功加入房间！房间号: ${roomId}`);
      } else {
        setMessage(`${player.name} 加入了房间`);
      }
    });

    newSocket.on('player_left', ({ playerId: _playerId, players: pls }) => {
      setPlayers(pls);
      setMessage('有玩家离开了房间');
    });

    newSocket.on('player_ready', ({ playerId, allReady, players: pls }) => {
      setPlayers(pls);
      if (allReady) {
        setMessage('所有玩家已准备好！');
      } else {
        const player = pls.find((p: Player) => p.socketId === playerId);
        setMessage(`${player?.name} 已准备好`);
      }
    });

    newSocket.on('game_started', ({ dealer: dlr, players: pls, currentRound: cr, maxRounds: mr }) => {
      setDealer(dlr);
      setPlayers(pls);
      setGamePhase('rolling');
      setPot(0);
      setIsWin(false); // 重置赢家状态
      setCurrentRound(cr);
      setMaxRounds(mr);
      setMessage(`第 ${cr}/${mr} 回合开始！先骰子`);
    });

    newSocket.on('betting_start', ({ choice, multiplier: mult }) => {
      setGamePhase('betting');
      setDealerChoice(choice);
      setMultiplier(mult);
      const choiceText = choice === 'high' ? '这局我更大' : '这局我更小';
      setMessage(`庄家说：${choiceText}！请下注！`);
    });

    newSocket.on('bet_placed', ({ playerId, betAmount: bet, pot: p, players: pls }) => {
      setPlayers(pls);
      setPot(p);
      const player = pls.find((p: Player) => p.socketId === playerId);
      setMessage(`${player?.name} 下注了 ${bet}`);
    });

    newSocket.on('rolling_start', ({ message: msg }) => {
      setGamePhase('rolling');
      setMessage(msg);
    });

    newSocket.on('dice_revealed', ({ dice: d, dealerDice: dD, isDealer: isD }) => {
      setMyDice(d);
      setDealerDice(dD);
      setIsDealer(isD);
      // 计算总点数以便显示
      const dt = (d as number[]).reduce((a: number, b: number) => a + b, 0);
      setMessage(`你的骰子: ${d.join(' ')} = ${dt}`);
    });

    newSocket.on('dealer_choice_phase', ({ dealer: dlr, diceTotal: dt }) => {
      setGamePhase('dealer_choice');
      setDealer(dlr);
      setDiceTotal(dt);
      setMessage('庄家正在做选择...');
    });

    newSocket.on('dealer_choice_made', ({ choice, multiplier: mult, diceTotal: dt }) => {
      setDealerChoice(choice);
      setMultiplier(mult);
      setDiceTotal(dt);
      const choiceText = choice === 'high' ? '这局我更大' : '这局我更小';
      setMessage(`庄家选择 [${choiceText}]，倍率: ${mult}x`);
    });

    newSocket.on('game_result', ({ results: res, dealerChoice: dc, multiplier: mult, dealerDice: dD, dealerDiceTotal: dDt, players: pls, currentRound: cr, maxRounds: mr, isGameOver: _isGameOver }) => {
      setGamePhase('result');
      setResults(res);
      setDealerChoice(dc);
      setMultiplier(mult);
      setDealerDice(dD);
      setPlayers(pls);
      setCurrentRound(cr);
      setMaxRounds(mr);

      // 保存到日志
      const dealerResult = res.find((r: GameResult) => r.isDealer);
      const logEntry = {
        round: cr,
        results: res,
        multiplier: mult,
        dealerName: dealerResult?.playerName,
        dealerTotal: dDt,
        dealerChoice: dc
      };
      setGameLogs(prev => [...prev, logEntry]);

      const myResult = res.find((r: GameResult) => r.playerId === newSocket.id);
      if (myResult) {
        const hasWon = myResult.win > 0;
        setIsWin(hasWon);
        setMessage(hasWon ? `恭喜！你赢了 ${myResult.win} 积分！` : `很遗憾，你输了 ${Math.abs(myResult.win)} 积分`);
      }
    });

    newSocket.on('final_settlement', ({ players: pls, message: msg }) => {
      setFinalSettlementData({ players: pls, message: msg });
      setGamePhase('final_result');
      setMessage(msg);
    });

    newSocket.on('game_restarted', ({ players: pls, config: _config }) => {
      setPlayers(pls);
      setGameLogs([]);
      setFinalSettlementData(null);
      setGamePhase('waiting');
      setCurrentRound(0);
      setIsWin(false);
      setMessage('游戏已重新开始！');
    });

    newSocket.on('error', ({ message: msg }) => {
      setMessage(msg);
    });

    return () => {
      newSocket.close();
    };
  }, []);

  const createRoom = () => {
    if (!playerName.trim()) {
      setMessage('请输入你的名字');
      return;
    }
    socket?.emit('create_room', { playerName: playerName.trim() });
    localStorage.setItem('dbgame_playerName', playerName.trim());
  };

  const joinRoom = () => {
    if (!playerName.trim() || !joinRoomId.trim()) {
      setMessage('请输入名字和房间号');
      return;
    }
    setRoomId(joinRoomId.trim());
    socket?.emit('join_room', { roomId: joinRoomId.trim(), playerName: playerName.trim() });
    localStorage.setItem('dbgame_playerName', playerName.trim());
  };

  const ready = () => {
    socket?.emit('ready');
  };

  const placeBet = () => {
    if (betAmount <= 0 || (currentPlayer && betAmount > currentPlayer.coins)) {
      setMessage('积分不足或下注无效');
      return;
    }
    socket?.emit('place_bet', { betAmount, isFold: false });
  };

  const fold = () => {
    socket?.emit('place_bet', { betAmount: 0, isFold: true });
  };

  const makeDealerChoice = (choice: 'high' | 'low') => {
    socket?.emit('dealer_choice', { choice });
  };

  const nextRound = () => {
    socket?.emit('next_round');
  };

  const restartGame = () => {
    socket?.emit('restart_game');
  };

  const leaveRoom = () => {
    socket?.emit('leave_room');
    setRoomId('');
    setGamePhase('lobby');
    setPlayers([]);
  };

  const updateConfig = () => {
    socket?.emit('update_config', {
      initialCoins: adminInitialCoins,
      foldPenalty: adminFoldPenalty,
      maxRounds: adminMaxRounds
    });
    setShowAdmin(false);
    setMessage('后台配置已更新！新玩家将应用新配置。');
  };

  const copyToClipboard = (text: string, msg: string) => {
    navigator.clipboard.writeText(text).then(() => {
      setMessage(msg);
      setTimeout(() => setMessage(''), 3000);
    }).catch(err => {
      console.error('复制失败:', err);
    });
  };

  const copyInviteLink = () => {
    const link = `${window.location.origin}${window.location.pathname}?roomId=${roomId}`;
    copyToClipboard(link, '邀请链接已复制！');
  };

  // 渲染骰子 - Apple风格
  const renderDice = (diceValues: number[], hidden = false, isRolling = false, showTotal = true) => {
    const renderContent = () => {
      if (hidden) {
        return ['?', '?', '?'].map((face, i) => (
          <div key={i} className="dice-box hidden">
            {face}
          </div>
        ));
      }
      return diceValues.map((value, i) => (
        <div 
          key={i} 
          className="dice-box"
          style={{ animationDelay: `${i * 0.15}s` }}
        >
          {value > 0 ? ['⚀', '⚁', '⚂', '⚃', '⚄', '⚅'][value - 1] : ''}
        </div>
      ));
    };

    return (
      <div style={{ textAlign: 'center' }}>
        <div className={`dice-container ${isRolling ? 'rolling-anim' : ''}`}>
          {renderContent()}
        </div>
        {!hidden && showTotal && !isRolling && diceValues.some(v => v > 0) && (
          <p className="status-message" style={{ margin: 0, fontWeight: 600 }}>总计: {diceValues.reduce((a, b) => a + b, 0)}</p>
        )}
      </div>
    );
  };

  const getMultiplier = (total: number, choice: 'high' | 'low') => {
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
  };

  // Lobby Phase (登录大厅)
  if (gamePhase === 'lobby') {
    if (showAdmin) {
      return (
        <div className="app-container fade-in-spring">
          <div className="center-content">
            <div className="header">
              <h2>⚙️ 后台管理</h2>
              <p>全局游戏参数设置</p>
            </div>
            <div className="apple-card lobby-form">
              <label style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>初始积分 (新玩家)</label>
              <input
                type="number"
                value={adminInitialCoins}
                onChange={(e) => setAdminInitialCoins(Number(e.target.value))}
                className="apple-input"
              />
              <label style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '12px' }}>弃牌惩罚</label>
              <input
                type="number"
                value={adminFoldPenalty}
                onChange={(e) => setAdminFoldPenalty(Number(e.target.value))}
                className="apple-input"
              />
              <label style={{ fontSize: '14px', color: 'var(--text-secondary)', marginTop: '12px' }}>总回合数</label>
              <input
                type="number"
                value={adminMaxRounds}
                onChange={(e) => setAdminMaxRounds(Number(e.target.value))}
                className="apple-input"
              />
              <div style={{ display: 'flex', gap: '8px', marginTop: '24px' }}>
                <button onClick={updateConfig} className="prominent-button">保存设置</button>
                <button onClick={() => setShowAdmin(false)} className="prominent-button secondary">取消</button>
              </div>
            </div>
          </div>
        </div>
      );
    }

    return (
      <div className="app-container fade-in-spring">
        <div className="center-content">
          <div className="header">
            <h1>骰子大师</h1>
            <p>高级多人在线体验</p>
          </div>

          <div className="apple-card lobby-form">
            <input
              ref={nameInputRef}
              type="text"
              placeholder="你的名字"
              value={playerName}
              onChange={(e) => setPlayerName(e.target.value)}
              className="apple-input"
              maxLength={20}
            />

            <button onClick={createRoom} className={`prominent-button ${joinRoomId ? 'secondary' : ''}`}>
              创建房间
            </button>

            <div style={{ display: 'flex', gap: '8px', marginTop: '12px' }}>
              <input
                type="text"
                placeholder="房间号"
                value={joinRoomId}
                onChange={(e) => setJoinRoomId(e.target.value.toUpperCase())}
                className="apple-input"
                maxLength={6}
                style={{ flex: 2, border: joinRoomId ? '1px solid var(--accent)' : '1px solid transparent' }}
              />
              <button
                onClick={joinRoom}
                className={`prominent-button ${joinRoomId ? '' : 'secondary'}`}
                style={{ flex: 1, padding: '0 12px' }}
              >
                加入
              </button>
            </div>

            <button onClick={() => setShowAdmin(true)} className="prominent-button secondary" style={{ marginTop: '8px', background: 'transparent', border: 'var(--material-border)' }}>
              ⚙️ 管理后台
            </button>

            {message && <p className="status-message" style={{ color: '#FF3B30', marginTop: '12px' }}>{message}</p>}
          </div>
        </div>
      </div>
    );
  }

  // Game Phases
  return (
    <div className="app-container fade-in-spring">
      {isWin && <Confetti />}
      <div className="game-header">
        <div>
          <h2 style={{ fontSize: '24px', margin: 0 }}>骰子大师</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginTop: '4px' }}>
            <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>房间: {roomId}</span>
            <span style={{ fontSize: '13px', color: 'var(--accent)', fontWeight: 600 }}>回合: {currentRound || 1}/{maxRounds}</span>
            <button
              onClick={() => copyToClipboard(roomId, '房间号已复制！')}
              className="copy-button"
              title="复制房间号"
            >
              复制
            </button>
            <button
              onClick={copyInviteLink}
              className="copy-button"
              title="复制邀请链接"
            >
              邀请
            </button>
          </div>
        </div>
        <button onClick={leaveRoom} className="prominent-button secondary" style={{ width: 'auto', padding: '8px 16px', fontSize: '15px' }}>
          离开
        </button>
      </div>

      <div className="players-scrollView">
        {players.map((player) => (
          <div key={player.socketId} className={`chip-card ${player.socketId === socket?.id ? 'me highlight' : ''}`}>
            <div style={{ fontWeight: 600 }}>{player.name}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '14px' }}>积分: {player.coins}</div>
            {player.bet > 0 && <div style={{ fontSize: '13px', color: 'var(--accent)' }}>下注: {player.bet}</div>}
            {player.isFolded && <div style={{ fontSize: '13px', color: '#FF3B30' }}>已弃牌</div>}
            {player.isReady && gamePhase === 'waiting' && <div style={{ fontSize: '13px', color: '#34C759' }}>已准备</div>}
            {player.socketId === dealer && <div className="badge">庄家</div>}
          </div>
        ))}
      </div>

      <div className="game-area">
        <div className="apple-card fade-in-spring">
          <p className="status-message" style={{ color: 'var(--text-primary)', fontWeight: 600 }}>{message || '状态'}</p>

          {/* Waiting Phase */}
          {gamePhase === 'waiting' && (
            <div className="center-content" style={{ marginTop: '24px' }}>
              <button onClick={ready} className="prominent-button">
                我准备好了
              </button>
            </div>
          )}

          {/* Betting Phase */}
          {gamePhase === 'betting' && (
            isDealer ? (
              <div className="center-content" style={{ marginTop: '24px' }}>
                <p className="status-message">等待其他玩家下注或弃牌...</p>
              </div>
            ) : (
              <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '16px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-around', background: 'var(--bg-tertiary)', padding: '16px', borderRadius: '16px' }}>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>庄家选择</p>
                    <p style={{ fontWeight: 600, fontSize: '18px' }}>{dealerChoice === 'high' ? '这局我更大' : '这局我更小'} ({multiplier}x)</p>
                  </div>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>总奖池</p>
                    <p style={{ fontWeight: 600, fontSize: '18px', color: 'var(--accent)' }}>{pot}</p>
                  </div>
                </div>

                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>你的骰子</p>
                    {renderDice(myDice)}
                  </div>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    type="number"
                    value={betAmount}
                    onChange={(e) => setBetAmount(Number(e.target.value))}
                    className="apple-input"
                    style={{ flex: 1 }}
                    min={100}
                    step={10}
                  />
                  <button onClick={placeBet} className="prominent-button" style={{ width: 'auto' }}>
                    确认下注
                  </button>
                  <button onClick={fold} className="prominent-button secondary" style={{ width: 'auto' }}>
                    弃牌 (-{gameConfig.foldPenalty}分)
                  </button>
                </div>
              </div>
            ))}

          {/* Rolling Phase */}
          {gamePhase === 'rolling' && (
            <div style={{ padding: '24px 0' }}>
              {renderDice([1, 2, 3], false, true)}
            </div>
          )}

          {/* Dealer Choice Phase */}
          {gamePhase === 'dealer_choice' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '16px' }}>
              {isDealer ? (
                <>
                  <div style={{ textAlign: 'center' }}>
                    <p style={{ color: 'var(--text-secondary)' }}>你的骰子</p>
                    {renderDice(dealerDice)}
                  </div>
                  <div className="segmented-control">
                    <button className="segment-btn active" onClick={() => makeDealerChoice('high')}>
                      这局我更大 ({getMultiplier(diceTotal, 'high')}x)
                    </button>
                    <button className="segment-btn active" style={{ background: 'var(--secondary-system-background)' }} onClick={() => makeDealerChoice('low')}>
                      这局我更小 ({getMultiplier(diceTotal, 'low')}x)
                    </button>
                  </div>
                </>
              ) : (
                <div style={{ display: 'flex', justifyContent: 'center' }}>
                  <div>
                    <p style={{ textAlign: 'center', color: 'var(--text-secondary)', marginBottom: '8px' }}>你的骰子</p>
                    {renderDice(myDice)}
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Reveal and Result Phases */}
          {(gamePhase === 'reveal' || gamePhase === 'result') && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'center' }}>
                <div style={{ textAlign: 'center' }}>
                  <p style={{ color: 'var(--text-secondary)' }}>庄家骰子 ({dealerChoice === 'high' ? '这局我更大' : '这局我更小'})</p>
                  {renderDice(dealerDice)}
                </div>
              </div>

              {gamePhase === 'result' && (
                <>
                  <h3 className="section-title">本局结果</h3>
                  <div className="results-list">
                    {results.map((result) => {
                      let resultStatus = result.win > 0 ? 'result-win' : 'result-lose';
                      let sign = result.win > 0 ? '+' : '';
                      if (result.isTie) { resultStatus = ''; sign = ''; }

                      return (
                        <div key={result.playerId} className="result-row" style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: '8px' }}>
                          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                            <span style={{ fontWeight: 600 }}>
                              {result.playerName} {result.isDealer && '(庄家)'}
                              {result.isTie && ' [平局]'}
                              {result.isFolded && ' [弃牌]'}
                            </span>
                            <span className={resultStatus}>
                              {result.isTie ? '0' : `${sign}${result.win}`}
                            </span>
                          </div>
                          {!result.isFolded && result.diceTotal > 0 && (
                            <div style={{ fontSize: '14px', color: 'var(--text-secondary)' }}>
                              <span style={{ marginRight: '8px' }}>🎲 {result.dice.join(', ')}</span>
                              <span>(点数: {result.diceTotal})</span>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                  <button
                    onClick={currentRound >= maxRounds ? leaveRoom : nextRound}
                    className="prominent-button"
                  >
                    {currentRound >= maxRounds ? '游戏结束 - 返回大厅' : '下一局'}
                  </button>
                </>
              )}
            </div>
          )}
          {/* Final Result Phase */}
          {gamePhase === 'final_result' && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', marginTop: '16px' }}>
              <div style={{ textAlign: 'center' }}>
                <h2 style={{ color: 'var(--accent)', fontSize: '28px' }}>结算</h2>
                <p className="status-message" style={{ fontWeight: 600 }}>{finalSettlementData?.message}</p>
              </div>

              <div className="apple-card" style={{ background: 'var(--bg-tertiary)', padding: '16px' }}>
                <h3 className="section-title" style={{ fontSize: '18px' }}>最终排名</h3>
                <div className="results-list">
                  {[...players].sort((a, b) => b.coins - a.coins).map((player, index) => (
                    <div key={player.socketId} className="result-row">
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '20px' }}>{index === 0 ? '🏆' : index === 1 ? '🥈' : index === 2 ? '🥉' : '👤'}</span>
                        <span style={{ fontWeight: 600 }}>{player.name}</span>
                      </div>
                      <span style={{ fontWeight: 700, color: 'var(--accent)' }}>{player.coins} 分</span>
                    </div>
                  ))}
                </div>
              </div>

              <div className="apple-card" style={{ padding: '0', overflow: 'hidden' }}>
                <div style={{ padding: '16px', background: 'var(--secondary-system-background)', borderBottom: 'var(--material-border)' }}>
                  <h3 className="section-title" style={{ margin: 0, fontSize: '18px' }}>对局日志</h3>
                </div>
                <div style={{ maxHeight: '400px', overflowY: 'auto', padding: '16px' }}>
                  {gameLogs.map((log, i) => {
                    return (
                      <div key={i} style={{ marginBottom: '24px', borderBottom: i === 0 ? 'none' : '1px solid var(--bg-tertiary)', paddingBottom: '16px' }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '12px' }}>
                          <span style={{ fontWeight: 700, fontSize: '15px', color: 'var(--accent)' }}>第 {log.round} 回合</span>
                          <span style={{ fontSize: '12px', background: 'var(--bg-tertiary)', padding: '2px 8px', borderRadius: '4px' }}>
                            倍率: {log.multiplier}x ({log.dealerChoice === 'high' ? '这局我更大' : '这局我更小'})
                          </span>
                        </div>

                        <div style={{ fontSize: '13px', background: 'var(--secondary-system-background)', padding: '10px', borderRadius: '8px', marginBottom: '10px', borderLeft: '4px solid var(--accent)' }}>
                          <strong>庄家 ({log.dealerName})</strong>: {log.dealerTotal} 点
                        </div>

                        <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                          {log.results.filter((r: any) => !r.isDealer).map((r: any) => (
                            <div key={r.playerId} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: '13px', padding: '4px 0' }}>
                              <span>
                                闲家 ({r.playerName}): {r.isFolded ? '弃牌' : `${r.diceTotal} 点`}
                              </span>
                              <span style={{ fontWeight: 600, color: r.win > 0 ? '#34C759' : r.win < 0 ? '#FF3B30' : 'var(--text-secondary)' }}>
                                {r.win > 0 ? `闲家赢 ${r.win}` : r.win < 0 ? `庄家赢 ${Math.abs(r.win)}` : '平局'}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    );
                  }).reverse()}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '12px' }}>
                <button onClick={restartGame} className="prominent-button">
                  再来一把
                </button>
                <button onClick={leaveRoom} className="prominent-button secondary">
                  返回大厅
                </button>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default App;
