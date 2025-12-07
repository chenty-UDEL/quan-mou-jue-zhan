'use client'; // 这一行非常重要，必须放在第一行！

import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';

export default function Home() {
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<any[]>([]); // 允许任何类型的数组
  const [error, setError] = useState('');

  // 1. 创建房间
  const createRoom = async () => {
    if (!name) return setError('请输入名字');
    const code = Math.floor(1000 + Math.random() * 9000).toString();
    
    const { error: roomErr } = await supabase.from('rooms').insert([{ code }]);
    if (roomErr) return setError(roomErr.message);

    joinGameLogic(code, true);
  };

  // 2. 加入房间
  const joinRoom = async () => {
    if (!name || !roomCode) return setError('请输入名字和房间号');
    
    const { data } = await supabase.from('rooms').select().eq('code', roomCode);
    if (!data || data.length === 0) return setError('房间不存在');
    
    joinGameLogic(roomCode, false);
  };

  // 加入逻辑
  const joinGameLogic = async (code: string, isHost: boolean) => {
    // 检查是否重名
    const { data: existing } = await supabase.from('players').select().eq('room_code', code).eq('name', name);
    if (existing && existing.length > 0) return setError('名字已存在');
    
    const { error } = await supabase.from('players').insert([
      { room_code: code, name: name, is_host: isHost }
    ]);
    if (error) return setError(error.message);

    setRoomCode(code);
    setIsInRoom(true);
    fetchPlayers(code);
  };

  // 获取玩家
  const fetchPlayers = async (code: string) => {
    const { data } = await supabase.from('players').select().eq('room_code', code);
    if (data) setPlayers(data);
  };

  // 实时监听
  useEffect(() => {
    if (!isInRoom) return;

    const channel = supabase.channel('room-updates')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}` }, () => {
        fetchPlayers(roomCode); 
      })
      .subscribe();

    return () => { supabase.removeChannel(channel); };
  }, [isInRoom, roomCode]);

  return (
    <div className="min-h-screen bg-gray-900 text-white flex flex-col items-center justify-center p-4">
      <h1 className="text-4xl font-bold mb-8 text-yellow-500">权谋决战</h1>
      
      {!isInRoom ? (
        <div className="bg-gray-800 p-8 rounded-lg w-full max-w-md space-y-4">
          <input 
            className="w-full p-3 rounded bg-gray-700 text-white" 
            placeholder="你的名字" 
            value={name} 
            onChange={(e) => setName(e.target.value)} 
          />
          <button onClick={createRoom} className="w-full bg-blue-600 p-3 rounded font-bold">创建房间</button>
          <div className="flex gap-2">
            <input 
              className="flex-1 p-3 rounded bg-gray-700 text-white" 
              placeholder="房间号" 
              value={roomCode} 
              onChange={(e) => setRoomCode(e.target.value)} 
            />
            <button onClick={joinRoom} className="bg-green-600 p-3 rounded font-bold">加入</button>
          </div>
          {error && <p className="text-red-500">{error}</p>}
        </div>
      ) : (
        <div className="w-full max-w-md text-center">
          <p className="text-gray-400">房间号</p>
          <p className="text-5xl font-mono font-bold text-blue-400 mb-6">{roomCode}</p>
          
          <h2 className="text-xl mb-4">玩家列表 ({players.length})</h2>
          <div className="grid grid-cols-2 gap-3">
            {players.map((p) => (
              <div key={p.id} className="bg-gray-700 p-3 rounded flex items-center gap-2">
                <div className={`w-3 h-3 rounded-full ${p.is_alive ? 'bg-green-500' : 'bg-red-500'}`}></div>
                <span>{p.name} {p.is_host && '👑'}</span>
              </div>
            ))}
          </div>
          
          <div className="mt-8 text-gray-500">等待开始...</div>
        </div>
      )}
    </div>
  );
}