'use client'; 

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

// --- 接口定义 ---
interface Player {
  id: number;
  room_code: string;
  name: string;
  is_alive: boolean;
  is_host: boolean;
  role: string | null; // V0.2新增
}

interface RoomState {
    code: string;
    round_state: string; // V0.2新增 (LOBBY, NIGHT 1, DAY 1, etc.)
}

export default function Home() {
  // 状态管理
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');

  // 1. 启动游戏 (Host Only)
  const handleStartGame = async () => {
      setError('');
      if (players.length < 6) {
          return setError('人数不足 6 人，无法开始游戏。');
      }
      try {
          // 调用我们新建的 Vercel API 函数
          const response = await fetch('/api/start-game', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
          const result = await response.json();

          if (!response.ok) {
              return setError(result.message || '启动游戏失败');
          }
      } catch (err: any) {
          setError('网络错误：' + err.message);
      }
  };

  // 2. 获取房间信息
  const fetchRoomState = async (code: string) => {
      const { data } = await supabase.from('rooms').select('code, round_state').eq('code', code).single();
      if (data) setRoomState(data);
  };
  
  // (保留原有的创建/加入/获取玩家函数...)
  const createRoom = async () => { /* ... (保留原有逻辑) ... */ 
      if (!name) return setError('请输入名字');
      const code = Math.floor(1000 + Math.random() * 9000).toString();
      const { error: roomErr } = await supabase.from('rooms').insert([{ code }]);
      if (roomErr) return setError(roomErr.message);
      joinGameLogic(code, true);
  };
  const joinRoom = async () => { /* ... (保留原有逻辑) ... */
      if (!name || !roomCode) return setError('请输入名字和房间号');
      const { data } = await supabase.from('rooms').select().eq('code', roomCode);
      if (!data || data.length === 0) return setError('房间不存在');
      joinGameLogic(roomCode, false);
  };
  const joinGameLogic = async (code: string, isHost: boolean) => { /* ... (保留原有逻辑) ... */
      const { data: existing } = await supabase.from('players').select().eq('room_code', code).eq('name', name);
      if (existing && existing.length > 0) return setError('名字已存在');
      const { error } = await supabase.from('players').insert([{ room_code: code, name: name, is_host: isHost }]);
      if (error) return setError(error.message);
      setRoomCode(code);
      setIsInRoom(true);
      fetchPlayers(code);
      fetchRoomState(code); // V0.2: 获取房间状态
  };

  const fetchPlayers = async (code: string) => { 
      const { data } = await supabase.from('players').select('*').eq('room_code', code);
      if (data) setPlayers(data as Player[]);
  };


  // 3. 实时监听 (V0.2 更新: 增加对 rooms 表的监听)
  useEffect(() => {
    if (!isInRoom || !roomCode) return;
    
    // 监听 rooms 表 (用于 phase 切换)
    const roomChannel = supabase.channel('room-state-updates')
      .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'rooms', filter: `code=eq.${roomCode}` }, (payload) => {
        setRoomState(payload.new as RoomState);
      })
      .subscribe();
      
    // 监听 players 表 (用于列表更新，和V0.1一样)
    const playerChannel = supabase.channel('player-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}` }, () => {
        fetchPlayers(roomCode); 
      })
      .subscribe();

    return () => { 
        supabase.removeChannel(roomChannel);
        supabase.removeChannel(playerChannel);
    };
  }, [isInRoom, roomCode]);

  // 辅助函数: 检查当前玩家的身份
  const getMyRole = () => {
    return players.find(p => p.name === name)?.role;
  };

  // 辅助函数: 检查当前玩家是否是房主
  const isHost = players.find(p => p.name === name)?.is_host;

  // --- 4. 视图渲染 ---

  const renderLobby = () => (
      <div className="w-full max-w-md">
          {/* 房间号和玩家列表 (与V0.1相同) */}
          <div className="bg-gray-800 p-6 rounded-lg mb-4 text-center">
              <p className="text-gray-400">房间号</p>
              <p className="text-5xl font-mono font-bold text-blue-400 tracking-widest">{roomCode}</p>
          </div>
          <h2 className="text-xl mb-4 text-gray-300">已加入玩家 ({players.length})</h2>
          {/* ... (玩家列表渲染代码不变) ... */}
          <div className="grid grid-cols-2 gap-3 mb-6">
            {players.map((p) => (
              <div key={p.id} className="bg-gray-700 p-3 rounded flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${p.is_alive ? 'bg-green-500' : 'bg-red-500'}`}></div>
                <span className="font-medium">{p.name} {p.is_host && '👑'}</span>
              </div>
            ))}
          </div>

          {/* 开始游戏按钮 (V0.2新增) */}
          <div className="mt-8 text-center">
              {isHost ? (
                  <button 
                      onClick={handleStartGame}
                      className={`p-3 rounded font-bold transition ${players.length < 6 ? 'bg-gray-600 cursor-not-allowed' : 'bg-red-600 hover:bg-red-700'}`}
                      disabled={players.length < 6}
                  >
                      {players.length < 6 ? `需至少6人才能开始 (${players.length}/6)` : '房主：开始游戏'}
                  </button>
              ) : (
                  <p className="text-gray-500 text-sm">等待房主开始游戏...</p>
              )}
          </div>
      </div>
  );

  const renderGame = () => {
    const myRole = getMyRole();

    return (
        <div className="w-full max-w-lg bg-gray-800 p-6 rounded-lg shadow-2xl">
            <h2 className="text-3xl font-extrabold text-red-400 mb-4">{roomState?.round_state}</h2>
            
            <div className="bg-gray-700 p-4 rounded mb-6">
                <p className="text-lg text-gray-400">你的身份是：</p>
                <p className="text-4xl font-bold text-yellow-300">{myRole || '加载中...'}</p>
            </div>
            
            {/* 待办: 根据角色显示技能按钮和目标列表 */}
            <div className="text-gray-400">
                <p>— 技能提示 —</p>
                [cite_start]{myRole === '技能观测者' && <p className="text-sm">每天夜晚指定一名玩家，查看其技能。 [cite: 20]</p>}
                [cite_start]{myRole === '利他守护者' && <p className="text-sm">每天夜晚选择一名除你以外的玩家，使他第二天白天被投票数为0。 [cite: 21]</p>}
                [cite_start]{myRole === '三人王者' && <p className="text-sm">胜利条件：当只剩三名玩家时，你获胜。 [cite: 30]</p>}
                
                {/* 待办: V0.3添加 Night Action UI */}
                <button className="mt-4 bg-purple-600 p-2 rounded w-full">（V0.3: 发动技能）</button>
            </div>
        </div>
    );
  };

  // 主渲染逻辑
  if (!isInRoom) {
      // 登录界面 (与V0.1相同)
      return (
        <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
          <h1 className="text-4xl font-bold mb-8 text-yellow-500">权谋决战 (Clash of Schemes)</h1>
          <div className="bg-gray-800 p-8 rounded-lg shadow-lg w-full max-w-md space-y-4">
            <input className="w-full p-3 rounded bg-gray-700 text-white" placeholder="你的名字" value={name} onChange={e => setName(e.target.value)} />
            <div className="flex gap-2"><button onClick={createRoom} className="flex-1 bg-blue-600 hover:bg-blue-700 p-3 rounded font-bold">创建房间</button></div>
            <div className="flex gap-2 items-center"><div className="h-px bg-gray-600 flex-1"></div><span className="text-gray-400">或者</span><div className="h-px bg-gray-600 flex-1"></div></div>
            <div className="flex gap-2">
              <input className="flex-1 p-3 rounded bg-gray-700 text-white" placeholder="输入房间号" value={roomCode} onChange={e => setRoomCode(e.target.value)} />
              <button onClick={joinRoom} className="bg-green-600 hover:bg-green-700 p-3 rounded font-bold">加入</button>
            </div>
            {error && <p className="text-red-500 text-sm">{error}</p>}
          </div>
        </div>
      );
  }
  
  // 游戏主视图 (V0.2 核心)
  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
        <h1 className="text-4xl font-bold mb-8 text-yellow-500">权谋决战</h1>
        {roomState?.round_state === 'LOBBY' ? renderLobby() : renderGame()}
        {error && <p className="text-red-500 mt-4">{error}</p>}
    </div>
  );
}