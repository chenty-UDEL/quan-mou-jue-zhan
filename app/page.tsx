'use client'; 

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

// --- 1. 类型定义 ---
interface Player {
  id: number;
  room_code: string;
  name: string;
  is_alive: boolean;
  is_host: boolean;
  role: string | null;
  flags: any; // 存放临时状态 (如: {cannot_vote: true, is_protected: true})
}

interface RoomState {
    code: string;
    round_state: string; // "LOBBY", "NIGHT 1", "DAY 1", "GAME OVER"
}

interface GameLog {
    id: number;
    message: string;
    tag: string; // "PUBLIC", "PRIVATE"
    viewer_ids: number[] | null;
    created_at: string;
}

export default function Home() {
  // --- 2. 状态管理 ---
  // 基础信息
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [logs, setLogs] = useState<GameLog[]>([]);
  const [error, setError] = useState('');

  // 游戏操作状态
  const [selectedTargetId, setSelectedTargetId] = useState<string>(''); 
  const [hasActed, setHasActed] = useState(false); // 夜晚是否已行动
  const [hasVoted, setHasVoted] = useState(false); // 白天是否已投票
  const [actionLoading, setActionLoading] = useState(false);

  // --- 3. 辅助工具函数 ---
  const getMyPlayer = () => players.find(p => p.name === name);
  const getMyRole = () => getMyPlayer()?.role;
  const isHost = getMyPlayer()?.is_host;
  
  // 角色技能映射表
  const getActionType = (role: string) => {
      switch (role) {
          case '技能观测者': return 'check';
          case '利他守护者': return 'protect';
          case '沉默制裁者': return 'silence';
          case '投票阻断者': return 'block_vote';
          // 如果有杀手角色: case '刺客': return 'kill';
          default: return null; 
      }
  };

  // --- 4. 数据获取与监听 ---
  const fetchLogs = async (code: string) => {
      const { data } = await supabase.from('game_logs').select('*').eq('room_code', code).order('created_at', { ascending: false });
      if (data) setLogs(data as GameLog[]);
  };
  const fetchPlayers = async (code: string) => {
      const { data } = await supabase.from('players').select('*').eq('room_code', code).order('id');
      if (data) setPlayers(data as Player[]);
  };
  const fetchRoomState = async (code: string) => {
      const { data } = await supabase.from('rooms').select('code, round_state').eq('code',code).single();
      if (data) setRoomState(data as RoomState);
  };

  useEffect(() => {
    if (!isInRoom || !roomCode) return;
    
    // A. 监听房间状态 (回合切换)
    const ch1 = supabase.channel('room').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}`}, (payload) => {
        setRoomState(payload.new as RoomState);
        // 新回合重置操作状态
        setHasActed(false); 
        setHasVoted(false); 
        setSelectedTargetId(''); 
        // 刷新数据
        fetchLogs(roomCode); 
        fetchPlayers(roomCode);
    }).subscribe();
    
    // B. 监听日志 (实时公告)
    const ch2 = supabase.channel('logs').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs', filter: `room_code=eq.${roomCode}`}, () => {
        fetchLogs(roomCode);
    }).subscribe();
    
    // C. 监听玩家 (实时生死/状态变化)
    const ch3 = supabase.channel('players').on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}`}, () => {
        fetchPlayers(roomCode);
    }).subscribe();
    
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); };
  }, [isInRoom, roomCode]);

  // --- 5. 核心交互逻辑 (API调用) ---

  // [房主] 开始游戏
  const handleStartGame = async () => {
      setError('');
      if (players.length < 2) return setError('人数不足 2 人'); 
      try {
          await fetch('/api/start-game', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
      } catch (err: any) { setError(err.message); }
  };

  // [玩家] 提交夜晚技能
  const handleSubmitAction = async () => {
      const me = getMyPlayer();
      if (!me || !me.role) return;
      const type = getActionType(me.role);
      if (!selectedTargetId) return setError('请先选择目标');

      setActionLoading(true);
      try {
          const res = await fetch('/api/submit-action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode, actorId: me.id, targetId: parseInt(selectedTargetId), actionType: type })
          });
          if (!res.ok) throw new Error('提交失败');
          setHasActed(true); setError(''); 
      } catch (err) { setError('出错请重试'); } finally { setActionLoading(false); }
  };

  // [房主] 结算夜晚 -> 进入白天
  const handleProcessNight = async () => {
      if (!confirm('确定要结束夜晚并进行结算吗？')) return;
      try {
          await fetch('/api/process-night', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
      } catch (err) { alert('结算请求失败'); }
  };

  // [玩家] 提交白天投票
  const handleSubmitVote = async () => {
      const me = getMyPlayer();
      if (!me) return;
      const target = selectedTargetId ? parseInt(selectedTargetId) : null; // 空值代表弃票

      setActionLoading(true);
      try {
          const res = await fetch('/api/submit-vote', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode, voterId: me.id, targetId: target })
          });
          const result = await res.json();
          if (!res.ok) throw new Error(result.message || '投票失败');
          setHasVoted(true); setError(''); 
      } catch (err: any) { setError(err.message); } finally { setActionLoading(false); }
  };

  // [房主] 结算投票 -> 处决/下一夜/游戏结束
  const handleProcessDay = async () => {
      if (!confirm('确定要结束投票并公布结果吗？得票最高者将被处决。')) return;
      try {
          const res = await fetch('/api/process-day', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
          if (!res.ok) throw new Error('结算失败');
      } catch (err) { alert('结算请求失败'); }
  };

  // 基础房间逻辑
  const createRoom = async () => { 
    if(!name) return setError('请输入名字');
    const code = Math.floor(1000+Math.random()*9000).toString();
    await supabase.from('rooms').insert([{code}]);
    joinGameLogic(code, true);
  };
  const joinRoom = async () => {
    if(!name||!roomCode) return setError('请输入名字和房间号');
    const {data} = await supabase.from('rooms').select().eq('code', roomCode);
    if(!data?.length) return setError('房间不存在');
    joinGameLogic(roomCode, false);
  };
  const joinGameLogic = async (code:string, isHost:boolean) => {
      const {error} = await supabase.from('players').insert([{room_code:code, name, is_host:isHost}]);
      if(error) return setError(error.message);
      setRoomCode(code); setIsInRoom(true); fetchPlayers(code); fetchRoomState(code); fetchLogs(code);
  };

  // --- 6. 视图渲染组件 ---

  // A. 白天视图 (公告 + 投票)
  const renderDay = () => {
    const me = getMyPlayer();
    // 过滤日志: 显示 TAG='PUBLIC' 的，或者 viewer_ids 包含我的
    const myLogs = logs.filter(l => l.tag === 'PUBLIC' || (me && l.viewer_ids?.includes(me.id)));
    const alivePlayers = players.filter(p => p.is_alive);

    return (
        <div className="space-y-6">
            {/* 游戏公告栏 */}
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 max-h-52 overflow-y-auto shadow-inner">
                <h3 className="text-gray-400 font-bold mb-2 sticky top-0 bg-gray-900 pb-2 border-b border-gray-800">📢 游戏公告 & 私信</h3>
                {myLogs.length === 0 ? <p className="text-gray-600 text-sm py-4 text-center">暂无消息...</p> : 
                    myLogs.map(log => (
                        <div key={log.id} className={`mb-2 p-3 rounded text-sm shadow-sm ${log.tag==='PRIVATE' ? 'bg-indigo-900/40 border-l-4 border-indigo-500 text-indigo-200' : 'bg-gray-800 text-gray-300'}`}>
                            {log.tag==='PRIVATE' && <span className="text-indigo-400 font-bold text-xs uppercase tracking-wider block mb-1">[私密情报]</span>}
                            {log.message}
                        </div>
                    ))
                }
            </div>

            {/* 投票控制区 */}
            {me?.is_alive ? (
                 <div className="bg-gray-800 p-5 rounded-lg border border-gray-600 shadow-lg">
                    <div className="flex justify-between items-center mb-4">
                        <h3 className="text-lg font-bold text-yellow-500">🗳️ 投票处决</h3>
                        <span className="text-xs bg-gray-700 px-2 py-1 rounded text-gray-400">Day Phase</span>
                    </div>
                    
                    {hasVoted ? (
                        <div className="bg-green-900/30 border border-green-600 text-green-400 font-bold p-4 rounded text-center animate-pulse">
                            ✅ 您的投票已记录
                        </div>
                    ) : (
                        <div className="space-y-4">
                             {/* 禁票提示 */}
                             {me.flags?.cannot_vote && (
                                 <div className="flex items-center gap-2 bg-red-900/50 border border-red-700 p-3 rounded text-red-300 text-sm font-bold">
                                     <span>⛔</span> <span>你被【投票阻断者】限制，今日不可投票。</span>
                                 </div>
                             )}
                            
                            <select 
                                className="w-full p-3 rounded bg-gray-700 text-white border border-gray-500 focus:border-yellow-500 focus:outline-none"
                                value={selectedTargetId}
                                onChange={(e) => setSelectedTargetId(e.target.value)}
                                disabled={!!me.flags?.cannot_vote} 
                            >
                                <option value="">-- 选择投票对象 (不选视为弃票) --</option>
                                {alivePlayers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
                            </select>
                            
                            <button 
                                onClick={handleSubmitVote} 
                                disabled={!!me.flags?.cannot_vote || actionLoading}
                                className={`w-full p-3 rounded font-bold transition shadow-md ${
                                    me.flags?.cannot_vote ? 'bg-gray-600 cursor-not-allowed opacity-50' : 'bg-yellow-600 hover:bg-yellow-700 text-black'
                                }`}
                            >
                                {actionLoading ? '提交中...' : '确认投票'}
                            </button>
                        </div>
                    )}
                 </div>
            ) : (
                <div className="bg-gray-800 p-4 rounded border border-gray-700 text-gray-500 text-center italic">
                    💀 你已出局，无法参与投票。
                </div>
            )}
            
            {/* 房主按钮 */}
            {isHost && (
                <div className="mt-6 pt-6 border-t border-gray-700">
                    <button 
                        onClick={handleProcessDay}
                        className="w-full bg-gradient-to-r from-red-900 to-red-800 hover:from-red-800 hover:to-red-700 text-red-100 p-4 rounded-lg font-bold border border-red-600 shadow-xl transform hover:scale-[1.02] transition-all"
                    >
                        ⚖️ 公布投票结果 (处决结算)
                    </button>
                    <p className="text-center text-xs text-gray-500 mt-2">点击后将统计票数，处决最高票者，并进入下一夜或结束游戏。</p>
                </div>
            )}
        </div>
    );
  };

  // B. 主游戏容器 (状态分发)
  const renderGame = () => {
    // --- V0.6 新增: 游戏结束画面 ---
    if (roomState?.round_state === 'GAME OVER') {
        const alivePlayers = players.filter(p => p.is_alive);
        return (
            <div className="w-full max-w-2xl bg-gray-900 p-10 rounded-xl text-center border-4 border-yellow-600 shadow-2xl">
                <h1 className="text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-500 mb-8">
                    🏆 游戏结束
                </h1>
                
                <div className="bg-gray-800 p-8 rounded-xl mb-8 border border-gray-700">
                    <h3 className="text-2xl text-gray-300 mb-6 font-bold">最终幸存者</h3>
                    {alivePlayers.length > 0 ? (
                        <div className="flex flex-wrap justify-center gap-4">
                            {alivePlayers.map(p => (
                                <div key={p.id} className="bg-gradient-to-b from-yellow-600 to-yellow-800 text-white px-6 py-3 rounded-lg shadow-lg">
                                    <div className="text-xl font-bold">{p.name}</div>
                                    <div className="text-yellow-200 text-sm">{p.role}</div>
                                </div>
                            ))}
                        </div>
                    ) : (
                        <p className="text-red-400 text-xl">无人生还...</p>
                    )}
                </div>

                <button 
                    onClick={() => window.location.reload()} 
                    className="bg-gray-700 hover:bg-gray-600 text-white px-8 py-3 rounded-full font-bold transition transform hover:scale-105"
                >
                    返回大厅 (Reload)
                </button>
            </div>
        );
    }

    const isNight = roomState?.round_state.startsWith('NIGHT');
    
    return (
        <div className="w-full max-w-lg bg-gray-800 p-6 rounded-xl shadow-2xl space-y-6 border border-gray-700">
            {/* 顶部状态栏 */}
            <div className="border-b border-gray-700 pb-4 text-center">
                <h2 className={`text-4xl font-extrabold tracking-wider animate-pulse ${isNight ? 'text-red-500' : 'text-yellow-400'}`}>
                    {roomState?.round_state}
                </h2>
                <div className="flex justify-center items-center gap-2 mt-3 text-gray-400 text-sm">
                    <span className="w-2 h-2 rounded-full bg-green-500 inline-block"></span>
                    当前存活: {players.filter(p=>p.is_alive).length} 人
                </div>
            </div>

            {isNight ? (
                // --- 夜晚视图 ---
                <>
                    <div className="bg-gray-700/50 p-5 rounded-lg border-l-4 border-yellow-500 flex justify-between items-center">
                        <div>
                            <p className="text-xs text-gray-400 uppercase">你的身份</p>
                            <p className="text-2xl font-bold text-yellow-300">{getMyRole() || '...'}</p>
                        </div>
                        <div className="text-4xl opacity-20">🎭</div>
                    </div>
                    
                    {/* 技能区 */}
                    {getMyRole() && getActionType(getMyRole()!) ? (
                        <div className="bg-gray-900 p-5 rounded-lg border border-gray-600 shadow-md">
                            <h3 className="text-lg font-bold text-purple-400 mb-4 flex items-center gap-2">
                                🔮 <span>技能发动</span>
                            </h3>
                            {hasActed ? (
                                <div className="bg-green-900/20 border border-green-500/50 text-green-400 font-bold py-4 rounded text-center">
                                    ✅ 技能已提交
                                </div>
                            ) : (
                                <div className="space-y-4">
                                    <select 
                                        className="w-full p-3 bg-gray-800 text-white rounded border border-gray-700 focus:border-purple-500 focus:outline-none" 
                                        value={selectedTargetId} 
                                        onChange={e=>setSelectedTargetId(e.target.value)}
                                    >
                                        <option value="">-- 选择目标 --</option>
                                        {players.filter(p=>p.is_alive && p.name !== name).map(p=>(<option key={p.id} value={p.id}>{p.name}</option>))}
                                    </select>
                                    <button 
                                        onClick={handleSubmitAction} 
                                        disabled={actionLoading} 
                                        className="w-full bg-purple-600 hover:bg-purple-700 p-3 rounded font-bold shadow-lg transition transform active:scale-95"
                                    >
                                        {actionLoading ? '提交中...' : '确认发动'}
                                    </button>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="text-center text-gray-500 italic py-4">你今晚没有可用的主动技能。</div>
                    )}
                    
                    {/* 房主强制结算 */}
                    {isHost && (
                        <div className="mt-8 border-t border-gray-700 pt-6">
                            <button 
                                onClick={handleProcessNight} 
                                className="w-full bg-red-900 hover:bg-red-800 text-white p-4 rounded-lg font-bold border border-red-600 shadow-lg"
                            >
                                🌕 天亮了 (结算并进入白天)
                            </button>
                        </div>
                    )}
                </>
            ) : (
                // --- 白天视图 ---
                renderDay()
            )} 
        </div>
    );
  };

  // --- 7. 入口: 登录/大厅视图 ---
  if (!isInRoom) return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gray-800 via-gray-950 to-black">
        <h1 className="text-5xl font-bold mb-10 text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-600 drop-shadow-md">权谋决战</h1>
        <div className="bg-gray-900 p-8 rounded-xl shadow-2xl w-full max-w-md space-y-6 border border-gray-800">
            <div>
                <label className="text-xs text-gray-400 ml-1 mb-1 block">昵称</label>
                <input className="w-full p-4 rounded-lg bg-gray-800 border border-gray-700 focus:border-blue-500 focus:outline-none transition" placeholder="输入你的名字" value={name} onChange={e=>setName(e.target.value)} />
            </div>
            
            <div className="flex gap-3">
                <button onClick={createRoom} className="flex-1 bg-blue-700 hover:bg-blue-600 p-4 rounded-lg font-bold shadow-lg transition">创建房间</button>
            </div>
            
            <div className="relative flex py-2 items-center">
                <div className="flex-grow border-t border-gray-700"></div>
                <span className="flex-shrink mx-4 text-gray-500 text-sm">或</span>
                <div className="flex-grow border-t border-gray-700"></div>
            </div>

            <div className="flex gap-3">
                <input className="flex-1 p-4 rounded-lg bg-gray-800 border border-gray-700 focus:border-green-500 focus:outline-none transition" placeholder="输入房间号" value={roomCode} onChange={e=>setRoomCode(e.target.value)} />
                <button onClick={joinRoom} className="w-24 bg-green-700 hover:bg-green-600 p-4 rounded-lg font-bold shadow-lg transition">加入</button>
            </div>
            
            {error && <p className="text-red-400 text-sm bg-red-900/30 p-3 rounded text-center border border-red-900">{error}</p>}
        </div>
      </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        {roomState?.round_state === 'LOBBY' ? (
            <div className="w-full max-w-md text-center bg-gray-800 p-8 rounded-xl shadow-2xl border border-gray-700">
                <h1 className="text-3xl font-bold mb-6 text-yellow-500">等待大厅</h1>
                <div className="bg-gray-900 p-6 rounded-lg mb-6 border border-gray-600">
                    <p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Room Code</p>
                    <p className="text-6xl font-mono font-bold text-blue-400 tracking-wider">{roomCode}</p>
                </div>
                
                <div className="mb-8">
                    <p className="text-left text-gray-400 text-sm mb-3">已加入玩家 ({players.length})</p>
                    <div className="grid grid-cols-2 gap-3">
                        {players.map(p=>(
                            <div key={p.id} className="bg-gray-700 p-3 rounded flex items-center gap-2 border border-gray-600">
                                <span className={`w-2 h-2 rounded-full ${p.is_alive ? 'bg-green-500' : 'bg-red-500'}`}></span>
                                <span className="font-medium truncate">{p.name} {p.is_host && '👑'}</span>
                            </div>
                        ))}
                    </div>
                </div>

                {isHost ? (
                    <button 
                        onClick={handleStartGame} 
                        className={`w-full p-4 rounded-lg font-bold shadow-lg transition ${players.length < 2 ? 'bg-gray-600 cursor-not-allowed opacity-50' : 'bg-red-600 hover:bg-red-500'}`}
                        disabled={players.length < 2}
                    >
                        {players.length < 2 ? `等待玩家 (${players.length}/2)` : '🔥 开始游戏'}
                    </button>
                ) : (
                    <p className="text-gray-500 animate-pulse">等待房主开始游戏...</p>
                )}
            </div>
        ) : renderGame()}
        
        {error && <div className="fixed bottom-10 left-1/2 transform -translate-x-1/2 bg-red-900 text-white px-6 py-3 rounded-full shadow-2xl border border-red-500 z-50 flex items-center gap-2">
            <span>⚠️</span> {error}
        </div>}
    </div>
  );
}