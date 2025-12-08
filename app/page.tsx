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
}

interface RoomState {
    code: string;
    round_state: string; 
}

export default function Home() {
  // --- 状态管理 ---
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');

  // 行动相关
  const [selectedTargetId, setSelectedTargetId] = useState<string>(''); 
  const [hasActed, setHasActed] = useState(false); 
  const [actionLoading, setActionLoading] = useState(false);

  // --- 辅助函数 ---
  const getMyPlayer = () => players.find(p => p.name === name);
  const getMyRole = () => getMyPlayer()?.role;
  const isHost = getMyPlayer()?.is_host; // 判断是否房主
  
  const getActionType = (role: string) => {
      switch (role) {
          case '技能观测者': return 'check';
          case '利他守护者': return 'protect';
          case '沉默制裁者': return 'silence';
          case '投票阻断者': return 'block_vote';
          default: return null; 
      }
  };

  // --- 核心功能 1: 玩家提交技能 ---
  const handleSubmitAction = async () => {
      const me = getMyPlayer();
      if (!me || !me.role) return;

      const type = getActionType(me.role);
      if (!type) return setError('你当前没有可用技能');
      if (!selectedTargetId) return setError('请先选择一个目标');

      setActionLoading(true);
      try {
          const res = await fetch('/api/submit-action', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                  roomCode: roomCode,
                  actorId: me.id,
                  targetId: parseInt(selectedTargetId),
                  actionType: type,
                  roundNumber: 1 
              })
          });
          
          if (!res.ok) throw new Error('提交失败');
          
          setHasActed(true); 
          setError(''); 
      } catch (err) {
          setError('行动提交出错，请重试');
      } finally {
          setActionLoading(false);
      }
  };

  // --- 核心功能 2: 房主强制结算 (天亮了) ---
  const handleProcessNight = async () => {
      if (!confirm('确定要结束夜晚并进行结算吗？所有人的技能都将生效。')) return;
      try {
          const res = await fetch('/api/process-night', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
          if (!res.ok) throw new Error('结算失败');
      } catch (err) { alert('结算请求失败'); }
  };

  // --- 基础房间逻辑 ---
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
      setRoomCode(code); setIsInRoom(true); fetchPlayers(code); fetchRoomState(code);
  };
  const fetchPlayers = async (code:string) => {
      const {data} = await supabase.from('players').select('*').eq('room_code', code).order('id');
      if(data) setPlayers(data as Player[]);
  };
  const fetchRoomState = async (code:string) => {
      const {data} = await supabase.from('rooms').select('code, round_state').eq('code',code).single();
      if(data) setRoomState(data as RoomState);
  };

  useEffect(() => {
    if (!isInRoom || !roomCode) return;
    const ch1 = supabase.channel('room').on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}`}, (payload) => {
        setRoomState(payload.new as RoomState);
        setHasActed(false); // 新阶段开始，重置行动状态
        fetchPlayers(roomCode); // 刷新玩家状态（如被禁言标记）
    }).subscribe();
    const ch2 = supabase.channel('players').on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}`}, () => fetchPlayers(roomCode)).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [isInRoom, roomCode]);

  // --- 视图渲染 ---

  const renderGame = () => {
    const myRole = getMyRole();
    const isNight = roomState?.round_state.startsWith('NIGHT');
    const actionType = myRole ? getActionType(myRole) : null;
    const availableTargets = players.filter(p => p.is_alive && p.name !== name);

    return (
        <div className="w-full max-w-lg bg-gray-800 p-6 rounded-lg shadow-2xl text-center space-y-6">
            <div className="border-b border-gray-700 pb-4">
                <h2 className="text-3xl font-extrabold text-red-500 animate-pulse">{roomState?.round_state}</h2>
                <p className="text-gray-400 mt-2">当前存活: {players.filter(p=>p.is_alive).length} 人</p>
            </div>
            
            <div className="bg-gray-700 p-4 rounded border-l-4 border-yellow-500 text-left">
                <p className="text-sm text-gray-400">你的身份</p>
                <p className="text-2xl font-bold text-yellow-300">{myRole || '...'}</p>
            </div>

            {/* 技能操作区 (仅夜晚显示) */}
            {isNight && actionType && (
                <div className="bg-gray-900 p-4 rounded-lg border border-gray-600">
                    <h3 className="text-lg font-bold text-purple-400 mb-3">技能发动</h3>
                    {hasActed ? (
                        <div className="text-green-400 font-bold py-4">✅ 技能已提交</div>
                    ) : (
                        <div className="space-y-3">
                            <select 
                                className="w-full p-3 rounded bg-gray-800 text-white border border-gray-600"
                                value={selectedTargetId}
                                onChange={(e) => setSelectedTargetId(e.target.value)}
                            >
                                <option value="">-- 选择目标 --</option>
                                {availableTargets.map(p => (<option key={p.id} value={p.id}>{p.name}</option>))}
                            </select>
                            <button onClick={handleSubmitAction} disabled={actionLoading} className="w-full bg-purple-600 hover:bg-purple-700 p-3 rounded font-bold">
                                {actionLoading ? '提交中...' : '确认发动'}
                            </button>
                        </div>
                    )}
                </div>
            )}

            {/* --- 🔴 房主专用：天亮了按钮 (这部分你之前可能漏了) --- */}
            {isHost && isNight && (
                <div className="mt-8 border-t border-gray-600 pt-4">
                    <button 
                        onClick={handleProcessNight}
                        className="w-full bg-red-800 hover:bg-red-900 text-white p-4 rounded-lg font-bold border border-red-500 shadow-lg transform hover:scale-105 transition"
                    >
                        🌕 天亮了 (结算并进入白天)
                    </button>
                </div>
            )}
        </div>
    );
  };

  // 登录/大厅视图
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
                {players.find(p=>p.name===name)?.is_host && <button onClick={handleStartGame} className="bg-red-600 p-3 rounded w-full font-bold">开始游戏 (2人+)</button>}
            </div>
        ) : renderGame()}
        {error && <p className="text-red-500 mt-4 bg-gray-800 p-2 rounded">{error}</p>}
    </div>
  );
}