'use client'; 

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

// --- 类型定义 ---
interface Player {
  id: number;
  room_code: string;
  name: string;
  is_alive: boolean;
  is_host: boolean;
  role: string | null;
  flags: any; // 允许任意格式的 flag
}

interface RoomState {
    code: string;
    round_state: string; 
}

interface GameLog {
    id: number;
    message: string;
    tag: string;
    viewer_ids: number[] | null;
    created_at: string;
}

export default function Home() {
  // --- 状态管理 ---
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');
  const [logs, setLogs] = useState<GameLog[]>([]);

  // 行动与投票状态
  const [selectedTargetId, setSelectedTargetId] = useState<string>(''); 
  const [hasActed, setHasActed] = useState(false); 
  const [hasVoted, setHasVoted] = useState(false); 
  const [actionLoading, setActionLoading] = useState(false);

  // --- 辅助函数 ---
  const getMyPlayer = () => players.find(p => p.name === name);
  const getMyRole = () => getMyPlayer()?.role;
  const isHost = getMyPlayer()?.is_host;
  
  const getActionType = (role: string) => {
      switch (role) {
          case '技能观测者': return 'check';
          case '利他守护者': return 'protect';
          case '沉默制裁者': return 'silence';
          case '投票阻断者': return 'block_vote';
          default: return null; 
      }
  };

  // --- 获取数据 ---
  const fetchLogs = async (code: string) => {
      const { data } = await supabase
        .from('game_logs')
        .select('*')
        .eq('room_code', code)
        .order('created_at', { ascending: false });
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

  // --- 提交技能 (夜晚) ---
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

  // --- 提交投票 (白天) ---
  const handleSubmitVote = async () => {
      const me = getMyPlayer();
      if (!me) return;
      
      const target = selectedTargetId ? parseInt(selectedTargetId) : null;

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
      } catch (err: any) { 
          setError(err.message); 
      } finally { setActionLoading(false); }
  };

  // --- 房主结算 (夜晚->白天) ---
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

  // --- 初始化逻辑 ---
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

  // --- 监听 ---
  useEffect(() => {
    if (!isInRoom || !roomCode) return;
    const ch1 = supabase.channel('room').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}`}, (payload) => {
        setRoomState(payload.new as RoomState);
        setHasActed(false); 
        setHasVoted(false); 
        fetchLogs(roomCode); 
        fetchPlayers(roomCode);
    }).subscribe();
    
    const ch2 = supabase.channel('logs').on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'game_logs', filter: `room_code=eq.${roomCode}`}, () => {
        fetchLogs(roomCode);
    }).subscribe();
    
    // 监听玩家状态变化 (V0.5补充: 确保玩家被禁言后能立刻刷新)
    const ch3 = supabase.channel('players').on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}`}, () => {
        fetchPlayers(roomCode);
    }).subscribe();
    
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); supabase.removeChannel(ch3); };
  }, [isInRoom, roomCode]);

  // --- 视图渲染 ---
  const renderDay = () => {
    const me = getMyPlayer();
    const myLogs = logs.filter(l => l.tag === 'PUBLIC' || (me && l.viewer_ids?.includes(me.id)));
    const alivePlayers = players.filter(p => p.is_alive);

    return (
        <div className="space-y-6">
            <div className="bg-gray-900 p-4 rounded-lg border border-gray-700 max-h-48 overflow-y-auto">
                <h3 className="text-gray-400 font-bold mb-2 sticky top-0 bg-gray-900">📢 游戏公告</h3>
                {myLogs.length === 0 ? <p className="text-gray-500 text-sm">暂无消息...</p> : 
                    myLogs.map(log => (
                        <div key={log.id} className={`mb-2 p-2 rounded text-sm ${log.tag==='PRIVATE' ? 'bg-indigo-900 border-l-2 border-indigo-400' : 'bg-gray-800'}`}>
                            {log.tag==='PRIVATE' && <span className="text-indigo-300 font-bold">[私密] </span>}
                            {log.message}
                        </div>
                    ))
                }
            </div>

            {me?.is_alive ? (
                 <div className="bg-gray-800 p-4 rounded-lg border border-gray-600">
                    <h3 className="text-lg font-bold text-yellow-500 mb-3">🗳️ 投票处决</h3>
                    {hasVoted ? (
                        <div className="text-green-400 font-bold py-2">✅ 已投票，等待结算...</div>
                    ) : (
                        <div className="space-y-3">
                             {me.flags?.cannot_vote && <p className="text-red-400 text-sm font-bold bg-red-900/50 p-2 rounded">⛔ 你被【投票阻断者】限制，今日不可投票。</p>}
                            
                            <select 
                                className="w-full p-3 rounded bg-gray-700 text-white border border-gray-500"
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
                                className={`w-full p-3 rounded font-bold transition ${
                                    me.flags?.cannot_vote ? 'bg-gray-600 cursor-not-allowed' : 'bg-yellow-600 hover:bg-yellow-700'
                                }`}
                            >
                                {actionLoading ? '提交中...' : '确认投票'}
                            </button>
                        </div>
                    )}
                 </div>
            ) : (
                <div className="text-gray-500 text-center p-4">你已出局，无法投票。</div>
            )}
            
            {isHost && (
                <div className="mt-4 pt-4 border-t border-gray-600">
                    <button className="w-full bg-gray-700 text-gray-400 p-3 rounded border border-dashed border-gray-500">
                        (V0.6) 结束投票并处决
                    </button>
                </div>
            )}
        </div>
    );
  };

  const renderGame = () => {
    const isNight = roomState?.round_state.startsWith('NIGHT');
    
    return (
        <div className="w-full max-w-lg bg-gray-800 p-6 rounded-lg shadow-2xl space-y-6">
            <div className="border-b border-gray-700 pb-4 text-center">
                <h2 className={`text-3xl font-extrabold animate-pulse ${isNight ? 'text-red-500' : 'text-yellow-400'}`}>
                    {roomState?.round_state}
                </h2>
                <p className="text-gray-400 mt-2">存活: {players.filter(p=>p.is_alive).length} 人</p>
            </div>

            {isNight ? (
                <>
                    <div className="bg-gray-700 p-4 rounded border-l-4 border-yellow-500">
                        <p className="text-sm text-gray-400">身份</p>
                        <p className="text-2xl font-bold text-yellow-300">{getMyRole() || '...'}</p>
                    </div>
                    {getMyRole() && getActionType(getMyRole()!) && (
                        <div className="bg-gray-900 p-4 rounded-lg border border-gray-600">
                            <h3 className="text-lg font-bold text-purple-400 mb-3">技能发动</h3>
                            {hasActed ? <div className="text-green-400 font-bold py-4">✅ 技能已提交</div> : (
                                <div className="space-y-3">
                                    <select className="w-full p-3 bg-gray-800 text-white rounded" value={selectedTargetId} onChange={e=>setSelectedTargetId(e.target.value)}>
                                        <option value="">-- 选择目标 --</option>
                                        {players.filter(p=>p.is_alive&&p.name!==name).map(p=>(<option key={p.id} value={p.id}>{p.name}</option>))}
                                    </select>
                                    <button onClick={handleSubmitAction} disabled={actionLoading} className="w-full bg-purple-600 p-3 rounded font-bold">确认发动</button>
                                </div>
                            )}
                        </div>
                    )}
                    {isHost && (
                        <div className="mt-8 border-t border-gray-600 pt-4">
                            <button onClick={handleProcessNight} className="w-full bg-red-800 hover:bg-red-900 text-white p-4 rounded-lg font-bold border border-red-500">🌕 天亮了 (结算)</button>
                        </div>
                    )}
                </>
            ) : renderDay()} 
        </div>
    );
  };

  if (!isInRoom) return (
      <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <h1 className="text-4xl font-bold mb-8 text-yellow-500">权谋决战</h1>
        <div className="bg-gray-800 p-8 rounded-lg w-full max-w-md space-y-4">
            <input className="w-full p-3 rounded bg-gray-700" placeholder="你的名字" value={name} onChange={e=>setName(e.target.value)} />
            <div className="flex gap-2">
                <button onClick={createRoom} className="flex-1 bg-blue-600 p-3 rounded">创建</button>
                <input className="flex-1 p-3 rounded bg-gray-700" placeholder="房间号" value={roomCode} onChange={e=>setRoomCode(e.target.value)} />
                <button onClick={joinRoom} className="bg-green-600 p-3 rounded">加入</button>
            </div>
            {error && <p className="text-red-500">{error}</p>}
        </div>
      </div>
  );

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <h1 className="text-4xl font-bold mb-8 text-yellow-500">权谋决战</h1>
        {roomState?.round_state === 'LOBBY' ? (
            <div className="w-full max-w-md text-center">
                <div className="bg-gray-800 p-6 rounded mb-4"><p className="text-5xl font-mono font-bold text-blue-400">{roomCode}</p></div>
                <div className="grid grid-cols-2 gap-3 mb-6">{players.map(p=>(<div key={p.id} className="bg-gray-700 p-2 rounded">{p.name} {p.is_host && '👑'}</div>))}</div>
                {players.find(p=>p.name===name)?.is_host && <button onClick={createRoom} className="bg-red-600 p-3 rounded w-full font-bold">开始游戏 (2人+)</button>}
            </div>
        ) : renderGame()}
        {error && <p className="text-red-500 mt-4 bg-gray-800 p-2 rounded">{error}</p>}
    </div>
  );
} // <--- 关键！就是这个括号之前缺了！