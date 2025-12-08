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
    round_state: string; // 例如: "LOBBY", "NIGHT 1", "DAY 1"
}

export default function Home() {
  // --- 状态管理 ---
  const [name, setName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [isInRoom, setIsInRoom] = useState(false);
  const [players, setPlayers] = useState<Player[]>([]);
  const [roomState, setRoomState] = useState<RoomState | null>(null);
  const [error, setError] = useState('');

  // V0.3 新增状态: 行动相关
  const [selectedTargetId, setSelectedTargetId] = useState<string>(''); // 选中的目标ID
  const [hasActed, setHasActed] = useState(false); // 本回合是否已行动
  const [actionLoading, setActionLoading] = useState(false);

  // --- 辅助函数 ---
  const getMyPlayer = () => players.find(p => p.name === name);
  const getMyRole = () => getMyPlayer()?.role;
  
  // 根据角色获取对应的技能代号 (Action Type)
  const getActionType = (role: string) => {
      switch (role) {
          case '技能观测者': return 'check';
          case '利他守护者': return 'protect';
          case '沉默制裁者': return 'silence';
          case '投票阻断者': return 'block_vote';
          // 如果有杀手角色，这里加 case '刺客': return 'kill';
          default: return null; // 无技能角色
      }
  };

  // --- 核心功能: 提交技能行动 ---
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
                  roundNumber: 1 // V0.4我们会动态获取当前回合数
              })
          });
          
          if (!res.ok) throw new Error('提交失败');
          
          setHasActed(true); // 锁定按钮
          setError(''); // 清空错误
      } catch (err) {
          setError('行动提交出错，请重试');
      } finally {
          setActionLoading(false);
      }
  };

  // --- 原有逻辑保持不变 ---
  const handleStartGame = async () => {
      setError('');
      if (players.length < 2) return setError('人数不足 2 人'); // 保持测试模式
      try {
          await fetch('/api/start-game', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ roomCode }),
          });
      } catch (err: any) { setError(err.message); }
  };

  // ... (Create/Join/Fetch 逻辑与 V0.2 相同，为节省篇幅省略，逻辑不变)
  // 实际上这里你需要把 V0.2 的 createRoom, joinRoom, fetchPlayers 等完整逻辑保留
  // 为了确保你能直接运行，下面是完整的精简版 create/join 逻辑:
  
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
    }).subscribe();
    const ch2 = supabase.channel('players').on('postgres_changes', { event: '*', schema: 'public', table: 'players', filter: `room_code=eq.${roomCode}`}, () => fetchPlayers(roomCode)).subscribe();
    return () => { supabase.removeChannel(ch1); supabase.removeChannel(ch2); };
  }, [isInRoom, roomCode]);

  // --- 视图渲染 ---

  const renderGame = () => {
    const myRole = getMyRole();
    const isNight = roomState?.round_state.startsWith('NIGHT');
    const actionType = myRole ? getActionType(myRole) : null;
    
    // 过滤出活着的人作为目标 (排除自己，除非技能允许对自己用，这里暂时简化为排除自己)
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

            {/* --- V0.3 核心: 技能操作区域 --- */}
            {isNight && actionType ? (
                <div className="bg-gray-900 p-4 rounded-lg border border-gray-600">
                    <h3 className="text-lg font-bold text-purple-400 mb-3">技能发动</h3>
                    
                    {hasActed ? (
                        <div className="text-green-400 font-bold py-4">
                            ✅ 技能已提交，等待天亮...
                        </div>
                    ) : (
                        <div className="space-y-3">
                            <p className="text-sm text-gray-400">选择目标进行: <span className="text-white font-bold">{actionType.toUpperCase()}</span></p>
                            
                            {/* 目标选择下拉框 */}
                            <select 
                                className="w-full p-3 rounded bg-gray-800 text-white border border-gray-600 focus:border-blue-500"
                                value={selectedTargetId}
                                onChange={(e) => setSelectedTargetId(e.target.value)}
                            >
                                <option value="">-- 选择目标 --</option>
                                {availableTargets.map(p => (
                                    <option key={p.id} value={p.id}>{p.name}</option>
                                ))}
                            </select>

                            {/* 提交按钮 */}
                            <button 
                                onClick={handleSubmitAction}
                                disabled={actionLoading}
                                className={`w-full p-3 rounded font-bold transition ${
                                    actionLoading ? 'bg-gray-600' : 'bg-purple-600 hover:bg-purple-700'
                                }`}
                            >
                                {actionLoading ? '提交中...' : '确认发动'}
                            </button>
                        </div>
                    )}
                </div>
            ) : (
                // 如果是平民或无技能角色
                isNight && (
                    <div className="text-gray-500 italic p-4">
                        你今晚没有可用的主动技能，请耐心等待。
                    </div>
                )
            )}
        </div>
    );
  };

  // --- 登录/大厅视图 (保持不变) ---
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