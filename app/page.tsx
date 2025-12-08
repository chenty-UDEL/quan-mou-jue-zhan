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
  flags: any; 
}

interface RoomState {
    code: string;
    round_state: string; // "LOBBY", "NIGHT 1", "DAY 1", "GAME OVER"
}

interface GameLog {
    id: number;
    message: string;
    tag: string;
    viewer_ids: number[] | null;
    created_at: string;
}

export default function Home() {
  // --- 2. 状态管理 ---
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [logs, setLogs] = useState<GameLog[]>([]);
  const [error, setError] = useState('');

  // 游戏操作状态
  const [selectedTargetId, setSelectedTargetId] = useState<string>(''); 
  const [hasActed, setHasActed] = useState(false); 
  const [hasVoted, setHasVoted] = useState(false); 
  const [actionLoading, setActionLoading] = useState(false);

  // --- 3. 辅助工具函数 ---
  const getMyPlayer = () => players.find(p => p.name === name);
  const getMyRole = () => getMyPlayer()?.role;
  const isHost = getMyPlayer()?.is_host;
  
  // 角色技能映射
  const getActionType = (role: string, roundState: string) => {
      const roundNum = parseInt(roundState.split(' ')[1]) || 1;
      switch (role) {
          case '技能观测者': return 'check';
          case '利他守护者': return 'protect';
          case '沉默制裁者': return 'silence';
          case '投票阻断者': return 'block_vote';
          case '同盟者': return roundNum === 1 ? 'ally_bind' : null;
          case '影子胜者': return roundNum === 1 ? 'shadow_bind' : null;
          case '命运复制者': return roundNum === 1 ? 'copy_fate' : null; 
          default: return null; 
      }
  };

  // --- 4. 数据监听 ---
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
    const ch1 = supabase.channel('room').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}`}, (payload) => {
        setRoomState(payload.new as RoomState);
        setHasActed(false); setHasVoted(false); setSelectedTargetId(''); 
        fetchLogs(roomCode); fetchPlayers(roomCode);
    }).subscribe();
    const ch2 = supabase.channel('logs').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs', filter: `room_code=eq.${roomCode}`}, () => fetchLogs(roomCode)).subscribe();
    const ch3 = supabase.channel('players').on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}`}, () => fetchPlayers(roomCode)).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); };
  }, [isInRoom, roomCode]);

  // --- 5. 交互逻辑 ---
  const handleStartGame = async () => {
      setError('');
      if (players.length < 2) return setError('人数不足 2 人'); 
      try {
          await fetch('/api/start-game', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode }), });
      } catch (err: any) { setError(err.message); }
  };
  const handleSubmitAction = async () => {
      const me = getMyPlayer();
      if (!me || !me.role || !roomState) return;
      const type = getActionType(me.role, roomState.round_state);
      if (!selectedTargetId) return setError('请先选择目标');
      setActionLoading(true);
      try {
          const res = await fetch('/api/submit-action', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode, actorId: me.id, targetId: parseInt(selectedTargetId), actionType: type }) });
          if (!res.ok) throw new Error('提交失败');
          setHasActed(true); setError(''); 
      } catch (err) { setError('出错请重试'); } finally { setActionLoading(false); }
  };
  const handleProcessNight = async () => {
      if (!confirm('确定要结束夜晚并进行结算吗？')) return;
      try { await fetch('/api/process-night', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode }), }); } catch (err) { alert('结算请求失败'); }
  };
  const handleSubmitVote = async () => {
      const me = getMyPlayer();
      if (!me) return;
      const target = selectedTargetId ? parseInt(selectedTargetId) : null;
      setActionLoading(true);
      try {
          const res = await fetch('/api/submit-vote', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode, voterId: me.id, targetId: target }) });
          const result = await res.json();
          if (!res.ok) throw new Error(result.message || '投票失败');
          setHasVoted(true); setError(''); 
      } catch (err: any) { setError(err.message); } finally { setActionLoading(false); }
  };
  const handleProcessDay = async () => {
      if (!confirm('确定要结束投票并公布结果吗？')) return;
      try {
          const res = await fetch('/api/process-day', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ roomCode }), });
          if (!res.ok) throw new Error('结算失败');
      } catch (err) { alert('结算请求失败'); }
  };
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

  // --- 6. 视图组件 ---

  const renderGame = () => {
    // --- 游戏结束画面 (修复版：显示获胜原因) ---
    if (roomState?.round_state === 'GAME OVER') {
        const alivePlayers = players.filter(p => p.is_alive);
        // 🔍 获取最后一条公开日志，作为胜利宣言
        const winLog = logs.find(l => l.tag === 'PUBLIC' && (l.message.includes('获胜') || l.message.includes('结束') || l.message.includes('🎉')));
        
        return (
            <div className="w-full max-w-2xl bg-gray-900 p-10 rounded-xl text-center border-4 border-yellow-600 shadow-2xl">
                <h1 className="text-6xl font-extrabold text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-500 mb-6">
                    🏆 游戏结束
                </h1>
                
                {/* 新增：显示获胜公告 */}
                <div className="bg-yellow-900/30 border border-yellow-600 p-4 rounded-lg mb-8">
                    <p className="text-xl text-yellow-200 font-bold">
                        {winLog ? winLog.message : '游戏已结束'}
                    </p>
                </div>

                <div className="bg-gray-800 p-8 rounded-xl mb-8 border border-gray-700">
                    <h3 className="text-2xl text-gray-300 mb-6 font-bold">最终幸存者名单</h3>
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

    const me = getMyPlayer();
    const isNight = roomState?.round_state.startsWith('NIGHT');
    const actionType = (isNight && me?.role && roomState) ? getActionType(me.role, roomState.round_state) : null;
    const myLogs = logs.filter(l => l.tag === 'PUBLIC' || (me && l.viewer_ids?.includes(me.id)));
    const alivePlayers = players.filter(p => p.is_alive);

    return (
        <div className="w-full max-w-lg bg-gray-800 p-6 rounded-xl shadow-2xl space-y-6 border border-gray-700">
            {/* 顶部：回合状态 */}
            <div className="border-b border-gray-700 pb-4 text-center">
                <h2 className={`text-4xl font-extrabold tracking-wider animate-pulse ${isNight ? 'text-red-500' : 'text-yellow-400'}`}>
                    {roomState?.round_state}
                </h2>
                <p className="text-gray-400 text-sm mt-2">存活人数: {alivePlayers.length}</p>
            </div>

            {/* 新增: 个人状态卡片 (始终显示) */}
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-600 flex justify-between items-center shadow-md">
                <div>
                    <p className="text-xs text-gray-500 uppercase font-bold tracking-wider">当前玩家</p>
                    <div className="flex items-baseline gap-2">
                        <span className="text-xl font-bold text-white">{me?.name}</span>
                        <span className="text-sm text-yellow-500">({me?.role || '身份加载中...'})</span>
                    </div>
                </div>
                <div className={`px-3 py-1 rounded-full text-sm font-bold border ${me?.is_alive ? 'bg-green-900/30 border-green-500 text-green-400' : 'bg-red-900/30 border-red-500 text-red-500'}`}>
                    {me?.is_alive ? '● 存活' : '💀 已出局'}
                </div>
            </div>

            {/* 核心游戏区域 (根据死活判定) */}
            {me?.is_alive ? (
                /* === 存活玩家界面 === */
                isNight ? (
                    /* 夜晚界面 */
                    <div className="space-y-4">
                        {actionType ? (
                            <div className="bg-gray-900 p-5 rounded-lg border border-gray-600 shadow-md">
                                <h3 className="text-lg font-bold text-purple-400 mb-4 flex items-center gap-2">🔮 <span>技能发动</span></h3>
                                {hasActed ? (
                                    <div className="bg-green-900/20 border border-green-500/50 text-green-400 font-bold py-4 rounded text-center">✅ 技能已提交</div>
                                ) : (
                                    <div className="space-y-4">
                                        <select className="w-full p-3 bg-gray-800 text-white rounded border border-gray-700 focus:border-purple-500 outline-none" value={selectedTargetId} onChange={e=>setSelectedTargetId(e.target.value)}>
                                            <option value="">-- 选择目标 --</option>
                                            {players.filter(p=>p.is_alive && p.name !== name).map(p=>(<option key={p.id} value={p.id}>{p.name}</option>))}
                                        </select>
                                        <button onClick={handleSubmitAction} disabled={actionLoading} className="w-full bg-purple-600 hover:bg-purple-700 p-3 rounded font-bold shadow-lg">
                                            {actionLoading ? '提交中...' : '确认发动'}
                                        </button>
                                    </div>
                                )}
                            </div>
                        ) : (
                            <div className="text-center text-gray-500 italic py-4 bg-gray-900/50 rounded">
                                {me?.role === '同盟者' ? '技能只能在第一夜发动。' : '今晚无主动技能，请等待天亮。'}
                            </div>
                        )}
                    </div>
                ) : (
                    /* 白天界面 */
                    <div className="space-y-6">
                        {/* 公告栏 */}
                        <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 max-h-52 overflow-y-auto shadow-inner">
                            <h3 className="text-gray-400 font-bold mb-2 sticky top-0 bg-gray-900 pb-2 border-b border-gray-800">📢 公告</h3>
                            {myLogs.length === 0 ? <p className="text-gray-600 text-sm py-4 text-center">暂无消息...</p> : 
                                myLogs.map(log => (
                                    <div key={log.id} className={`mb-2 p-3 rounded text-sm shadow-sm ${log.tag==='PRIVATE' ? 'bg-indigo-900/40 border-l-4 border-indigo-500 text-indigo-200' : 'bg-gray-800 text-gray-300'}`}>
                                        {log.tag==='PRIVATE' && <span className="text-indigo-400 font-bold text-xs uppercase mr-1">[私密]</span>}
                                        {log.message}
                                    </div>
                                ))
                            }
                        </div>
                        {/* 投票区 */}
                        <div className="bg-gray-800 p-5 rounded-lg border border-gray-600 shadow-lg">
                            <h3 className="text-lg font-bold text-yellow-500 mb-4">🗳️ 投票处决</h3>
                            {hasVoted ? (
                                <div className="bg-green-900/30 border border-green-600 text-green-400 font-bold p-4 rounded text-center">✅ 已投票</div>
                            ) : (
                                <div className="space-y-4">
                                    {me.flags?.cannot_vote && <div className="bg-red-900/50 border border-red-700 p-2 rounded text-red-300 text-sm text-center">⛔ 被【投票阻断者】限制</div>}
                                    <select className="w-full p-3 rounded bg-gray-700 text-white border border-gray-500" value={selectedTargetId} onChange={(e) => setSelectedTargetId(e.target.value)} disabled={!!me.flags?.cannot_vote}>
                                        <option value="">-- 投票给谁 (不选为弃票) --</option>
                                        {alivePlayers.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
                                    </select>
                                    <button onClick={handleSubmitVote} disabled={!!me.flags?.cannot_vote || actionLoading} className={`w-full p-3 rounded font-bold shadow-md ${me.flags?.cannot_vote ? 'bg-gray-600 cursor-not-allowed' : 'bg-yellow-600 hover:bg-yellow-700 text-black'}`}>
                                        {actionLoading ? '提交中...' : '确认投票'}
                                    </button>
                                </div>
                            )}
                        </div>
                    </div>
                )
            ) : (
                /* === 死亡玩家界面 === */
                <div className="bg-red-950/40 border-2 border-red-900/50 p-6 rounded-xl text-center space-y-4 animate-in fade-in duration-500">
                    <div className="text-6xl">👻</div>
                    <h3 className="text-2xl font-bold text-red-500">你已出局</h3>
                    <p className="text-red-300/80">
                        你无法再参与投票或发动技能。<br/>
                        请保持沉默，静待游戏结果。
                    </p>
                    {/* 死亡玩家依然可以看到公告 */}
                    {!isNight && (
                        <div className="bg-gray-900/50 p-4 rounded text-left max-h-40 overflow-y-auto mt-4 border border-red-900/30">
                            <p className="text-xs text-gray-500 mb-2">历史记录:</p>
                            {myLogs.map(log => <div key={log.id} className="text-xs text-gray-400 mb-1 border-b border-gray-800 pb-1">{log.message}</div>)}
                        </div>
                    )}
                </div>
            )}

            {/* 房主控制区 (无论生死，始终可见，防止游戏死锁) */}
            {isHost && (
                <div className="mt-8 border-t border-gray-700 pt-6">
                    <p className="text-xs text-gray-500 mb-2 text-center">房主控制面板 (上帝视角)</p>
                    {isNight ? (
                        <button onClick={handleProcessNight} className="w-full bg-red-900 hover:bg-red-800 text-white p-4 rounded-lg font-bold border border-red-600 shadow-lg">🌕 天亮了 (结算)</button>
                    ) : (
                        <button onClick={handleProcessDay} className="w-full bg-gradient-to-r from-red-900 to-red-800 hover:from-red-800 hover:to-red-700 text-red-100 p-4 rounded-lg font-bold border border-red-600 shadow-xl">⚖️ 公布结果 (处决)</button>
                    )}
                </div>
            )}
        </div>
    );
  };

  // --- 7. 大厅视图 ---
  if (!isInRoom) return (
      <div className="min-h-screen bg-gray-950 text-white flex flex-col items-center justify-center p-4 bg-[radial-gradient(ellipse_at_center,_var(--tw-gradient-stops))] from-gray-800 via-gray-950 to-black">
        <h1 className="text-5xl font-bold mb-10 text-transparent bg-clip-text bg-gradient-to-r from-yellow-400 to-red-600 drop-shadow-md">权谋决战</h1>
        <div className="bg-gray-900 p-8 rounded-xl shadow-2xl w-full max-w-md space-y-6 border border-gray-800">
            <div><label className="text-xs text-gray-400 ml-1 mb-1 block">昵称</label><input className="w-full p-4 rounded-lg bg-gray-800 border border-gray-700 focus:border-blue-500 outline-none" placeholder="输入你的名字" value={name} onChange={e=>setName(e.target.value)} /></div>
            <div className="flex gap-3"><button onClick={createRoom} className="flex-1 bg-blue-700 hover:bg-blue-600 p-4 rounded-lg font-bold shadow-lg">创建房间</button></div>
            <div className="relative flex py-2 items-center"><div className="flex-grow border-t border-gray-700"></div><span className="flex-shrink mx-4 text-gray-500 text-sm">或</span><div className="flex-grow border-t border-gray-700"></div></div>
            <div className="flex gap-3"><input className="flex-1 p-4 rounded-lg bg-gray-800 border border-gray-700 focus:border-green-500 outline-none" placeholder="输入房间号" value={roomCode} onChange={e=>setRoomCode(e.target.value)} /><button onClick={joinRoom} className="w-24 bg-green-700 hover:bg-green-600 p-4 rounded-lg font-bold shadow-lg">加入</button></div>
            {error && <p className="text-red-400 text-sm bg-red-900/30 p-3 rounded text-center border border-red-900">{error}</p>}
        </div>
      </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        {roomState?.round_state === 'LOBBY' ? (
            <div className="w-full max-w-md text-center bg-gray-800 p-8 rounded-xl shadow-2xl border border-gray-700">
                <h1 className="text-3xl font-bold mb-6 text-yellow-500">等待大厅</h1>
                <div className="bg-gray-900 p-6 rounded-lg mb-6 border border-gray-600"><p className="text-gray-400 text-xs uppercase tracking-widest mb-2">Room Code</p><p className="text-6xl font-mono font-bold text-blue-400 tracking-wider">{roomCode}</p></div>
                <div className="mb-8"><p className="text-left text-gray-400 text-sm mb-3">已加入玩家 ({players.length})</p><div className="grid grid-cols-2 gap-3">{players.map(p=>(<div key={p.id} className="bg-gray-700 p-3 rounded flex items-center gap-2 border border-gray-600"><span className={`w-2 h-2 rounded-full ${p.is_alive ? 'bg-green-500' : 'bg-red-500'}`}></span><span className="font-medium truncate">{p.name} {p.is_host && '👑'}</span></div>))}</div></div>
                {isHost ? (<button onClick={handleStartGame} className={`w-full p-4 rounded-lg font-bold shadow-lg transition ${players.length < 2 ? 'bg-gray-600 cursor-not-allowed opacity-50' : 'bg-red-600 hover:bg-red-500'}`} disabled={players.length < 2}>{players.length < 2 ? `等待玩家 (${players.length}/2)` : '🔥 开始游戏'}</button>) : (<p className="text-gray-500 animate-pulse">等待房主开始游戏...</p>)}
            </div>
        ) : renderGame()}
        {error && <div className="fixed bottom-10 left-1/2 transform -translate-x-1/2 bg-red-900 text-white px-6 py-3 rounded-full shadow-2xl border border-red-500 z-50 flex items-center gap-2"><span>⚠️</span> {error}</div>}
    </div>
  );
}